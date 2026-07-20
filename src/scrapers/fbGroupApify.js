/**
 * fbGroupApify.js — ดึงโพสต์จาก Facebook Group ผ่าน Apify (บริการสแกนสำเร็จรูป)
 * (ทำงานคล้าย fbMarketplaceApify.js — ดูคอมเมนต์เต็มในไฟล์นั้นประกอบ)
 *
 * ขั้นตอนตั้งค่า:
 * 1. ใน Apify Store ค้นหา "Facebook Groups Scraper" (ตัวที่ rating/success rate สูง)
 * 2. คัดลอก Actor ID
 * 3. หา URL ของกลุ่ม Facebook ที่ต้องการติดตาม (ต้องเป็นกลุ่มสาธารณะ)
 *
 * ตั้งค่าใน .env.local:
 *   APIFY_TOKEN=apify_api_xxxxxxxx
 *   APIFY_GROUP_ACTOR_ID=<owner>/<actor-name>
 *   FB_GROUP_MAX_ITEMS=40
 *
 * ชื่อกลุ่มที่แสดงในแดชบอร์ด (groupLabel) ไม่ได้พึ่ง field จาก Apify เลย — จับคู่เอาเองจาก
 * Group ID ใน URL ของแต่ละโพสต์ เทียบกับ URL กลุ่มที่ตั้งค่าไว้ในหน้า settings.html แม่นกว่า
 * และไม่ขึ้นกับว่า actor จะมี field ชื่อกลุ่มให้หรือเปล่า
 *
 * 💰 ลด Apify CU ด้วยการสแกนแบบ "checkpoint ต่อกลุ่ม + แบ่งระดับความถี่" — แทนที่จะยิง actor
 * สแกนทุกกลุ่มพร้อมกันทุกรอบ (เปลืองมาก ถ้า poll ถี่แบบใกล้เรียลไทม์):
 *   1. แต่ละกลุ่มมี priority (high/normal/low) ตั้งได้จากหน้า settings.html — คุมว่ากลุ่มนั้น
 *      "ครบกำหนด" ต้องสแกนใหม่ทุกกี่นาที (ปรับได้ด้วย env ด้านล่าง)
 *   2. ทุกครั้งที่ฟังก์ชันนี้ถูกเรียก (ทุก APIFY_POLL_INTERVAL_MS) จะเช็คก่อนว่ามีกลุ่มไหน "ครบกำหนด"
 *      แล้วบ้าง (เทียบกับเวลาที่สแกนกลุ่มนั้นล่าสุด) — ถ้าไม่มีกลุ่มไหนครบกำหนดเลย จะ "ข้ามไปเลย
 *      ไม่ยิง actor" (ไม่เสีย CU แม้แต่นิดเดียว) ถ้ามีบางกลุ่มครบกำหนด จะยิง actor เฉพาะกลุ่มที่ครบ
 *      กำหนดเท่านั้น (ไม่ใช่ทุกกลุ่ม) ทำให้ CU ต่อรอบเล็กลงมาก
 *   3. checkpoint (เวลาสแกนล่าสุดต่อกลุ่ม) เก็บถาวรใน Redis ผ่าน redisStore.js เลยไม่หายตอน
 *      เซิร์ฟเวอร์รีสตาร์ท/deploy ใหม่
 *
 * ตัวอย่าง: ตั้ง APIFY_POLL_INTERVAL_MS=60000 (เช็คทุก 1 นาที) + กลุ่ม high ครบกำหนดทุก 3 นาที,
 * normal ทุก 10 นาที, low ทุก 30 นาที — แทนที่จะสแกนทุกกลุ่มทุก 5 นาทีเท่ากันหมด (ของเดิม)
 */

const axios = require('axios');
require('dotenv').config({ path: '.env.local' });
const { getSettings } = require('../settingsStore');
const { getJSON, setJSON } = require('../redisStore');

const APIFY_TOKEN = process.env.APIFY_TOKEN;
// เดิม hardcode 180000ms (3 นาที) ไว้ ซึ่งไม่พอจริงเวลาค้นหลายคำ/หลายพื้นที่พร้อมกันในคำขอเดียว
// (เจอจริง: "timeout of 180000ms exceeded" ตอนค้น 12 รุ่นรถพร้อมกัน) เพิ่ม default เป็น 8 นาที
// ปรับได้ผ่าน env ถ้ายังไม่พอ (actor ยิ่งค้นหลายคำ/หลายพื้นที่พร้อมกัน ยิ่งใช้เวลานานขึ้นตามจริง)
const APIFY_RUN_TIMEOUT_MS = Number(process.env.APIFY_RUN_TIMEOUT_MS || 8 * 60 * 1000);
const ACTOR_ID = process.env.APIFY_GROUP_ACTOR_ID;

const CHECKPOINT_KEY = 'car-radar:group-checkpoints';

// ครบกำหนดสแกนใหม่ทุกกี่ ms ต่อระดับ priority — ปรับได้ผ่าน env ถ้า default ไม่เหมาะกับธุรกิจ
const PRIORITY_INTERVAL_MS = {
  high: Number(process.env.APIFY_GROUP_HIGH_INTERVAL_MS || 3 * 60 * 1000),
  normal: Number(process.env.APIFY_GROUP_NORMAL_INTERVAL_MS || 10 * 60 * 1000),
  low: Number(process.env.APIFY_GROUP_LOW_INTERVAL_MS || 30 * 60 * 1000),
};

async function runActor(actorId, input) {
  if (!APIFY_TOKEN) throw new Error('ยังไม่ได้ตั้งค่า APIFY_TOKEN ใน .env.local');
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  try {
    const { data } = await axios.post(url, input, { timeout: APIFY_RUN_TIMEOUT_MS });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    const apiMsg = e.response?.data?.error?.message || e.response?.data?.error || JSON.stringify(e.response?.data) || e.message;
    // ข้อความ "did not succeed" จาก Apify sync endpoint ไม่บอกสาเหตุจริง (blocked/timeout/input ผิด/
    // เครดิตหมด ฯลฯ) แค่บอก run ID + status — ต้องเข้า Apify Console ไปดู log จริงของ run นั้นถึงจะรู้
    // สาเหตุ ต่อ link ให้อัตโนมัติถ้าดึง run ID จากข้อความได้
    const runIdMatch = apiMsg.match(/run ID:\s*([A-Za-z0-9]+)/);
    const consoleHint = runIdMatch
      ? ` — เช็คสาเหตุจริงได้ที่ https://console.apify.com/actors/runs/${runIdMatch[1]} (sync endpoint ไม่บอกสาเหตุจริง แค่บอกว่าไม่สำเร็จ)`
      : '';
    // เช็คว่า error นี้เกี่ยวกับเครดิต/งบประมาณหมดไหม (ข้อความจาก Apify มักมีคำพวกนี้) — ถ้าใช่ ติด
    // flag ไว้ให้ server.js เห็น จะได้ auto-enable Watcher (ฟรี ไม่ใช้เครดิต) ให้อัตโนมัติ ระบบจะได้
    // ยังดึงข้อมูลต่อได้แม้เครดิต Apify หมด (ดู createSourceController() ใน server.js)
    const err = new Error(`Apify actor "${actorId}" ล้มเหลว: ${apiMsg}${consoleHint}`);
    err.isCreditExhausted = /insufficient|not enough|exceed.*(budget|limit|usage)|monthly usage hard limit|account balance|out of credit|quota exceeded/i.test(apiMsg);
    throw err;
  }
}

function extractPrice(text = '') {
  const m = text.match(/([\d,]{4,})\s*(บาท|฿)/);
  return m ? m[1].replace(/,/g, '') : null;
}

// ดึง Group ID ออกจาก URL เช่น facebook.com/groups/466982883484793/permalink/... -> "466982883484793"
function extractGroupId(url = '') {
  const m = String(url).match(/facebook\.com\/groups\/([^/?]+)/);
  return m ? m[1] : null;
}

// เช็คว่า URL นี้เป็น "ไฟล์รูปจริง" จาก CDN ของ Facebook (เอาไปใส่ <img> ได้จริง)
// ไม่ใช่ "หน้าเว็บดูรูป" แบบ facebook.com/photo/... หรือ web.facebook.com/photo.php ที่เบราว์เซอร์
// embed ไม่ได้เลย (โดน CORS/CORP บล็อกเสมอ ทำให้รูปพังทุกครั้ง — เจอปัญหานี้จริงจาก field attachments.url
// ที่บาง actor ให้ลิงก์หน้าเว็บมาแทนที่จะเป็นลิงก์ไฟล์รูปตรงๆ)
function isRealImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (/facebook\.com\/photo/i.test(url)) return false; // หน้า "ดูรูป" ของ FB ไม่ใช่ไฟล์รูป
  if (/^https?:\/\/(www\.|web\.|m\.)?facebook\.com\//i.test(url) && !/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return false;
  return /(fbcdn\.net|scontent)/i.test(url) || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url);
}

function mapItem(item) {
  // ปรับ field ตามผลลัพธ์จริงของ actor ที่เลือก — ดู console.log(item) ตอนทดสอบครั้งแรก
  const text = item.text || item.message || item.postText || '';
  const url = item.url || item.postUrl || item.link || '';

  // เช็ค field รูปภาพหลายแบบ เพราะแต่ละ actor ตั้งชื่อ field ไม่เหมือนกัน — กรองด้วย isRealImageUrl()
  // ทุกตัวเลือก กันหลุดลิงก์ "หน้าเว็บดูรูป" ที่ฝัง <img> ไม่ได้ (ทำให้รูปพังบนแดชบอร์ด)
  const candidates = [
    item.media?.[0]?.url,
    item.media?.[0]?.image?.uri,
    item.attachments?.[0]?.url,
    item.attachments?.[0]?.image?.uri,
    item.attachments?.[0]?.media?.image?.uri,
    item.images?.[0]?.url,
    item.images?.[0],
    item.photos?.[0]?.url,
    item.photos?.[0],
    item.imageUrls?.[0],
    item.mediaUrls?.[0],
    item.thumbnail,
    item.thumbnailUrl,
    item.image,
  ];
  const image = candidates.find(isRealImageUrl) || null;

  return {
    source: 'facebook_group',
    title: text.slice(0, 120).trim() || '(ไม่มีข้อความ)',
    price: extractPrice(text),
    url,
    image,
    scrapedAt: new Date().toISOString(),
  };
}

// เลือกเฉพาะกลุ่มที่ "ครบกำหนด" สแกนใหม่แล้ว (เทียบเวลาสแกนล่าสุดของกลุ่มนั้นกับ interval ตาม priority)
function pickDueGroups(configuredGroups, checkpoints) {
  const now = Date.now();
  return configuredGroups.filter(g => {
    const id = extractGroupId(g.url) || g.url;
    const lastScanned = checkpoints[id];
    if (!lastScanned) return true; // ไม่เคยสแกนมาก่อนเลย = ครบกำหนดเสมอ
    const intervalMs = PRIORITY_INTERVAL_MS[g.priority || 'normal'] ?? PRIORITY_INTERVAL_MS.normal;
    return now - lastScanned >= intervalMs;
  });
}

async function scrapeGroupViaApify() {
  if (!ACTOR_ID) {
    console.log('⚠️ ยังไม่ได้ตั้งค่า APIFY_GROUP_ACTOR_ID — ข้าม Facebook Group');
    return [];
  }

  // ลำดับความสำคัญ: กลุ่มที่ลูกค้าบันทึกผ่านหน้า UI หลังบ้าน > ค่าเริ่มต้นจาก .env.local
  const settings = getSettings();
  const configuredGroups = (settings.facebookGroups || []).filter(g => g.enabled);
  const envGroupUrls = (process.env.FB_GROUP_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allGroups = configuredGroups.length > 0
    ? configuredGroups
    : envGroupUrls.map(url => ({ url, label: url, priority: 'normal' }));

  if (allGroups.length === 0) {
    console.log('⚠️ ยังไม่มีกลุ่ม Facebook ที่ตั้งค่าไว้ (ทั้งในหน้า UI และ .env.local) — ข้าม Facebook Group');
    return [];
  }

  const checkpoints = await getJSON(CHECKPOINT_KEY, {});
  const dueGroups = pickDueGroups(allGroups, checkpoints);

  if (dueGroups.length === 0) {
    // ไม่มีกลุ่มไหนครบกำหนดสแกนใหม่เลยตอนนี้ — ข้ามไปเลย ไม่ยิง actor (ประหยัด CU เต็มๆ)
    console.log(`⏭️  [facebook_group] ยังไม่มีกลุ่มไหนครบกำหนดสแกนใหม่ (จาก ${allGroups.length} กลุ่ม) — ข้ามรอบนี้ ไม่เสีย Apify CU`);
    return [];
  }

  console.log(`🔍 [facebook_group] ครบกำหนดสแกน ${dueGroups.length}/${allGroups.length} กลุ่ม: ${dueGroups.map(g => g.label || g.url).join(', ')}`);

  // ตาราง Group ID -> ชื่อกลุ่ม (จากที่ตั้งค่าไว้ในหน้า UI) ใช้แปะชื่อกลุ่มกลับเข้าไปในแต่ละโพสต์
  const labelByGroupId = {};
  configuredGroups.forEach(g => {
    const id = extractGroupId(g.url);
    if (id) labelByGroupId[id] = g.label;
  });

  const input = {
    startUrls: dueGroups.map(g => ({ url: g.url })),
    resultsLimit: Number(process.env.FB_GROUP_MAX_ITEMS || 40),
  };
  const items = await runActor(ACTOR_ID, input);
  console.log(`🔍 [facebook_group] Apify คืนมาดิบๆ ${items.length} รายการ`);
  if (items.length > 0) {
    console.log(`🔍 [facebook_group] ตัวอย่างรายการแรก:`, JSON.stringify(items[0]).slice(0, 800));
  }

  // อัปเดต checkpoint ของกลุ่มที่เพิ่งสแกนไป (ไม่ว่าจะเจอโพสต์ใหม่หรือไม่ก็ตาม — ถือว่า "สแกนแล้ว"
  // แล้วนับรอบถัดไปจากตรงนี้) แม้ actor จะพังกลางทางก็ยังนับว่าลองสแกนไปแล้วรอบนี้ กันยิงรัวๆ ซ้ำๆ
  // ตอนเจอ error ต่อเนื่อง (เช่น account ใช้ไม่ได้) ซึ่งยิงซ้ำไปก็ error เหมือนเดิมเปล่าๆ
  const now = Date.now();
  dueGroups.forEach(g => {
    const id = extractGroupId(g.url) || g.url;
    checkpoints[id] = now;
  });
  await setJSON(CHECKPOINT_KEY, checkpoints);

  const mapped = items.map(mapItem).filter(l => l.title && l.url);
  if (items.length > 0 && mapped.length === 0) {
    console.log(`⚠️ [facebook_group] มีข้อมูลดิบ ${items.length} รายการ แต่หลัง map แล้วเหลือ 0 — mapItem() แกะ field ผิด ส่งตัวอย่างข้างบนนี้กลับมาให้แก้ mapping ได้เลย`);
  }

  // แปะชื่อกลุ่มกลับเข้าไปในแต่ละรายการ โดยจับคู่จาก Group ID ใน url ของโพสต์
  mapped.forEach(l => {
    const id = extractGroupId(l.url);
    l.groupLabel = (id && labelByGroupId[id]) || null;
  });

  return mapped;
}

module.exports = { scrapeGroupViaApify, mapItem, extractGroupId };
