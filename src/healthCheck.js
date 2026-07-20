/**
 * healthCheck.js — เช็คสถานะการเชื่อมต่อของทุกบริการภายนอกแบบ "ทดสอบจริง" ไม่ใช่แค่เช็คว่ามี env var
 *
 * แต่ละฟังก์ชันคืนค่า:
 *   { ok: true,  message: "..." }  → เชื่อมต่อได้จริง
 *   { ok: false, message: "..." }  → ตั้งค่าไว้แต่เชื่อมต่อไม่ได้/token หมดอายุ/เงินหมด
 *   { ok: null,  message: "..." }  → ยังไม่ได้ตั้งค่าเลย (ไม่ใช่ error แค่ยังไม่ได้เปิดใช้ฟีเจอร์นี้)
 */

const axios = require('axios');
require('dotenv').config({ path: '.env.local' });
const { getJSON, setJSON } = require('./redisStore');
const googleSheets = require('./integrations/googleSheets');

async function checkRedis() {
  try {
    const key = 'car-radar:healthcheck';
    const payload = { ts: Date.now() };
    await setJSON(key, payload);
    const val = await getJSON(key, null);
    if (!val || val.ts !== payload.ts) throw new Error('เขียนได้แต่อ่านค่ากลับมาไม่ตรง (อาจมีปัญหา sync)');
    return { ok: true, message: 'เชื่อมต่อ Upstash Redis ปกติ (ทดสอบเขียน+อ่านจริง)' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function checkBrightData() {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) return { ok: null, message: 'ยังไม่ได้ตั้งค่า BRIGHTDATA_API_TOKEN' };
  try {
    // ⚠️ เดิมเช็คด้วย GET /datasets/v3/list ซึ่งที่จริงแล้ว "ไม่มี endpoint นี้อยู่จริง" (คืน 404
    // "Cannot GET /datasets/v3/list" มาตลอด ไม่เกี่ยวกับสถานะบัญชีเลย) — เป็น endpoint ที่เดาไว้แบบ
    // ไม่ได้ยืนยัน ตอนนี้เปลี่ยนมาใช้ POST /datasets/v3/scrape ตัวเดียวกับที่ scraper จริงเรียก (ยืนยัน
    // แล้วว่ามีจริงจาก curl ที่ทดสอบตรง) ยิงด้วย input ขั้นต่ำสุด (limit_per_input: 1) เพื่อให้เห็น error
    // จริงจากบัญชี (เช่น "Customer is not active") แทนที่จะเจอ 404 หลอกๆ
    const url = 'https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_lvt9iwuh6fbcwmx1a&include_errors=true';
    await axios.post(
      url,
      { input: [{ keyword: 'test', city: '', date_listed: '' }], limit_per_input: 1 },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    return { ok: true, message: 'Token ใช้งานได้ และบัญชี active (ทดสอบยิง scrape จริงสำเร็จ)' };
  } catch (e) {
    const status = e.response?.status;
    // ดึงข้อความ error จริงจาก response body ก่อนเสมอ (เช่น "Customer is not active") แทนที่จะ
    // โชว์แค่ "Request failed with status code 4xx" ซึ่งไม่บอกอะไรเลยว่าปัญหาจริงคืออะไร
    const bodyMsg = e.response?.data?.error || e.response?.data?.message || (typeof e.response?.data === 'string' ? e.response.data.slice(0, 200) : null);
    if (status === 401 || status === 403) {
      return { ok: false, message: `Token ไม่ถูกต้องหรือหมดอายุ${bodyMsg ? ` (${bodyMsg})` : ''} — ไปสร้าง API token ใหม่ที่ Bright Data > Settings > API Keys` };
    }
    if (bodyMsg && /not active|inactive|suspend/i.test(bodyMsg)) {
      return { ok: false, message: `บัญชี Bright Data ไม่ active (${bodyMsg}) — ไม่ใช่ปัญหาโค้ดฝั่งเรา token/endpoint ถูกต้องแล้ว ต้องติดต่อ Bright Data support โดยตรงเพื่อถามว่าทำไมบัญชียัง inactive` };
    }
    return { ok: false, message: bodyMsg ? `${bodyMsg} (HTTP ${status})` : e.message };
  }
}

async function checkApify() {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { ok: null, message: 'ยังไม่ได้ตั้งค่า APIFY_TOKEN' };
  try {
    const { data } = await axios.get(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`, { timeout: 10000 });
    const label = data?.data?.username || data?.data?.email || 'บัญชี Apify';

    let usageMsg = '';
    try {
      const limitsRes = await axios.get(`https://api.apify.com/v2/users/me/limits?token=${encodeURIComponent(token)}`, { timeout: 10000 });
      const current = limitsRes.data?.data?.current?.monthlyUsageUsd;
      const max = limitsRes.data?.data?.limits?.maxMonthlyUsageUsd;
      if (typeof current === 'number' && typeof max === 'number' && max > 0) {
        const pct = Math.round((current / max) * 100);
        usageMsg = ` — ใช้ไปแล้ว $${current.toFixed(2)} จาก $${max} (${pct}%)`;
        if (pct >= 90) usageMsg += ' ⚠️ ใกล้เต็มโควตา อาจหยุดทำงานเร็วๆ นี้';
      }
    } catch (e2) {
      // เอาแค่ยืนยัน token valid ก็พอถ้าดึงโควตาไม่ได้
    }
    return { ok: true, message: `Token ใช้งานได้ (${label})${usageMsg}` };
  } catch (e) {
    const status = e.response?.status;
    if (status === 401) return { ok: false, message: 'Token ไม่ถูกต้องหรือหมดอายุ — ต้องสร้าง token ใหม่ที่ Apify > Settings > Integrations' };
    return { ok: false, message: e.message };
  }
}

async function checkGoogleSheets() {
  return googleSheets.checkConnection();
}

async function checkLine() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: null, message: 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN' };
  try {
    const { data } = await axios.get('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return { ok: true, message: `เชื่อมต่อ LINE OK (${data.displayName || data.basicId || 'Official Account'})` };
  } catch (e) {
    const status = e.response?.status;
    if (status === 401) return { ok: false, message: 'Channel access token ไม่ถูกต้องหรือหมดอายุ — ไป Issue token ใหม่ที่ LINE Developers Console' };
    return { ok: false, message: e.message };
  }
}

async function checkWebsite(url, name) {
  if (!url) return { ok: null, message: `ยังไม่ได้ตั้งค่า URL ของ ${name}` };
  try {
    await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
    });
    return { ok: true, message: `เข้าถึง ${name} ได้ปกติ` };
  } catch (e) {
    const status = e.response?.status;
    // เช็คนี้ยิงด้วย axios ธรรมดา (ไม่ใช่ headless browser) เพื่อความเร็ว — ตัวดึงข้อมูลจริงของ
    // One2Car/Kaidee ใช้ Puppeteer+stealth (และ Kaidee มี fallback เป็น Puppeteer อัตโนมัติด้วย)
    // ซึ่งผ่าน Cloudflare ได้ดีกว่า axios มาก ดังนั้น 403 ที่นี่ไม่ได้แปลว่าตัวดึงข้อมูลจริงพังเสมอไป
    // — ดูสถานะดึงข้อมูลจริงที่การ์ด "สถานะการดึงข้อมูล" ด้านล่างของหน้านี้แทนถึงจะแม่นกว่า
    if (status === 403) {
      return { ok: false, message: `โดน ${name} บล็อก (403) ตอนเช็คด้วย axios ธรรมดา — ตัวดึงข้อมูลจริงใช้ headless browser ซึ่งอาจยังผ่านได้อยู่ ดูสถานะจริงที่การ์ด "สถานะการดึงข้อมูล" ด้านล่าง` };
    }
    return { ok: false, message: e.message };
  }
}

async function checkRenderBackend() {
  const url = process.env.RENDER_URL;
  if (!url) return { ok: null, message: 'ไม่ได้ตั้งค่า RENDER_URL (ปิดฟีเจอร์นี้ไว้ตั้งใจ)' };
  try {
    await axios.get(url, { timeout: 10000 });
    return { ok: true, message: 'เชื่อมต่อ backend เดิมได้ปกติ' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function runAllChecks() {
  const [redis, apify, brightdata, sheets, line, one2car, kaidee, renderBackend] = await Promise.all([
    checkRedis(),
    checkApify(),
    checkBrightData(),
    checkGoogleSheets(),
    checkLine(),
    checkWebsite(process.env.ONE2CAR_URL || 'https://www.one2car.com/en/cars-for-sale', 'One2Car'),
    checkWebsite(process.env.KAIDEE_URL || 'https://rod.kaidee.com/used-cars/newarrival', 'Kaidee'),
    checkRenderBackend(),
  ]);
  return { redis, apify, brightdata, googleSheets: sheets, line, one2car, kaidee, renderBackend, checkedAt: new Date().toISOString() };
}

module.exports = { checkRedis, checkApify, checkBrightData, checkGoogleSheets, checkLine, checkWebsite, checkRenderBackend, runAllChecks };
