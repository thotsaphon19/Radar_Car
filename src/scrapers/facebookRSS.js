/**
 * facebookRSS.js
 * ดึงประกาศรถยนต์มือสองจาก Facebook Group ผ่าน RSS feed
 *
 * ติดตั้งก่อนใช้งาน:
 *   npm install rss-parser
 *
 * Facebook ไม่มี RSS ให้ในตัว วิธีที่ใช้กันทั่วไปคือรัน RSS-Bridge
 * (โอเพนซอร์ส self-hosted): https://github.com/RSS-Bridge/rss-bridge
 * แล้วสร้างลิงก์ฟีดสำหรับแต่ละกลุ่ม เช่น
 *   https://your-rss-bridge.example.com/?action=display&bridge=FacebookBridge&context=Group&u=GROUP_ID&format=Atom
 *
 * ตั้งค่าใน .env.local (คั่นหลายกลุ่มด้วย comma):
 *   FB_GROUP_RSS_URLS=https://bridge.example.com/?...group1,https://bridge.example.com/?...group2
 *
 * ⚠️ RSS-Bridge เองก็ scrape หน้า Facebook อยู่ดี จึงมีความเสี่ยงแบบเดียวกับ
 *    Marketplace scraper (ขัด ToS, ฟีดอาจล่มถ้า Facebook เปลี่ยนโครงหน้า)
 */

require('dotenv').config({ path: '.env.local' });

let Parser;
try {
  Parser = require('rss-parser');
} catch (e) {
  throw new Error('ต้องติดตั้ง rss-parser ก่อน: npm install rss-parser');
}

const parser = new Parser({ timeout: 15000 });

const FEED_URLS = (process.env.FB_GROUP_RSS_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function extractPrice(text = '') {
  const m = text.match(/([\d,]{4,})\s*(บาท|฿)/);
  return m ? m[1].replace(/,/g, '') : null;
}

async function scrapeOneFeed(url) {
  const feed = await parser.parseURL(url);
  return (feed.items || [])
    .map(item => ({
      source: 'facebook_group',
      title: (item.title || '').trim(),
      price: extractPrice(item.contentSnippet || item.content || item.title || ''),
      url: item.link,
      image: item['media:content']?.$?.url || null,
      scrapedAt: new Date().toISOString(),
    }))
    .filter(l => l.title && l.url);
}

async function scrapeFacebookRSS() {
  if (FEED_URLS.length === 0) {
    console.log('⚠️ ยังไม่ได้ตั้งค่า FB_GROUP_RSS_URLS ใน .env.local — ข้าม RSS');
    return [];
  }

  const results = await Promise.allSettled(FEED_URLS.map(scrapeOneFeed));
  const all = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      all.push(...r.value);
    } else {
      console.log(`❌ RSS feed ล้มเหลว (${FEED_URLS[i]}): ${r.reason?.message}`);
    }
  });
  return all;
}

module.exports = { scrapeFacebookRSS };
