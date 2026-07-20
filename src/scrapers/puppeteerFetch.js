/**
 * puppeteerFetch.js — ตัวช่วยกลาง "ดึง HTML ที่ render จริงแล้ว" ด้วย headless browser (Puppeteer +
 * stealth) สำหรับเว็บที่ header อย่างเดียว (axios+cheerio ผ่าน httpFetch.js) ไม่พอ เพราะโดน
 * Cloudflare/WAF บล็อก — ใช้เป็น "ทางสำรอง" เวลา axios โดนบล็อก แทนที่จะพังไปทั้งรอบ
 *
 * ใช้ร่วมกับ kaidee.js (axios ก่อน → fallback มาที่นี่ถ้าโดนบล็อก) และเขียนแยกจาก one2car.js
 * (ซึ่งมี logic ดึง/แกะข้อมูลเฉพาะของตัวเองอยู่แล้วเพราะซับซ้อนกว่านี้ต้องรอ selector เฉพาะจุด)
 *
 * 🔗 ใช้ Chrome instance เดียวกับ Facebook watcher/One2Car (คนละ tab) แทนที่จะเปิด Chrome ใหม่
 * ทั้งตัว — ลด RAM (สำคัญบน Render free tier 512MB ที่เจอ OOM จริงตอนมีหลาย Chrome process พร้อมกัน)
 */

require('dotenv').config({ path: '.env.local' });
const { optimizePage, getSharedBrowser, releaseSharedBrowser } = require('./sharedBrowser');

/**
 * เปิด tab ใหม่ในเบราว์เซอร์ที่ใช้ร่วมกัน ไปที่ url แล้วรอ Cloudflare challenge ผ่าน (ถ้ามี) แล้วคืน
 * HTML ที่ render จริงแล้วกลับมา (ใช้ต่อกับ cheerio.load() แบบเดียวกับที่ axios คืนมาได้เลย ไม่ต้อง
 * เปลี่ยน parse logic)
 * @param {string} url
 * @param {object} opts - { waitSelector, timeout }
 */
async function fetchRenderedHtml(url, opts = {}) {
  const { waitSelector, timeout = 45000 } = opts;

  const browser = await getSharedBrowser();
  let page;
  try {
    page = await browser.newPage();
    await optimizePage(page, ['image', 'media', 'font', 'stylesheet']); // parse ต่อด้วย cheerio จาก attribute เท่านั้น ไม่ต้องใช้ CSS
    await page.setViewport({ width: 1366, height: 900 });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 20000 }).catch(() => {
        console.log(`⚠️ [puppeteerFetch] รอ selector "${waitSelector}" ไม่เจอภายในเวลา — หน้าอาจโหลดไม่สมบูรณ์`);
      });
    }

    const title = await page.title();
    if (/just a moment|attention required|checking your browser/i.test(title)) {
      console.log('⏳ [puppeteerFetch] เจอหน้า Cloudflare challenge กำลังรอให้ผ่าน...');
      await page.waitForFunction(
        () => !/just a moment|attention required|checking your browser/i.test(document.title),
        { timeout: 15000 }
      ).catch(() => {
        console.log('⚠️ [puppeteerFetch] รอ Cloudflare challenge ผ่านไม่ทันเวลา — อาจต้องลองรอบถัดไป');
      });
      if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 15000 }).catch(() => {});
    }

    return await page.content();
  } finally {
    if (page) await page.close().catch(() => {});
    await releaseSharedBrowser();
  }
}

module.exports = { fetchRenderedHtml };
