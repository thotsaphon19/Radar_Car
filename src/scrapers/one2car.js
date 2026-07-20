/**
 * one2car.js — ดึงประกาศรถมือสองล่าสุดจาก One2Car ผ่าน headless browser (Puppeteer + stealth)
 *
 * ติดตั้งก่อนใช้งาน: npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer
 *
 * ⚠️ ใช้ page.evaluate() อ่านค่าจาก DOM ที่ render จริงในเบราว์เซอร์โดยตรง แทนการ serialize
 * เป็น HTML แล้วเอามา parse ซ้ำด้วย cheerio (แบบเดิม) — เพราะ DOM หลัง JS รันแล้วมักมี badge/ป้าย
 * (เช่น "Used", เลขไมล์) แทรกอยู่ใกล้ชื่อรถ ถ้า parse จาก text รวมทั้งการ์ดจะได้ชื่อรถผิดเพี้ยน
 * (เจอปัญหาจริง: ได้ title เป็น "21 Used" แทนที่จะเป็นชื่อรถ) การอ่านจาก DOM ตรงๆ ทำให้เลือก
 * เฉพาะ heading element ของชื่อรถได้แม่นกว่า
 *
 * 🛡️ กันโดนบล็อก:
 *   - สุ่ม User-Agent จากรายการเบราว์เซอร์จริงหลายตัว ไม่ใช้ตัวเดิมซ้ำทุกรอบ (ลด fingerprint)
 *   - ลองซ้ำอัตโนมัติ (retry) พร้อมเปิด browser ใหม่ทั้งตัวถ้ารอบแรกเจอ error/ไม่เจอรถเลยทั้งที่
 *     ควรมี (มักเกิดจาก Cloudflare challenge ที่รอไม่ทันหรือ session เดิมโดน flag แล้ว)
 *   - รอ Cloudflare challenge ผ่านอัตโนมัติก่อนอ่านข้อมูล
 *
 * 🖼️ รูปภาพ — ดึง 2 ชั้นเพื่อให้ได้รูปมาด้วยเสมอเท่าที่เป็นไปได้:
 *   1. จากการ์ดในหน้ารายการเลย (เร็วสุด ไม่มี request เพิ่ม) — เช็คทั้ง <img> lazy-load หลายแบบ,
 *      <picture><source srcset>, และ background-image ผ่าน CSS
 *   2. ถ้าการ์ดไม่มีรูปเลยจริงๆ (พบไม่บ่อย) → เข้าไปที่หน้ารายละเอียดของประกาศนั้นแล้วดึง meta tag
 *      "og:image" แทน (เกือบทุกเว็บใส่ไว้อยู่แล้วสำหรับตอนแชร์ลิงก์ลง social — เชื่อถือได้กว่าการเดา
 *      selector การ์ดเยอะ) เฉพาะคันที่ตรงรุ่นรถเป้าหมายเท่านั้น (กันเสียเวลากับคันที่จะถูกกรองทิ้งอยู่ดี)
 *
 * ⚠️ ไม่มีวิธีไหนรับประกันดึงสำเร็จ 100% ถ้า One2Car อัปเดตระบบป้องกันบอท (Cloudflare เปลี่ยนกฎ
 * อยู่เรื่อยๆ) — ที่ทำได้คือลดโอกาสโดนบล็อกให้ต่ำที่สุดด้วย retry + stealth แล้วรายงาน error ให้เห็น
 * ชัดเจนเวลายังพลาดอยู่ (เช็คได้ที่ log หรือหน้า health.html) จะได้แก้ต่อได้ทันทีแทนที่จะเงียบไปเฉยๆ
 */

require('dotenv').config({ path: '.env.local' });
const { matchesTargetModel } = require('../targetModels');
const { optimizePage, getSharedBrowser, releaseSharedBrowser } = require('./sharedBrowser');

const SEARCH_URL = process.env.ONE2CAR_URL
  || 'https://www.one2car.com/en/cars-for-sale?sort=modification_date_search.desc';
// ⚠️ ตอนนี้ใช้ Chrome instance เดียวกับ Facebook watcher แล้ว (ผ่าน sharedBrowser.js) — headless mode
// เป็นค่าเดียวกันทั้ง process (ตั้งได้ที่ตัวแปร FB_HEADLESS ใน sharedBrowser.js) เพราะ Puppeteer ตั้ง
// headless ได้แค่ตอน launch browser เท่านั้น ไม่ใช่รายหน้า/tab — ตัวแปร ONE2CAR_HEADLESS ด้านล่างนี้
// จึงไม่มีผลอีกต่อไป (เก็บไว้เผื่ออนาคตอยากแยก browser กลับคืน)
const MAX_ATTEMPTS = Number(process.env.ONE2CAR_MAX_ATTEMPTS || 2);
const IMAGE_BACKFILL_ENABLED = process.env.ONE2CAR_IMAGE_BACKFILL !== 'false';
const IMAGE_BACKFILL_MAX = Number(process.env.ONE2CAR_IMAGE_BACKFILL_MAX || 15);

// สุ่มจากรายการเบราว์เซอร์จริงที่พบบ่อย — ลด fingerprint ซ้ำเดิมทุกรอบที่เปิด browser ใหม่
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
];

async function scrapeOnce(attemptNum) {
  // 🔗 ใช้ Chrome instance เดียวกับ Facebook watcher (คนละ tab) แทนที่จะเปิด Chrome ใหม่ทั้งตัว
  // ทุกรอบที่สแกน (เดิมเปิด/ปิด browser เต็มๆ ทุก ๆ ONE2CAR_INTERVAL_MS ~20 วิ ซ้อนทับกับ Chrome ของ
  // Facebook watcher ที่เปิดค้างอยู่แล้ว กิน RAM สูงมากจนเป็นอีกสาเหตุ OOM/502 บน Render free tier)
  const browser = await getSharedBrowser();

  let page;
  try {
    page = await browser.newPage();
    await optimizePage(page); // ค่า default ไม่บล็อก stylesheet เพราะต้องใช้ computed background-image
    await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
    await page.setViewport({ width: 1366, height: 900 });

    // domcontentloaded แทน networkidle2 — เว็บสมัยใหม่มักมี background request ค้าง (chat widget,
    // analytics) ทำให้ networkidle2 ไม่ยอม resolve จน timeout ทั้งที่เนื้อหาจริงโหลดเสร็จแล้ว
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="/for-sale/"]', { timeout: 20000 }).catch(() => {
      console.log(`⚠️ [one2car] (ครั้งที่ ${attemptNum}) รอ selector รายการรถไม่เจอภายในเวลา — หน้าอาจโหลดไม่สมบูรณ์`);
    });

    // เช็คว่าติดหน้า Cloudflare challenge อยู่ไหม รอให้ผ่านอัตโนมัติ
    const title = await page.title();
    if (/just a moment|attention required/i.test(title)) {
      console.log(`⏳ [one2car] (ครั้งที่ ${attemptNum}) เจอหน้า Cloudflare challenge กำลังรอให้ผ่าน...`);
      await page.waitForFunction(
        () => !/just a moment|attention required/i.test(document.title),
        { timeout: 15000 }
      ).catch(() => {
        console.log(`⚠️ [one2car] (ครั้งที่ ${attemptNum}) รอ Cloudflare challenge ผ่านไม่ทันเวลา`);
      });
      await page.waitForSelector('a[href*="/for-sale/"]', { timeout: 15000 }).catch(() => {});
    }

    // อ่านข้อมูลจาก DOM ที่ render จริงในเบราว์เซอร์โดยตรง (แม่นกว่า parse ซ้ำจาก HTML string)
    const listings = await page.evaluate(() => {
      const results = [];
      const seenUrls = new Set();

      document.querySelectorAll('a[href*="/for-sale/"]').forEach(el => {
        const href = el.getAttribute('href');
        if (!href || !/\/for-sale\/[^/]+\/\d+/.test(href)) return;

        const url = href.startsWith('http') ? href : `https://www.one2car.com${href}`;
        if (seenUrls.has(url)) return;

        const card = el.closest('article, li') || el.parentElement || el;

        // หาชื่อรถจาก heading element โดยเฉพาะ กันหลุดไปเจอ badge อย่าง "Used"/เลขไมล์
        const headingEl = card.querySelector('h2, h3, h4');
        let carTitle = headingEl ? headingEl.textContent.replace(/\s+/g, ' ').trim() : '';
        if (!carTitle) {
          carTitle = (el.textContent || '').replace(/\s+/g, ' ').trim();
        }
        // กันกรณีได้ text ที่เป็นแค่ badge ล้วนๆ เช่น "21 Used" หรือตัวเลขเปล่าๆ ไม่ใช่ชื่อรถจริง
        if (!carTitle || /^\d+\s*(used|Used)?$/i.test(carTitle) || carTitle.length < 5) return;

        const cardText = card.textContent.replace(/\s+/g, ' ').trim();
        const priceMatch = cardText.match(/([\d,]{5,})\s*Baht/i) || cardText.match(/฿\s*([\d,]{4,})/);
        const price = priceMatch ? priceMatch[1].replace(/,/g, '') : null;

        // หารูป — เช็คทั้ง <img> ตรงๆ และ <picture><source srcset> ที่บางการ์ดใช้แทน เพื่อให้ได้รูป
        // มาด้วยเสมอเท่าที่ DOM มีจริง (ไม่ใช่แค่พึ่ง <img src> เพียวๆ ที่มักเป็น placeholder lazy-load)
        let image = null;
        const pickFromImg = (img) => {
          if (!img) return null;
          const candidates = [
            img.getAttribute('data-src'),
            img.getAttribute('data-lazy-src'),
            img.getAttribute('data-original'),
            img.currentSrc,
            img.src,
          ];
          return candidates.find(src => src && !/placeholder/i.test(src) && !src.startsWith('data:')) || null;
        };
        const img = card.querySelector('img');
        image = pickFromImg(img);
        if (!image) {
          const source = card.querySelector('picture source[srcset]');
          if (source) {
            const srcset = source.getAttribute('srcset') || '';
            image = srcset.split(',')[0]?.trim().split(' ')[0] || null;
          }
        }
        if (!image) {
          // บางการ์ดใช้ div background-image แทน <img>/<picture> ตรงๆ — เช็ค computed style ด้วย
          const bgCandidates = [card, ...card.querySelectorAll('*')].slice(0, 15);
          for (const elCandidate of bgCandidates) {
            const bg = window.getComputedStyle(elCandidate).backgroundImage;
            const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
            if (m && m[1] && !/placeholder/i.test(m[1])) { image = m[1]; break; }
          }
        }

        seenUrls.add(url);
        results.push({ url, title: carTitle, price, image });
      });

      return results;
    });

    const missingImageCount = listings.filter(l => !l.image).length;
    if (listings.length > 0 && missingImageCount > 0) {
      console.log(`⚠️ [one2car] ${missingImageCount}/${listings.length} รายการไม่มีรูปจากการ์ด — ${IMAGE_BACKFILL_ENABLED ? 'จะลองเข้าไปดึงจากหน้ารายละเอียดแทน' : 'ปิด backfill ไว้ (ONE2CAR_IMAGE_BACKFILL=false)'}`);
    }

    const mapped = listings.map(l => ({
      source: 'one2car',
      title: l.title,
      price: l.price,
      url: l.url,
      image: l.image,
      scrapedAt: new Date().toISOString(),
    }));

    if (IMAGE_BACKFILL_ENABLED) {
      await backfillMissingImages(browser, mapped);
    }

    return mapped;
  } finally {
    if (page) await page.close().catch(() => {});
    await releaseSharedBrowser();
  }
}

// เข้าไปที่หน้ารายละเอียดของประกาศที่การ์ดในหน้ารายการไม่มีรูปมาให้ แล้วดึง meta tag "og:image"
// แทน (เกือบทุกเว็บใส่ไว้อยู่แล้วสำหรับตอนแชร์ลิงก์ — เชื่อถือได้กว่าเดา selector การ์ดเยอะๆ)
// จำกัดเฉพาะคันที่ตรงรุ่นรถเป้าหมายเท่านั้น + จำกัดจำนวนสูงสุด กันใช้เวลานานเกินไปต่อรอบ
async function backfillMissingImages(browser, listings) {
  const targets = listings
    .filter(l => !l.image && matchesTargetModel(l.title))
    .slice(0, IMAGE_BACKFILL_MAX);
  if (targets.length === 0) return;

  console.log(`🖼️ [one2car] เข้าไปดึงรูปเพิ่มเติมจากหน้ารายละเอียด ${targets.length} คัน (การ์ดหน้ารายการไม่มีรูปมาให้)`);
  const page = await browser.newPage();
  await optimizePage(page, ['image', 'media', 'font', 'stylesheet']); // แค่อ่าน meta tag ไม่ต้องใช้ CSS เลย
  try {
    for (const l of targets) {
      try {
        await page.goto(l.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const ogImage = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null);
        if (ogImage) l.image = ogImage;
      } catch (e) {
        console.log(`⚠️ [one2car] ดึงรูปจากหน้ารายละเอียดไม่สำเร็จ (${l.url}): ${e.message}`);
      }
    }
  } finally {
    await page.close();
  }
}

async function scrapeOne2Car() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const listings = await scrapeOnce(attempt);
      if (listings.length === 0 && attempt < MAX_ATTEMPTS) {
        // ได้ 0 รายการทั้งที่หน้านี้ปกติมีรถเสมอ — น่าจะโดนบล็อก/challenge ไม่ผ่าน ลองเปิด browser
        // ใหม่ทั้งตัวอีกรอบ (session/fingerprint ใหม่) แทนที่จะยอมรับ 0 รายการเงียบๆ
        console.log(`⚠️ [one2car] (ครั้งที่ ${attempt}) ได้ 0 รายการ — เปิด browser ใหม่แล้วลองอีกครั้ง`);
        continue;
      }
      return listings;
    } catch (e) {
      lastErr = e;
      console.log(`⚠️ [one2car] (ครั้งที่ ${attempt}/${MAX_ATTEMPTS}) พลาด: ${e.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;
  return []; // ครบทุกครั้งแล้วยังได้ 0 รายการ (ไม่ error) — คืนค่าว่างแทนที่จะถือว่าล้มเหลว
}

module.exports = { scrapeOne2Car };
