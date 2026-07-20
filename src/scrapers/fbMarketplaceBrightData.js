/**
 * fbMarketplaceBrightData.js — ดึง Facebook Marketplace ผ่าน Bright Data (จ่ายเฉพาะที่สำเร็จ)
 *
 * ยืนยัน schema จริงจากเอกสารทางการแล้ว (ไม่ใช่การเดา):
 * https://docs.brightdata.com/api-reference/scrapers/social-media-apis/facebook-marketplace-discover-by-keyword
 *
 * dataset_id: gd_lvt9iwuh6fbcwmx1a (ใช้ได้ทั้งโหมด collect-by-url และ discover-by-keyword)
 *
 * ✅ ยืนยันแล้วว่า discover-by-keyword รองรับ location filter จริง — request ทดสอบที่ยิงตรงผ่าน curl
 *    ยืนยัน field ที่ endpoint /scrape รับ:
 *      ?dataset_id=...&notify=false&include_errors=true&type=discover_new&discover_by=keyword
 *      body: { "input": [{ "keyword": "...", "city": "...", "date_listed": "" }, ...หลายชุดได้ในคำขอเดียว],
 *              "limit_per_input": null }
 *
 * 🚗 ค้นหาเฉพาะรุ่นรถที่ลูกค้าต้องการ (ดู src/targetModels.js) — ยิง keyword ทุกรุ่น x ทุกพื้นที่ที่
 *    เปิดไว้ "ในคำขอเดียว" (input เป็น array รับหลายชุดพร้อมกันได้อยู่แล้วตามที่ยืนยันจาก curl ทดสอบ)
 *    แทนที่จะเป็นคำค้นหาทั่วไปแบบเดิม (เช่น "รถมือสอง") ที่ได้รถทุกรุ่นปนกันมา
 *
 * Output ต่อรายการ (ยืนยันจากตัวอย่างจริง):
 *   { url, title, initial_price, final_price, currency, product_id, condition, description,
 *     location, country_code, images: [...], seller_description, color, brand, videos,
 *     profile_id, listing_date }
 *
 * ขั้นตอนตั้งค่า:
 * 1. สมัคร https://brightdata.com/cp/start (ได้เครดิตฟรีเริ่มต้นให้ทดลอง)
 * 2. สร้าง API token ที่หน้า Settings > API Keys
 * 3. ตั้งค่าใน .env.local:
 *      BRIGHTDATA_API_TOKEN=xxxxxxxx
 *      (เปิดใช้งาน provider "brightdata" ของ Marketplace ได้จากปุ่มในหน้า health.html)
 *
 * ⚠️ ยังไม่ยืนยัน 100% ว่า Bright Data รู้จักชื่อเมืองไทยทุกเมืองแม่นแค่ไหน (ตัวอย่างในเอกสาร/ที่ทดสอบ
 *    ใช้เมืองต่างประเทศ เช่น "New York", "Toronto") — ทดสอบผ่านปุ่ม "ทดสอบดึงข้อมูลตอนนี้" ในหน้า
 *    settings.html เพื่อดูผลจริงก่อนใช้งานจริงเสมอ ถ้าเมืองไทยไม่ match อาจต้องลองปรับชื่อ (เช่น
 *    ใส่ "Bangkok, Thailand" แทน "Bangkok") แล้วดู rawCount ที่ได้กลับมาเทียบกัน
 */

const { scrapeSync } = require('./brightdata');
const { getSettings } = require('../settingsStore');
const { SEARCH_KEYWORDS, matchesTargetModel } = require('../targetModels');

const DATASET_ID = process.env.BRIGHTDATA_MARKETPLACE_DATASET_ID || 'gd_lvt9iwuh6fbcwmx1a';

// query params ที่เอกสาร + curl ทดสอบยืนยันว่าจำเป็นสำหรับโหมด discover-by-keyword
const DISCOVER_PARAMS = { notify: 'false', type: 'discover_new', discover_by: 'keyword' };

// เผื่อ settings เก่าที่เคยบันทึกไว้ใน Redis ก่อนเพิ่ม field `brightDataCity` — fallback ไป slug ตัวพิมพ์ใหญ่
const CITY_FALLBACK_BY_SLUG = {
  bangkok: 'Bangkok',
  chiangmai: 'Chiang Mai',
  nakhonratchasima: 'Nakhon Ratchasima',
  khonkaen: 'Khon Kaen',
  chonburi: 'Chonburi',
  hatyai: 'Hat Yai',
  phuket: 'Phuket',
  udonthani: 'Udon Thani',
};

function resolveCity(loc) {
  if (!loc) return '';
  return loc.brightDataCity || CITY_FALLBACK_BY_SLUG[loc.query] || '';
}

// รายชื่อพื้นที่ที่จะยิงคำขอไป — โหมดทั่วประเทศ = ทุกจังหวัดที่ enabled, โหมดพื้นที่เดียว = จังหวัดเดียว
function resolveLocations(mp) {
  if (mp.nationwide) {
    return (mp.locations || []).filter(l => l.enabled);
  }
  const singleLoc = (mp.locations || []).find(l => l.query === mp.singleLocation);
  if (singleLoc) return [singleLoc];
  // ไม่เจอใน locations (เช่น singleLocation เป็นค่าที่พิมพ์เองไม่ตรงรายการ) — ใช้ fallback slug ตรงๆ
  return [{ name: mp.singleLocation || 'bangkok', query: mp.singleLocation || 'bangkok' }];
}

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

function mapItem(item) {
  const price = item.final_price ?? item.initial_price;
  return {
    source: 'facebook_marketplace',
    title: item.title || '',
    price: price != null ? String(price) : null,
    url: item.url || '',
    image: Array.isArray(item.images) ? item.images[0] : (item.images || null),
    scrapedAt: new Date().toISOString(),
  };
}

function buildInputList(keywords, locations) {
  const input = [];
  locations.forEach(loc => {
    const city = resolveCity(loc);
    keywords.forEach(keyword => {
      input.push({ keyword, city: city || '', date_listed: '' });
    });
  });
  return input;
}

function dedupeByUrl(listings) {
  const seen = new Set();
  return listings.filter(l => {
    if (!l.url || seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
}

async function scrapeMarketplaceViaBrightData() {
  const settings = getSettings();
  const mp = settings.marketplace || {};
  const locations = resolveLocations(mp);
  if (locations.length === 0) {
    console.log('⚠️ เปิดโหมดทั่วประเทศไว้ แต่ยังไม่ได้เลือกจังหวัดเลย — ข้ามรอบนี้');
    return [];
  }
  const keywords = resolveKeywords(mp);
  const input = buildInputList(keywords, locations);

  console.log(`🔍 [facebook_marketplace] เรียก Bright Data ${input.length} ชุด (${keywords.length} รุ่นรถ x ${locations.length} พื้นที่) ในคำขอเดียว`);
  try {
    const items = await scrapeSync(DATASET_ID, input, { extraParams: DISCOVER_PARAMS });
    console.log(`🔍 [facebook_marketplace] Bright Data คืนมาดิบๆ ${items.length} รายการ`);
    if (items.length > 0) {
      console.log(`🔍 [facebook_marketplace] ตัวอย่างรายการแรก:`, JSON.stringify(items[0]).slice(0, 500));
    }
    // กรองซ้ำอีกชั้นด้วย matchesTargetModel — เผื่อ Bright Data คืนผลที่ไม่ตรงรุ่นมาปนด้วย (คำค้นหา
    // กว้างๆ อย่าง "Ranger" อาจดึงรถที่ไม่ใช่ยี่ห้อ/รุ่นที่ต้องการมาปนได้)
    const mapped = items.map(mapItem).filter(l => l.title && l.url && matchesTargetModel(l.title));
    if (items.length > 0 && mapped.length === 0) {
      console.log('⚠️ [facebook_marketplace] มีข้อมูลดิบแต่ map+กรองรุ่นแล้วเหลือ 0 — เช็ค field จาก log ด้านบน แล้วแก้ mapItem() หรือ targetModels.js');
    }
    return dedupeByUrl(mapped);
  } catch (e) {
    console.log(`❌ [facebook_marketplace] Bright Data ล้มเหลว: ${e.message}`);
    return [];
  }
}

// ใช้โดยปุ่ม "ทดสอบดึงข้อมูลตอนนี้" ในหน้า settings.html — ทดสอบทุกรุ่นรถ x พื้นที่เดียว (ไม่ต้อง
// วนทุกจังหวัดแม้เปิดโหมดทั่วประเทศไว้ กันใช้เครดิตเยอะเกินจำเป็นตอนแค่ทดสอบ)
async function testMarketplaceSearch() {
  const settings = getSettings();
  const mp = settings.marketplace || {};
  const testLocation = mp.nationwide
    ? ((mp.locations || []).find(l => l.enabled) || { name: 'bangkok', query: 'bangkok' })
    : resolveLocations(mp)[0];
  const keywords = resolveKeywords(mp);
  const input = buildInputList(keywords, [testLocation]);

  const items = await scrapeSync(DATASET_ID, input, { extraParams: DISCOVER_PARAMS });
  const mapped = items.map(mapItem).filter(l => l.title && l.url && matchesTargetModel(l.title));

  return {
    actorId: `brightdata:${DATASET_ID}`,
    keyword: `${keywords.length} รุ่นรถเป้าหมาย: ${keywords.join(', ')}`,
    location: resolveCity(testLocation) || testLocation.query || '(ไม่ระบุเมือง)',
    inputSent: { input, queryParams: DISCOVER_PARAMS },
    rawCount: items.length,
    mappedCount: mapped.length,
    sampleRawItem: items[0] ? JSON.stringify(items[0], null, 2).slice(0, 1500) : null,
    sampleResults: mapped.slice(0, 5),
  };
}

module.exports = { scrapeMarketplaceViaBrightData, testMarketplaceSearch };
