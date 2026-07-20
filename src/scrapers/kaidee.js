/**
 * kaidee.js — ดึงประกาศรถมือสองเข้าใหม่จาก Kaidee Auto (rod.kaidee.com)
 * ไม่ต้อง login, หน้าเป็น server-rendered ตามปกติ → ใช้ axios+cheerio เป็นทางหลัก (เร็ว/เบาที่สุด)
 *
 * 🛡️ กันโดนบล็อก 2 ชั้น:
 *   1. axios+cheerio ผ่าน httpFetch.js (header เหมือนเบราว์เซอร์จริง + สุ่ม User-Agent + retry
 *      อัตโนมัติถ้า error ชั่วคราว)
 *   2. ถ้าเจอ Cloudflare/WAF บล็อกชัดเจน (axios ได้ error 403/หน้า challenge) → fallback ไปเปิดจริง
 *      ด้วย headless browser (puppeteerFetch.js) แทนอัตโนมัติ แล้ว parse HTML ที่ได้ด้วย cheerio
 *      เหมือนเดิม (logic แกะข้อมูลใช้ร่วมกันได้ทั้ง 2 ทาง ไม่ต้องเขียนซ้ำ)
 *
 * ติดตั้งก่อนใช้งาน: npm install axios cheerio puppeteer-extra puppeteer-extra-plugin-stealth puppeteer
 *
 * ⚠️ ไม่มีวิธีไหนรับประกันดึงสำเร็จ 100% ถ้า Kaidee เปลี่ยนระบบป้องกันบอทหรือเปลี่ยนโครงสร้างหน้าเว็บ
 * — ถ้าเจอ 0 รายการติดกันหลายรอบทั้งที่ปกติควรมี ให้เช็ค log ว่าโดนบล็อกหรือ selector ไม่ตรงแล้ว
 */

const cheerio = require('cheerio');
require('dotenv').config({ path: '.env.local' });
const { fetchHtmlWithRetry } = require('./httpFetch');

// หน้า "รถเข้าใหม่วันนี้" ของ Kaidee Auto — เรียงรถที่โพสต์ใหม่สุดไว้บนสุดอยู่แล้ว
const SEARCH_URL = process.env.KAIDEE_URL || 'https://rod.kaidee.com/used-cars/newarrival';

// เช็ค img หลายแบบเพราะเว็บใช้ lazy-load หลายวิธี — src จริงมักอยู่ใน data-src/data-lazy-src
// ไม่ใช่ src ตรงๆ (ซึ่งมักเป็นภาพ placeholder ขนาด 1x1 แบบ base64 ระหว่างรอโหลด)
function pickImageSrc($, imgEl) {
  if (!imgEl || imgEl.length === 0) return null;
  const candidates = [
    imgEl.attr('data-src'),
    imgEl.attr('data-lazy-src'),
    imgEl.attr('data-original'),
    imgEl.attr('data-lazy'),
    imgEl.attr('src'),
  ];
  const srcset = imgEl.attr('srcset') || imgEl.attr('data-srcset');
  if (srcset) {
    // srcset เป็นรายการ "url ขนาด1, url ขนาด2, ..." คั่นด้วย comma — เอาตัวแรก (มักเป็นขนาดเล็กสุด
    // ก็ยังดีกว่าไม่มีรูปเลย) มาเป็นตัวเลือกสำรอง
    candidates.push(srcset.split(',')[0]?.trim().split(' ')[0]);
  }
  // เผื่อรูปอยู่ใน <picture><source srcset=...> แทน <img> ตรงๆ
  const picture = imgEl.closest('picture');
  if (picture.length) {
    const source = picture.find('source[srcset]').first();
    if (source.length) candidates.push(source.attr('srcset')?.split(',')[0]?.trim().split(' ')[0]);
  }
  return candidates.find(src => src && !src.startsWith('data:')) || null;
}

// แกะรายการประกาศจาก HTML (ใช้ได้ทั้ง HTML จาก axios ตรงๆ และ HTML ที่ render จาก headless browser)
function parseListings(html) {
  const $ = cheerio.load(html);
  const listings = [];
  const seenUrls = new Set();
  let missingImageCount = 0;

  // ลิงก์ประกาศของ Kaidee เป็นรูปแบบ /product-{id}
  $('a[href*="/product-"]').each((_, el) => {
    const link = $(el);
    const href = link.attr('href');
    if (!href || !/\/product-\d+/.test(href)) return;

    const url = href.startsWith('http') ? href : `https://rod.kaidee.com${href}`;
    if (seenUrls.has(url)) return;

    const text = link.text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    // รูปแบบข้อความจริงที่เจอ: "[HOT/PREMIUM]฿ [ราคา][ปี] [ยี่ห้อรุ่น][เลขไมล์] กม.[หมวดหมู่]..."
    // โดยราคากับปีมักติดกันไม่มีตัวคั่น เช่น "488,0002013" (ราคา 488,000 + ปี 2013 ติดกัน)
    //
    // ราคา: ใช้ \d{1,3}(?:,\d{3})* บังคับรูปแบบ comma-group ให้ถูกต้อง (สูงสุด 3 หลักต่อกลุ่ม)
    // ทำให้หยุดจับที่ท้ายราคาจริงพอดี ไม่ลามไปกินเลขปีที่ติดกันมาด้วย (เจอบั๊กนี้จริง ราคาขึ้นเป็น
    // หลักพันล้านเพราะเอาราคา+ปีมารวมเป็นตัวเลขเดียวกัน)
    const priceMatch = text.match(/฿\s*(\d{1,3}(?:,\d{3})*)/);
    const price = priceMatch ? priceMatch[1].replace(/,/g, '') : null;

    // ชื่อรถ: ตัดข้อความตั้งแต่ต้นถึงท้ายราคาที่จับได้ทิ้ง (ตัดแท็ก HOT/PREMIUM+฿+ราคา+ปีออกไปด้วย)
    // เหลือ "[ปี] [ยี่ห้อรุ่น]...[เลขไมล์] กม...." แล้วตัดท่อนตั้งแต่เลขไมล์+กม. ทิ้งอีกที จะเหลือ
    // แค่ปี+ยี่ห้อ+รุ่น สะอาดๆ — ถ้าวิธีนี้ได้ผลลัพธ์สั้นเกินไป (แปลว่ารูปแบบข้อความต่างจากที่คาด)
    // ค่อย fallback ไปใช้ข้อความก่อนหน้าเครื่องหมาย ฿ แบบเดิม
    let title = null;
    if (priceMatch) {
      const restStart = text.indexOf(priceMatch[0]) + priceMatch[0].length;
      const rest = text.slice(restStart);
      const candidate = rest.split(/[\d,]+\s*กม\./)[0].trim();
      if (candidate.length >= 5) title = candidate;
    }
    if (!title) {
      const before = text.split('฿')[0].replace(/^(PREMIUM|HOT)\s*/i, '').trim();
      title = before.length >= 5 ? before : text.slice(0, 60);
    }

    seenUrls.add(url);

    const card = link.closest('article, li, div').length ? link.closest('article, li, div') : link;
    let img = link.find('img').first();
    if (img.length === 0) img = card.find('img').first();

    const image = pickImageSrc($, img);
    if (!image) missingImageCount += 1;

    listings.push({
      source: 'kaidee',
      title,
      price,
      url,
      image,
      scrapedAt: new Date().toISOString(),
    });
  });

  if (listings.length > 0 && missingImageCount > 0) {
    console.log(`⚠️ [kaidee] ${missingImageCount}/${listings.length} รายการไม่มีรูป — เว็บอาจเปลี่ยนวิธี lazy-load รูป ลองเพิ่ม selector ใน pickImageSrc()`);
  }

  return listings;
}

async function scrapeKaidee() {
  try {
    const html = await fetchHtmlWithRetry(SEARCH_URL, {
      referer: 'https://rod.kaidee.com/',
      siteName: 'Kaidee',
    });
    return parseListings(html);
  } catch (e) {
    if (!e.isCloudflareBlock) throw e; // ไม่ใช่ปัญหาบล็อก (เช่น network ล่ม) ให้พังไปตามปกติ ไม่ fallback เปล่าๆ

    console.log('🔀 [kaidee] axios โดนบล็อก — สลับไปใช้ headless browser (puppeteerFetch) แทน');
    const { fetchRenderedHtml } = require('./puppeteerFetch');
    const html = await fetchRenderedHtml(SEARCH_URL, { waitSelector: 'a[href*="/product-"]' });
    return parseListings(html);
  }
}

module.exports = { scrapeKaidee };
