/**
 * fbMarketplaceApify.js — ดึง Facebook Marketplace ผ่าน Apify (บริการสแกนสำเร็จรูป)
 *
 * ✅ ยืนยัน schema จริงจากหน้าเอกสารทางการของ actor แล้ว (ไม่ใช่การเดาอีกต่อไป):
 *    Actor: get-leads/all-in-one-facebook-scraper
 *    ไม่ต้องใช้ cookies/บัญชี Facebook เลยสำหรับโหมด marketplace (มีคุก กี้ก็แค่ผลดีขึ้นเล็กน้อย)
 *
 * 🚗 ค้นหาเฉพาะรุ่นรถที่ลูกค้าต้องการ (ดู src/targetModels.js) — actor รับ marketplaceQueries เป็น
 *    array ของคำค้นหาได้หลายคำในคำขอเดียวอยู่แล้ว จึงส่งคำค้นหาทุกรุ่นรถเป้าหมายไปพร้อมกันในคำขอ
 *    เดียว (ไม่ต้องวนเรียก 1 คำขอต่อ 1 รุ่นแบบ Bright Data ที่ยิงทีละ input object)
 *
 * Input ที่ถูกต้องจริง:
 *   {
 *     "scrapeMode": "facebook-marketplace-scraper",
 *     "marketplaceQueries": ["คำค้นหา", "คำค้นหา2", ...],  ← array ของคำค้นหาได้หลายคำ
 *     "marketplaceLocation": "bangkok",          ← ชื่อเมืองตัวพิมพ์เล็ก ไม่มีเว้นวรรค ไม่ใช่ Location ID ตัวเลข!
 *     "resultsPerPage": 20
 *   }
 *
 * Output ที่ถูกต้องจริง (ตัวอย่างจากเอกสาร):
 *   { resultType: "marketplace-listing", listingId, listingTitle, listingPrice, amount,
 *     currency, listingUrl, sellerName, location, condition, media: [{url, type}], ... }
 *
 * ขั้นตอนตั้งค่า (ทำครั้งเดียว):
 * 1. สมัคร https://apify.com (มี free tier ให้ทดลองก่อน)
 * 2. ไปหน้า Settings > Integrations คัดลอก API token
 * 3. ตั้งค่าใน .env.local:
 *      APIFY_TOKEN=apify_api_xxxxxxxx
 *      APIFY_MARKETPLACE_ACTOR_ID=get-leads/all-in-one-facebook-scraper
 *      (เปิดใช้งาน provider "apify" ของ Marketplace ได้จากปุ่มในหน้า health.html)
 *
 * 💰 ลด Apify CU ด้วย checkpoint + priority ต่อพื้นที่ (จังหวัด) เหมือนที่ทำกับ Facebook Group —
 * โหมดทั่วประเทศเดิมยิง actor แยกทีละจังหวัด (8 จังหวัด = 8 คำขอทุกรอบ) ตอนนี้เช็คก่อนว่าจังหวัด
 * ไหน "ครบกำหนด" สแกนใหม่แล้วบ้าง (ตาม priority high/normal/low ที่ตั้งได้ต่อจังหวัดในหน้า
 * settings.html) — ถ้าไม่มีจังหวัดไหนครบกำหนดเลย ข้ามไปเลย ไม่ยิง actor แม้แต่ครั้งเดียว ถ้ามีบาง
 * จังหวัดครบกำหนด จะยิงเฉพาะจังหวัดนั้น (โหมดพื้นที่เดียว/ไม่ทั่วประเทศ ก็ใช้ระบบเดียวกัน แค่มีจังหวัด
 * เดียวในลิสต์) checkpoint เก็บถาวรใน Redis เหมือน Group
 */

const axios = require('axios');
require('dotenv').config({ path: '.env.local' });
const { getSettings } = require('../settingsStore');
const { SEARCH_KEYWORDS, matchesTargetModel } = require('../targetModels');
const { getJSON, setJSON } = require('../redisStore');

const CHECKPOINT_KEY = 'car-radar:marketplace-checkpoints';

// ครบกำหนดสแกนใหม่ทุกกี่ ms ต่อระดับ priority — ค่า default เดียวกับฝั่ง Group ปรับแยกกันได้ผ่าน env
const PRIORITY_INTERVAL_MS = {
  high: Number(process.env.APIFY_MARKETPLACE_HIGH_INTERVAL_MS || 3 * 60 * 1000),
  normal: Number(process.env.APIFY_MARKETPLACE_NORMAL_INTERVAL_MS || 10 * 60 * 1000),
  low: Number(process.env.APIFY_MARKETPLACE_LOW_INTERVAL_MS || 30 * 60 * 1000),
};

// รวมคำค้นหาที่จะใช้จริง: รุ่นรถเป้าหมายทั้งหมดจาก targetModels.js เสมอ + คำค้นหาที่ตั้งเองในหน้า
// settings.html เพิ่มอีก 1 คำถ้าตั้งไว้ (ไม่ใช่ค่า default 'รถมือสอง' — กันคำกว้างเกินไปที่จะทำให้
// ได้รถทุกรุ่นปนมา ขัดกับจุดประสงค์ที่อยากได้เฉพาะรุ่นเป้าหมาย)
function resolveKeywords(mp) {
  const custom = (mp.keyword || '').trim();
  if (custom && custom !== 'รถมือสอง') {
    return [...SEARCH_KEYWORDS, custom];
  }
  return SEARCH_KEYWORDS;
}

// เลือกเฉพาะพื้นที่ที่ "ครบกำหนด" สแกนใหม่แล้ว (เทียบเวลาสแกนล่าสุดของพื้นที่นั้นกับ interval ตาม priority)
function pickDueLocations(locations, checkpoints) {
  const now = Date.now();
  return locations.filter(loc => {
    const lastScanned = checkpoints[loc.query];
    if (!lastScanned) return true; // ไม่เคยสแกนมาก่อนเลย = ครบกำหนดเสมอ
    const intervalMs = PRIORITY_INTERVAL_MS[loc.priority || 'normal'] ?? PRIORITY_INTERVAL_MS.normal;
    return now - lastScanned >= intervalMs;
  });
}

// รวมรายชื่อพื้นที่ที่ตั้งค่าไว้ ไม่ว่าจะเป็นโหมดทั่วประเทศ (หลายจังหวัด) หรือพื้นที่เดียว — ให้ใช้
// checkpoint/priority ระบบเดียวกันทั้ง 2 โหมด (โหมดพื้นที่เดียวก็แค่มีจังหวัดเดียวในลิสต์)
function resolveLocations(mp) {
  if (mp.nationwide) {
    return (mp.locations || []).filter(l => l.enabled);
  }
  const single = (mp.locations || []).find(l => l.query === mp.singleLocation);
  return single ? [single] : [{ name: mp.singleLocation || 'bangkok', query: mp.singleLocation || 'bangkok', priority: 'normal' }];
}

const APIFY_TOKEN = process.env.APIFY_TOKEN;
// เดิม hardcode 180000ms (3 นาที) ไว้ ซึ่งไม่พอจริงเวลาค้นหลายคำ/หลายพื้นที่พร้อมกันในคำขอเดียว
// (เจอจริง: "timeout of 180000ms exceeded" ตอนค้น 12 รุ่นรถพร้อมกัน) เพิ่ม default เป็น 8 นาที
// ปรับได้ผ่าน env ถ้ายังไม่พอ (actor ยิ่งค้นหลายคำ/หลายพื้นที่พร้อมกัน ยิ่งใช้เวลานานขึ้นตามจริง)
const APIFY_RUN_TIMEOUT_MS = Number(process.env.APIFY_RUN_TIMEOUT_MS || 8 * 60 * 1000);
const ACTOR_ID = process.env.APIFY_MARKETPLACE_ACTOR_ID || 'get-leads/all-in-one-facebook-scraper';

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

function extractDigits(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).match(/[\d,]+(\.\d+)?/);
  return s ? s[0].replace(/,/g, '').split('.')[0] : null;
}

// เช็คว่า URL นี้เป็น "ไฟล์รูปจริง" จาก CDN (เอาไปใส่ <img> ได้จริง) ไม่ใช่ "หน้าเว็บดูรูป" ของ
// Facebook (facebook.com/photo/...) ที่เบราว์เซอร์ embed ไม่ได้เลย (โดน CORS/CORP บล็อกเสมอ)
function isRealImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (/facebook\.com\/photo/i.test(url)) return false;
  if (/^https?:\/\/(www\.|web\.|m\.)?facebook\.com\//i.test(url) && !/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return false;
  return /(fbcdn\.net|scontent)/i.test(url) || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url);
}

function mapItem(item) {
  // field ตรงจากเอกสารทางการของ actor get-leads/all-in-one-facebook-scraper
  const title = item.listingTitle || item.title || '';
  const url = item.listingUrl || item.url || (item.listingId ? `https://www.facebook.com/marketplace/item/${item.listingId}/` : '');
  const price = extractDigits(item.amount ?? item.listingPrice ?? item.price);

  // กรองด้วย isRealImageUrl() กันหลุดลิงก์ "หน้าเว็บดูรูป" ของ Facebook (facebook.com/photo/...)
  // ที่เบราว์เซอร์ฝัง <img> ไม่ได้เลย (โดน CORS บล็อกเสมอ) ต้องเป็นลิงก์ไฟล์รูปจาก CDN จริงเท่านั้น
  const imageCandidates = [item.media?.[0]?.url, item.image];
  const image = imageCandidates.find(isRealImageUrl) || null;

  return {
    source: 'facebook_marketplace',
    title,
    price,
    url,
    image,
    scrapedAt: new Date().toISOString(),
  };
}

function buildInput(keywords, locationSlug, maxItems) {
  return {
    scrapeMode: 'facebook-marketplace-scraper',
    marketplaceQueries: keywords,
    marketplaceLocation: locationSlug,
    resultsPerPage: maxItems,
  };
}

async function scrapeOneLocation(keywords, locationSlug, maxItems, locationLabel) {
  try {
    const items = await runActor(ACTOR_ID, buildInput(keywords, locationSlug, maxItems));
    console.log(`🔍 [facebook_marketplace/${locationLabel}] Apify คืนมาดิบๆ ${items.length} รายการ (${keywords.length} คำค้นหา)`);
    if (items.length > 0) {
      console.log(`🔍 [facebook_marketplace/${locationLabel}] ตัวอย่างรายการแรก:`, JSON.stringify(items[0]).slice(0, 500));
    }
    // กรองซ้ำอีกชั้นด้วย matchesTargetModel — เผื่อ actor คืนผลที่ไม่ตรงรุ่นมาปนด้วย
    const mapped = items.map(mapItem).filter(l => l.title && l.url && matchesTargetModel(l.title));
    if (items.length > 0 && mapped.length === 0) {
      console.log(`⚠️ [facebook_marketplace/${locationLabel}] มีข้อมูลดิบ ${items.length} รายการ แต่หลัง map+กรองรุ่นแล้วเหลือ 0 — เช็ค mapItem()/targetModels.js`);
    }
    return mapped;
  } catch (e) {
    console.log(`❌ [facebook_marketplace] ดึงพื้นที่ "${locationLabel}" ไม่สำเร็จ: ${e.message}`);
    return [];
  }
}

// ใช้โดยปุ่ม "ทดสอบดึงข้อมูลตอนนี้" ในหน้า settings.html — คืนรายละเอียดครบทั้ง raw/mapped
// (ทดสอบยิงจริงเสมอ ไม่ผ่าน checkpoint/priority เพราะเป็นการกดทดสอบเอง ต้องการเห็นผลทันที)
async function testMarketplaceSearch() {
  if (!APIFY_TOKEN) throw new Error('ยังไม่ได้ตั้งค่า APIFY_TOKEN');
  if (!ACTOR_ID) throw new Error('ยังไม่ได้ตั้งค่า APIFY_MARKETPLACE_ACTOR_ID');

  const settings = getSettings();
  const mp = settings.marketplace || {};
  const keywords = resolveKeywords(mp);
  const location = mp.nationwide
    ? ((mp.locations || []).find(l => l.enabled)?.query || 'bangkok')
    : (mp.singleLocation || 'bangkok');
  const maxItems = Number(mp.maxItemsPerLocation || 20);

  const input = buildInput(keywords, location, maxItems);
  const items = await runActor(ACTOR_ID, input);
  const mapped = items.map(mapItem).filter(l => l.title && l.url && matchesTargetModel(l.title));

  return {
    actorId: ACTOR_ID,
    keyword: `${keywords.length} รุ่นรถเป้าหมาย: ${keywords.join(', ')}`,
    location,
    inputSent: input,
    rawCount: items.length,
    mappedCount: mapped.length,
    sampleRawItem: items[0] ? JSON.stringify(items[0], null, 2).slice(0, 1500) : null,
    sampleResults: mapped.slice(0, 5),
  };
}

async function scrapeMarketplaceViaApify() {
  const settings = getSettings();
  const mp = settings.marketplace || {};
  const keywords = resolveKeywords(mp);
  const maxItems = Number(mp.maxItemsPerLocation || 20);

  const allLocations = resolveLocations(mp);
  if (allLocations.length === 0) {
    console.log('⚠️ เปิดโหมดทั่วประเทศไว้ แต่ยังไม่ได้เลือกจังหวัดเลย — ข้ามรอบนี้');
    return [];
  }

  const checkpoints = await getJSON(CHECKPOINT_KEY, {});
  const dueLocations = pickDueLocations(allLocations, checkpoints);

  if (dueLocations.length === 0) {
    // ไม่มีพื้นที่ไหนครบกำหนดสแกนใหม่เลยตอนนี้ — ข้ามไปเลย ไม่ยิง actor (ประหยัด CU เต็มๆ)
    console.log(`⏭️  [facebook_marketplace] ยังไม่มีพื้นที่ไหนครบกำหนดสแกนใหม่ (จาก ${allLocations.length} พื้นที่) — ข้ามรอบนี้ ไม่เสีย Apify CU`);
    return [];
  }

  console.log(`🔍 [facebook_marketplace] ครบกำหนดสแกน ${dueLocations.length}/${allLocations.length} พื้นที่: ${dueLocations.map(l => l.name || l.query).join(', ')}`);

  const results = await Promise.all(
    dueLocations.map(loc => scrapeOneLocation(keywords, loc.query, maxItems, loc.name || loc.query))
  );

  // อัปเดต checkpoint ของพื้นที่ที่เพิ่งสแกนไป ไม่ว่าจะเจอของใหม่หรือ error ก็ตาม (นับว่า "ลองแล้ว"
  // กันยิงซ้ำรัวๆ ตอน error ต่อเนื่อง เช่น account ใช้ไม่ได้ ซึ่งยิงซ้ำไปก็ error เหมือนเดิมเปล่าๆ)
  const now = Date.now();
  dueLocations.forEach(loc => { checkpoints[loc.query] = now; });
  await setJSON(CHECKPOINT_KEY, checkpoints);

  const merged = results.flat();
  const seenUrl = new Set();
  return merged.filter(l => {
    if (seenUrl.has(l.url)) return false;
    seenUrl.add(l.url);
    return true;
  });
}

module.exports = { scrapeMarketplaceViaApify, testMarketplaceSearch, mapItem };
