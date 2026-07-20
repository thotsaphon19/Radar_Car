/**
 * httpFetch.js — ตัวช่วยกลางสำหรับดึงหน้าเว็บแบบ axios+cheerio (ไม่ต้อง login)
 * ใช้ร่วมกันทุกเว็บ (One2Car, Kaidee, และเว็บอื่นๆ ที่จะเพิ่มในอนาคต) เพื่อ:
 *   1. ส่ง header ครบชุดเหมือนเบราว์เซอร์จริง ลดโอกาสโดน bot-detection/WAF บล็อก
 *   2. วินิจฉัยอัตโนมัติเวลา error ว่าโดน Cloudflare หรือเปล่า จะได้รู้ว่าต้องแก้ทางไหนต่อ
 *      (ถ้าใช่ = header อย่างเดียวไม่พอ ต้องใช้ headless browser แทน — ดู puppeteerFetch.js)
 *   3. ลองซ้ำอัตโนมัติ (retry) ก่อนจะยอมแพ้ กัน error ชั่วคราว (timeout/network hiccup) ทำให้
 *      รอบดึงข้อมูลทั้งรอบพังไปเฉยๆ ทั้งที่ลองใหม่อีกทีก็น่าจะผ่าน
 *
 * แก้/ปรับ header ที่ไฟล์นี้ไฟล์เดียว มีผลกับทุกเว็บที่ดึงผ่าน axios ทันที
 *
 * ⚠️ ไม่มีวิธีไหนรับประกันดึงสำเร็จ 100% ได้จริงถ้าฝั่งเว็บเปลี่ยนระบบป้องกันบอท (Cloudflare/WAF
 * อัปเดตอยู่เรื่อยๆ) — ที่ทำได้คือลดโอกาสโดนบล็อกให้ต่ำที่สุดเท่าที่จะทำได้ (header สมจริง + retry +
 * fallback ไป headless browser เมื่อ header อย่างเดียวไม่พอ) แล้วให้เห็น error ชัดเจนเวลาที่ยังพลาดอยู่
 * เพื่อจะได้แก้ไขต่อได้ทัน ไม่ใช่ดึงมาแบบเงียบๆ ได้ข้อมูลผิด
 */

const axios = require('axios');

// สุ่ม User-Agent จากรายการเบราว์เซอร์จริงที่พบบ่อย — ลด fingerprint ซ้ำเดิมทุกครั้งที่ยิง request
// (เว็บบางเจ้าจับรูปแบบ "UA เดิมยิงถี่ๆ" เป็นสัญญาณบอทได้ง่ายกว่า UA ที่หลากหลาย)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function browserHeaders(referer) {
  return {
    'User-Agent': randomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    ...(referer ? { Referer: referer } : {}),
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
  };
}

function isCloudflareBlock(e) {
  const body = String(e.response?.data || '').slice(0, 500);
  return (
    /cloudflare|cf-mitigated|Just a moment|Attention Required|challenge-platform/i.test(body) ||
    e.response?.headers?.server === 'cloudflare' ||
    e.response?.status === 403
  );
}

/**
 * ดึง HTML ของหน้าเว็บ พร้อม header แบบเบราว์เซอร์จริงและ diagnostic เวลา error (ลองครั้งเดียว
 * ไม่ retry — ใช้ fetchHtmlWithRetry() แทนถ้าต้องการ retry อัตโนมัติ)
 * @param {string} url
 * @param {object} opts - { referer, timeout, siteName }
 */
async function fetchHtml(url, opts = {}) {
  const { referer, timeout = 15000, siteName = url } = opts;
  try {
    const res = await axios.get(url, { headers: browserHeaders(referer), timeout });
    return res.data;
  } catch (e) {
    const isCloudflare = isCloudflareBlock(e);
    const hint = isCloudflare
      ? ' (ดูเหมือนโดน Cloudflare bot-protection บล็อก — header อย่างเดียวอาจไม่พอ อาจต้องใช้ headless browser แทน)'
      : '';
    const err = new Error(`ดึง ${siteName} ไม่สำเร็จ: ${e.message}${hint}`);
    err.isCloudflareBlock = isCloudflare;
    throw err;
  }
}

/**
 * เหมือน fetchHtml() แต่ลองซ้ำอัตโนมัติก่อนยอมแพ้ (เผื่อ timeout/network hiccup ชั่วคราว) —
 * ไม่ retry ถ้าเจอ Cloudflare block ชัดเจน เพราะยิงซ้ำด้วย header เดิมก็มักไม่ผ่านเหมือนเดิม
 * (ปล่อยให้ผู้เรียกตัดสินใจ fallback ไป headless browser แทนดีกว่าเสียเวลา retry เปล่าๆ)
 * @param {string} url
 * @param {object} opts - { referer, timeout, siteName, attempts, retryDelayMs }
 */
async function fetchHtmlWithRetry(url, opts = {}) {
  const { attempts = 2, retryDelayMs = 2000 } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchHtml(url, opts);
    } catch (e) {
      lastErr = e;
      if (e.isCloudflareBlock) break; // ไม่ retry ถ้าโดนบล็อกชัดเจน ให้ผู้เรียก fallback แทน
      if (i < attempts - 1) {
        console.log(`⚠️ ${opts.siteName || url} ดึงไม่สำเร็จ (ครั้งที่ ${i + 1}/${attempts}): ${e.message} — ลองใหม่ใน ${retryDelayMs}ms`);
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }
  throw lastErr;
}

module.exports = { fetchHtml, fetchHtmlWithRetry, browserHeaders, isCloudflareBlock, randomUserAgent };
