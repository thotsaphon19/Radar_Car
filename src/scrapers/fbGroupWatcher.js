/**
 * fbGroupWatcher.js — ดึงโพสต์จาก Facebook Group ด้วย Puppeteer + cookies เดียวกับ Marketplace
 * (ทดแทน Apify สำหรับ Group เพื่อไม่ให้เปลืองเครดิต — ยืนยันแล้วว่า Marketplace ใช้วิธีนี้ได้ผลจริง
 * แถมได้รูปจริงด้วย ในขณะที่ Apify Group mode ไม่มีข้อมูลรูปให้เลยตามเอกสารทางการของ actor)
 *
 * ใช้ browser + page เดียว หมุนเวียนไปทีละกลุ่ม (ไม่เปิดหลายแท็บพร้อมกัน ประหยัด RAM)
 * อ่านรายชื่อกลุ่มจาก settingsStore (การตั้งค่าที่บันทึกไว้ในหน้า settings.html) ทุกรอบ
 * เผื่อมีการเพิ่ม/ลบกลุ่มระหว่างรัน ไม่ต้อง restart
 *
 * ต้องมี fb-cookies.json ไฟล์เดียวกับที่ใช้กับ Marketplace watcher (ดู DEPLOY.md วิธี export)
 */

const fs = require('fs');
const path = require('path');
const { sanitizeCookies } = require('./cookieUtils');
const { EventEmitter } = require('events');
require('dotenv').config({ path: '.env.local' });
const { getSettings } = require('../settingsStore');

// 🔗 ใช้ Chrome instance เดียวกับ Facebook Marketplace watcher (คนละ tab แต่ browser process
// เดียวกัน) แทนที่จะเปิด Chrome แยกคนละตัวเต็มๆ — ลด RAM ลงเยอะมาก สำคัญบน Render free tier
// (512MB) ที่เจอปัญหา OOM จริงตอนเปิด watcher ทั้ง Marketplace และ Group พร้อมกัน
const { getSharedBrowser, releaseSharedBrowser, optimizePage } = require('./sharedBrowser');

const COOKIES_PATH = process.env.FB_COOKIES_PATH || path.join(__dirname, '../../fb-cookies.json');
const GROUP_SCAN_DELAY_MS = Number(process.env.FB_GROUP_SCAN_DELAY_MS || 8000);
const CYCLE_PAUSE_MS = Number(process.env.FB_GROUP_CYCLE_PAUSE_MS || 60000);

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    return sanitizeCookies(raw);
  } catch (e) {
    return null;
  }
}

function parsePosts(rawList, groupLabel) {
  return rawList
    .map(({ href, text, image }) => {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (!href || lines.length === 0) return null;
      const priceLine = lines.find(l => /[\d,]+\s*(บาท|฿)/i.test(l));
      const titleLine = [...lines].sort((a, b) => b.length - a.length)[0] || lines[0];
      return {
        source: 'facebook_group',
        title: titleLine.trim().slice(0, 150),
        price: priceLine ? (priceLine.match(/[\d,]+/) || [null])[0]?.replace(/,/g, '') : null,
        url: href.split('?')[0],
        image: image || null,
        groupLabel,
        scrapedAt: new Date().toISOString(),
      };
    })
    .filter(p => p && p.title && p.title.length >= 5 && p.url);
}

class FbGroupWatcher extends EventEmitter {
  constructor() {
    super();
    this.seen = new Set();
    this.browser = null;
    this.page = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;
    const cookies = loadCookies();
    this.isGuestMode = !cookies;
    if (this.isGuestMode) {
      this.emit('status', {
        msg: 'ไม่พบ cookies — สแกนแบบ guest (ไม่ login) แทน กลุ่มสาธารณะบางกลุ่มอาจดูได้โดยไม่ต้อง login แต่ไม่การันตีทุกกลุ่ม',
        ts: new Date().toISOString(),
      });
    }
    this.running = true;

    this.browser = await getSharedBrowser();
    this.page = await this.browser.newPage();
    await optimizePage(this.page, ['image', 'media', 'font', 'stylesheet']);
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );
    await this.page.setViewport({ width: 1366, height: 900 });
    if (cookies) await this.page.setCookie(...cookies);

    this.emit('status', { msg: 'Facebook Group watcher เริ่มทำงานแล้ว', ts: new Date().toISOString() });
    this._loop();
  }

  async _loop() {
    while (this.running) {
      const settings = getSettings();
      const groups = (settings.facebookGroups || []).filter(g => g.enabled);

      if (groups.length === 0) {
        this.emit('status', { msg: 'ยังไม่มีกลุ่มที่ตั้งค่าไว้ (เพิ่มได้ในหน้า settings.html) — รอ 60 วิแล้วเช็คใหม่', ts: new Date().toISOString() });
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }

      for (const g of groups) {
        if (!this.running) break;
        try {
          await this._scanGroup(g);
        } catch (err) {
          this.emit('error', new Error(`[${g.label}] ${err.message}`));
        }
        await new Promise(r => setTimeout(r, GROUP_SCAN_DELAY_MS));
      }

      if (this.running) await new Promise(r => setTimeout(r, CYCLE_PAUSE_MS));
    }
  }

  async _scanGroup(group) {
    if (!this.page || this.page.isClosed()) return;

    await this.page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForSelector('a[href*="/permalink/"], a[href*="/posts/"]', { timeout: 12000 }).catch(() => {});

    const isLoginWall = (await this.page.$('form[data-testid="royal_login_form"]')) !== null;
    if (isLoginWall && !this.isGuestMode) {
      this.emit('error', new Error('Session หมดอายุหรือ cookies ใช้ไม่ได้ — ต้อง export cookies ใหม่'));
      return;
    } else if (isLoginWall && this.isGuestMode) {
      this.emit('status', { msg: `[${group.label}] เจอ login wall แบบ guest — กลุ่มนี้ดูไม่ได้โดยไม่ login`, ts: new Date().toISOString() });
      return;
    }

    const raw = await this.page.evaluate(() => {
      const cards = document.querySelectorAll('a[href*="/permalink/"], a[href*="/posts/"]');
      const seenHref = new Set();
      const out = [];
      cards.forEach(card => {
        const href = card.getAttribute('href');
        if (!href || seenHref.has(href)) return;
        seenHref.add(href);
        const container = card.closest('div[role="article"]') || card.closest('div') || card;
        out.push({
          href,
          text: container.innerText || card.innerText || '',
          image: container.querySelector('img')?.src || null,
        });
      });
      return out;
    });

    const posts = parsePosts(raw, group.label);
    const fresh = posts.filter(p => !this.seen.has(p.url));
    fresh.forEach(p => {
      this.seen.add(p.url);
      this.emit('listing', p);
    });

    if (fresh.length > 0) {
      this.emit('status', { msg: `[${group.label}] พบใหม่ ${fresh.length} รายการ`, ts: new Date().toISOString() });
    }
  }

  async stop() {
    this.running = false;
    if (this.page) await this.page.close().catch(() => {});
    if (this.browser) await releaseSharedBrowser();
    this.browser = null;
    this.page = null;
  }
}

module.exports = { FbGroupWatcher };
