/**
 * fbWatcher.js — เปิด browser ค้างไว้ตลอด แล้วสแกนหาประกาศใหม่ถี่ๆ (สำหรับ Facebook Marketplace)
 * (แทนที่การเปิด-ปิด browser ใหม่ทุกรอบ ซึ่งช้าและเสี่ยงโดนจับได้ง่ายกว่า)
 *
 * ใช้วิธีนี้แทน Apify สำหรับ Marketplace เพราะ actor บน Apify ที่ทดสอบไปหลายตัว/หลาย input
 * แล้วยังโดน Facebook ตอบกลับมาว่า "Empty or private data" อยู่ดี (โดน bot-protection บล็อกฝั่ง
 * actor เอง ไม่ใช่ปัญหาการตั้งค่าของเรา) — Puppeteer + stealth ที่ควบคุมเองมีโอกาสผ่านได้มากกว่า
 * เพราะเป็นเซสชันเบราว์เซอร์จริงที่ล็อกอินด้วยบัญชีจริง เหมือนที่ใช้กับ One2Car สำเร็จมาแล้ว
 *
 * แนวคิด:
 *  - เปิด Marketplace search page ครั้งเดียว แล้วปล่อยค้างไว้
 *  - ทุกๆ SCAN_INTERVAL วิ (ค่าเริ่มต้น 15 วิ) จะ scroll ขึ้นบนสุดแล้วอ่าน DOM
 *    เทียบกับรายการที่เคยเห็นแล้ว (Set of URLs) → เจอรายการใหม่ = emit ทันที
 *  - รีเฟรชหน้าทั้งหมดทุก RELOAD_INTERVAL_MS (ค่าเริ่มต้น 10 นาที) เพื่อความสด
 *    ของ session และกันหน้าค้าง ไม่ใช่ทุกรอบเหมือนเดิม
 *
 * ติดตั้งก่อนใช้งาน: npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer
 *
 * ⚠️ คำเตือนสำคัญ:
 *  - รองรับ 2 โหมด: "guest" (ไม่มี fb-cookies.json = ไม่ต้อง login เลย ไม่ต้องมีบัญชี Facebook)
 *    กับ "login" (มี cookies = ล็อกอินด้วยบัญชีจริง) — ลองโหมด guest ก่อนได้เลย ไม่ต้องมีบัญชี
 *    แต่ Facebook อาจบล็อกไม่ให้ดู Marketplace แบบไม่ login เลย (ต้องทดสอบดูจริง ผลไม่แน่นอน)
 *    ถ้า guest ใช้ไม่ได้จริง ต้องกลับไปตั้ง cookies บัญชีจริงตามที่อธิบายใน DEPLOY.md
 *  - ยิ่งสแกนถี่และเปิดหน้าค้างนาน ยิ่งมีโอกาสโดน Facebook ตรวจจับพฤติกรรมบอทได้
 *    (rate-limit / checkpoint / session ถูกตัด) ทดลองปรับ SCAN_INTERVAL ขึ้นถ้าเจอปัญหา
 *  - นี่คือ "ใกล้เคียงเรียลไทม์" (ดีเลย์ ~SCAN_INTERVAL วิ) ไม่ใช่ push แบบ instant จริง
 *    เพราะ Facebook ไม่มี API ให้บุคคลภายนอกสำหรับกรณีนี้
 */

const fs = require('fs');
const path = require('path');
const { sanitizeCookies } = require('./cookieUtils');
const { EventEmitter } = require('events');
require('dotenv').config({ path: '.env.local' });

// 🔗 ใช้ Chrome instance เดียวกับ Facebook Group watcher (คนละ tab แต่ browser process เดียวกัน)
// แทนที่จะเปิด Chrome แยกคนละตัวเต็มๆ — ลด RAM ลงเยอะมาก สำคัญบน Render free tier (512MB)
// ที่เจอปัญหา OOM จริงตอนเปิด watcher ทั้ง Marketplace และ Group พร้อมกัน
const { getSharedBrowser, releaseSharedBrowser, optimizePage } = require('./sharedBrowser');

const SEARCH_URL         = process.env.FB_SEARCH_URL || 'https://www.facebook.com/marketplace/107292532620574/search?query=%E0%B8%A3%E0%B8%96%E0%B8%A1%E0%B8%B7%E0%B8%AD%E0%B8%AA%E0%B8%AD%E0%B8%87';
const COOKIES_PATH       = process.env.FB_COOKIES_PATH || path.join(__dirname, '../../fb-cookies.json');
// HEADLESS: ย้ายไปคุมที่ sharedBrowser.js แล้ว (browser instance เดียวกับ Group watcher) — ยังอ่าน
// env ตัวเดียวกัน (FB_HEADLESS) เหมือนเดิม แค่จุดที่ launch จริงย้ายไปรวมศูนย์ที่นั่น
const SCAN_INTERVAL_MS   = Number(process.env.FB_SCAN_INTERVAL_MS || 15000);   // ค่าเริ่มต้น 15 วิ
const RELOAD_INTERVAL_MS = Number(process.env.FB_RELOAD_INTERVAL_MS || 10 * 60 * 1000); // 10 นาที

// cookies ไม่บังคับอีกต่อไป — ถ้าไม่มีไฟล์ จะลองสแกนแบบ "guest" (ไม่ login) แทน
// Facebook Marketplace บางส่วนดูได้แบบไม่ต้อง login แต่ข้อมูลอาจได้น้อยกว่า/ไม่ครบเท่าตอน login
function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    return sanitizeCookies(raw);
  } catch (e) {
    console.log(`⚠️ อ่านไฟล์ cookies ที่ ${COOKIES_PATH} ไม่สำเร็จ (${e.message}) — จะสแกนแบบ guest แทน`);
    return null;
  }
}

function parseListings(rawList) {
  return rawList
    .map(({ href, text, image }) => {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (!href || lines.length === 0) return null;
      const priceLine = lines.find(l => /[\d,]+\s*(บาท|฿|\$)/i.test(l)) || lines[0];
      // ชื่อรถมักเป็นบรรทัดที่ยาวที่สุดที่ไม่ใช่ราคา (กันหลุดไปเจอ badge สั้นๆ เช่น "ใหม่")
      const candidateLines = lines.filter(l => l !== priceLine);
      const titleLine = candidateLines.sort((a, b) => b.length - a.length)[0] || lines[0];
      return {
        source: 'facebook_marketplace',
        title: titleLine.trim(),
        price: (priceLine.match(/[\d,]+/) || [null])[0]?.replace(/,/g, '') || null,
        url: href.startsWith('http') ? href.split('?')[0] : `https://www.facebook.com${href.split('?')[0]}`,
        image: image || null,
        scrapedAt: new Date().toISOString(),
      };
    })
    .filter(l => l && l.title && l.title.length >= 3 && l.url);
}

class FbWatcher extends EventEmitter {
  constructor() {
    super();
    this.seen = new Set();
    this.browser = null;
    this.page = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;

    this.browser = await getSharedBrowser();

    await this._openFreshPage();
    this._scheduleScan();
    this._scheduleReload();

    this.emit('status', { msg: 'watcher เริ่มทำงานแล้ว', ts: new Date().toISOString() });
  }

  async _openFreshPage() {
    if (this.page) {
      await this.page.close().catch(() => {});
    }
    const cookies = loadCookies();
    this.isGuestMode = !cookies;

    this.page = await this.browser.newPage();
    await optimizePage(this.page, ['image', 'media', 'font', 'stylesheet']);
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );
    await this.page.setViewport({ width: 1366, height: 900 });
    if (cookies) {
      await this.page.setCookie(...cookies);
    } else {
      this.emit('status', { msg: 'ไม่พบ cookies — สแกนแบบ guest (ไม่ login) แทน อาจได้ข้อมูลน้อยกว่าปกติ', ts: new Date().toISOString() });
    }
    await this.page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.page.waitForSelector('a[href*="/marketplace/item/"]', { timeout: 15000 }).catch(() => {
      this.emit('status', { msg: '⚠️ รอ selector รายการ Marketplace ไม่เจอ — หน้าอาจโหลดไม่สมบูรณ์หรือ session หมดอายุ', ts: new Date().toISOString() });
    });

    const isLoginWall = (await this.page.$('form[data-testid="royal_login_form"]')) !== null;
    if (isLoginWall && !this.isGuestMode) {
      this.emit('error', new Error('Session หมดอายุหรือ cookies ใช้ไม่ได้ — ต้อง export cookies ใหม่'));
    } else if (isLoginWall && this.isGuestMode) {
      this.emit('status', {
        msg: '⚠️ สแกนแบบ guest เจอหน้า login wall เต็มรูปแบบ — Facebook บล็อกไม่ให้ดู Marketplace แบบไม่ login เลย จำเป็นต้องใช้ cookies บัญชีจริงถึงจะดึงข้อมูลได้',
        ts: new Date().toISOString(),
      });
    } else if (!this.isGuestMode) {
      // มี cookies + ไม่เจอหน้า login wall = cookies ใช้ได้จริง login สำเร็จ (ไม่มี log ยืนยันแบบนี้
      // มาก่อนเลย มีแต่ log ฝั่ง error/guest — เพิ่มไว้ให้เห็นชัดว่า "ใช้ได้แล้วจริงๆ" ไม่ต้องเดา)
      this.emit('status', { msg: '✅ ใช้ cookies บัญชีจริง login สำเร็จ — ไม่เจอหน้า login wall', ts: new Date().toISOString() });
    }
  }

  _scheduleScan() {
    this._scanTimer = setInterval(() => this._scanOnce(), SCAN_INTERVAL_MS);
  }

  _scheduleReload() {
    this._reloadTimer = setInterval(() => {
      this._openFreshPage().catch(err => this.emit('error', err));
    }, RELOAD_INTERVAL_MS);
  }

  async _scanOnce() {
    if (!this.page || this.page.isClosed()) return;
    try {
      // scroll กลับขึ้นบนสุดเพื่อดูรายการล่าสุด (Marketplace เรียงใหม่สุดไว้บนสุด)
      await this.page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(r => setTimeout(r, 800));

      const raw = await this.page.evaluate(() => {
        const cards = document.querySelectorAll('a[href*="/marketplace/item/"]');
        return Array.from(cards).map(card => ({
          href: card.getAttribute('href'),
          text: card.innerText || '',
          image: card.querySelector('img')?.src || null,
        }));
      });

      const listings = parseListings(raw);
      const fresh = listings.filter(l => !this.seen.has(l.url));

      fresh.forEach(l => {
        this.seen.add(l.url);
        this.emit('listing', l); // ← ยิงออกทันทีทีละรายการ ไม่รอครบรอบ
      });

      if (fresh.length > 0) {
        this.emit('status', { msg: `พบใหม่ ${fresh.length} รายการ`, ts: new Date().toISOString() });
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  async stop() {
    this.running = false;
    clearInterval(this._scanTimer);
    clearInterval(this._reloadTimer);
    if (this.page) await this.page.close().catch(() => {});
    if (this.browser) await releaseSharedBrowser();
    this.browser = null;
    this.page = null;
  }
}

module.exports = { FbWatcher };

/**
 * fetchSingleListing(url) — ดึงรายละเอียดประกาศ Marketplace ทีละอันจากลิงก์ที่รู้อยู่แล้ว
 * (ให้พนักงานเจอรถที่สนใจใน Facebook เอง แล้วแปะลิงก์เข้าระบบ) ไม่ใช่การค้นหา จึงมีโอกาสผ่าน
 * bot-protection ของ Facebook ได้ดีกว่าการสแกนค้นหาทั้งหน้ามาก (เหมือนที่กลุ่ม Facebook ที่รู้ลิงก์
 * อยู่แล้วดึงได้เสถียร ในขณะที่ "ค้นหา" กลุ่มกลับโดนบล็อก — pattern เดียวกัน)
 */
async function fetchSingleListing(url) {
  const cookies = loadCookies();
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  await optimizePage(page, ['image', 'media', 'font', 'stylesheet']);
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 900 });
    if (cookies) await page.setCookie(...cookies);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500)); // เผื่อเวลาโหลดรูป/ราคาที่มาทีหลัง

    const data = await page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
      const ogImage = document.querySelector('meta[property="og:image"]')?.content;
      const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
      const priceMatch = ogDesc.match(/[\d,]+\s*(บาท|฿)/) || document.title.match(/[\d,]+\s*(บาท|฿)/);
      return { title: ogTitle || document.title, image: ogImage || null, priceText: priceMatch ? priceMatch[0] : null };
    });

    const price = data.priceText ? (data.priceText.match(/[\d,]+/) || [null])[0]?.replace(/,/g, '') : null;

    if (!data.title) throw new Error('ดึงข้อมูลจากลิงก์นี้ไม่ได้ — อาจเป็นลิงก์ที่ผิด, ประกาศถูกลบ, หรือโดน login wall กัน');

    return {
      source: 'facebook_marketplace',
      title: data.title,
      price,
      url,
      image: data.image,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    await page.close().catch(() => {});
    await releaseSharedBrowser();
  }
}

module.exports.fetchSingleListing = fetchSingleListing;
