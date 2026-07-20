/**
 * facebookMarketplace.js
 * ดึงประกาศรถยนต์มือสองจาก Facebook Marketplace ด้วย Puppeteer
 *
 * ติดตั้งก่อนใช้งาน:
 *   npm install puppeteer
 *
 * Facebook Marketplace ต้อง login ถึงจะเห็นผลค้นหาครบ ดังนั้นต้อง export
 * cookies จาก browser ที่ login ไว้แล้ว (ใช้ extension เช่น "Cookie-Editor")
 * แล้วเซฟเป็น JSON array มาตรฐาน Puppeteer ที่ ./fb-cookies.json
 *
 * ตั้งค่าใน .env.local:
 *   FB_SEARCH_URL=https://www.facebook.com/marketplace/107292532620574/search?query=รถมือสอง
 *   FB_COOKIES_PATH=./fb-cookies.json
 *   FB_HEADLESS=true          # ตั้งเป็น false เพื่อเปิดหน้าต่างดูตอน debug
 *
 * ⚠️ หมายเหตุสำคัญ:
 *  - การสแกน Facebook แบบอัตโนมัติขัดกับ Terms of Service ของ Facebook
 *    มีความเสี่ยงที่บัญชี/เซสชันจะถูกจำกัดการใช้งานหรือ flag เป็นบอท
 *  - selector ของหน้า Marketplace เปลี่ยนบ่อยมาก ถ้าอยู่ๆ ดึงข้อมูลได้ 0 รายการ
 *    ให้เปิด FB_HEADLESS=false แล้วดูว่าโดนเด้งไปหน้า login/checkpoint หรือ selector เปลี่ยนไป
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '.env.local' });

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  throw new Error('ต้องติดตั้ง puppeteer ก่อน: npm install puppeteer');
}

const SEARCH_URL    = process.env.FB_SEARCH_URL || 'https://www.facebook.com/marketplace/category/vehicles';
const COOKIES_PATH  = process.env.FB_COOKIES_PATH || path.join(__dirname, '../../fb-cookies.json');
const HEADLESS       = process.env.FB_HEADLESS !== 'false';
const NAV_TIMEOUT    = 30000;
const SCROLL_ROUNDS  = Number(process.env.FB_SCROLL_ROUNDS || 4);

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    throw new Error(
      `ไม่พบไฟล์ cookies ที่ ${COOKIES_PATH} — ต้อง export cookies จาก browser ที่ login Facebook แล้ว`
    );
  }
  return JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
}

async function autoScroll(page, rounds) {
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    // สุ่มเวลาหน่วงเล็กน้อยให้ดูเป็นพฤติกรรมคนจริงมากขึ้น
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
  }
}

async function scrapeMarketplace() {
  const cookies = loadCookies();
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 900 });
    await page.setCookie(...cookies);

    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });

    const isLoginWall = (await page.$('form[data-testid="royal_login_form"]')) !== null;
    if (isLoginWall) {
      throw new Error('Session หมดอายุหรือ cookies ใช้ไม่ได้ — ต้อง export cookies ใหม่');
    }

    await autoScroll(page, SCROLL_ROUNDS);

    const listings = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('a[href*="/marketplace/item/"]');
      cards.forEach(card => {
        const href = card.getAttribute('href');
        const text = card.innerText || '';
        const lines = text.split('\n').filter(Boolean);
        if (!href || lines.length === 0) return;

        const priceLine = lines.find(l => /[\d,]+\s*(บาท|฿|\$)/i.test(l)) || lines[0];
        const titleLine = lines.find(l => l !== priceLine) || lines[0];

        results.push({
          source: 'facebook_marketplace',
          title: titleLine.trim(),
          price: (priceLine.match(/[\d,]+/) || [null])[0]?.replace(/,/g, '') || null,
          url: href.startsWith('http') ? href.split('?')[0] : `https://www.facebook.com${href.split('?')[0]}`,
          image: card.querySelector('img')?.src || null,
          scrapedAt: new Date().toISOString(),
        });
      });
      return results;
    });

    return listings.filter(l => l.title && l.url);
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeMarketplace };
