/**
 * cookieUtils.js — ทำความสะอาด cookies ที่ export มาจาก extension (เช่น Cookie-Editor) ก่อนส่งเข้า
 * Puppeteer's page.setCookie() ให้ตรงกับ schema ที่ Chrome DevTools Protocol (CDP) ต้องการเป๊ะๆ
 *
 * ✅ ยืนยันจาก error จริงที่เจอ (ไม่ใช่การเดา):
 *   "Protocol error (Network.setCookies): Invalid parameters
 *    Failed to deserialize params.cookies.sameSite - BINDINGS: string value expected"
 *
 * สาเหตุ: extension export ค่า sameSite ออกมาเป็นอะไรที่ไม่ใช่ string ที่ CDP รู้จัก (เช่น null,
 * "unspecified", "no_restriction", หรือตัวพิมพ์เล็ก) — CDP ต้องการ "Strict" | "Lax" | "None"
 * (ตัวพิมพ์ใหญ่ขึ้นต้นเป๊ะๆ) เท่านั้น ถ้าผิดแม้แต่ cookie เดียวใน array จะทำให้ setCookie() **พังทั้งชุด**
 * (ไม่ใช่แค่ cookie ตัวนั้นที่มีปัญหา) — เจอปัญหานี้จริงทั้ง Marketplace watcher และ Group watcher
 *
 * นอกจากนี้ Cookie-Editor (และ extension อื่นๆ ที่ใช้ Chrome cookie API เดิม) export ชื่อ field
 * วันหมดอายุเป็น `expirationDate` (ไม่ใช่ `expires` ที่ Puppeteer ต้องการ) — แปลงให้ตรงกันด้วย
 */

const SAME_SITE_MAP = {
  strict: 'Strict',
  lax: 'Lax',
  none: 'None',
  norestriction: 'None', // "no_restriction" หลัง normalize ตัด _ ออก
};

function normalizeSameSite(value) {
  if (typeof value !== 'string') return undefined; // null/undefined/boolean ฯลฯ — ตัดทิ้งดีกว่าใส่ผิด
  const key = value.toLowerCase().replace(/[\s_-]/g, '');
  return SAME_SITE_MAP[key]; // undefined ถ้าไม่รู้จัก (เช่น "unspecified") — ตัดทิ้งเช่นกัน
}

/**
 * แปลง array cookies ดิบจากไฟล์ export ให้เป็นรูปแบบที่ Puppeteer/CDP ยอมรับแน่นอน — ตัด field ที่
 * เดาไม่ได้ว่าถูกต้องทิ้งไปเลยแทนที่จะส่งค่าที่อาจผิดเข้าไป (ปลอดภัยกว่า เพราะ error แค่ cookie เดียว
 * ทำให้ทั้งชุดพังได้ตามที่เจอมาจริง)
 */
function sanitizeCookies(rawCookies) {
  if (!Array.isArray(rawCookies)) return rawCookies;

  return rawCookies
    .map(c => {
      if (!c || !c.name || c.value === undefined || !c.domain) return null;

      const out = {
        name: c.name,
        value: String(c.value),
        domain: c.domain,
        path: c.path || '/',
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
      };

      // expires: Puppeteer ต้องการ unix timestamp วินาที ไม่ใช่ millisecond และต้องชื่อ `expires`
      // (extension ส่วนใหญ่ใช้ชื่อ `expirationDate` ตาม Chrome cookie API เดิม)
      const expiresRaw = c.expires ?? c.expirationDate;
      if (typeof expiresRaw === 'number' && expiresRaw > 0) out.expires = expiresRaw;

      const sameSite = normalizeSameSite(c.sameSite);
      if (sameSite) out.sameSite = sameSite;

      return out;
    })
    .filter(Boolean);
}

module.exports = { sanitizeCookies };
