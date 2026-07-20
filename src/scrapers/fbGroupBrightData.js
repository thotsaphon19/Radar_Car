/**
 * fbGroupBrightData.js — ดึงโพสต์จาก Facebook Group ผ่าน Bright Data
 *
 * ✅ ยืนยันแล้วจริงจาก curl ทดสอบ (ไม่ใช่แค่เดาจากเอกสาร):
 *      dataset_id: gd_lz11l67o2cb3r0lkj3
 *      endpoint:   /datasets/v3/scrape  (โหมด sync — ได้ผลลัพธ์ทันทีในคำขอเดียว)
 *      query:      ?dataset_id=...&notify=false&include_errors=true
 *      body:       { "input": [{ "url": "...", "user_to_not_include": "", "start_date": "",
 *                                 "end_date": "" }], "limit_per_input": null }
 *    (ก่อนหน้านี้เข้าใจผิดว่าต้องใช้โหมด async /trigger + /snapshot — ที่จริงยิง /scrape ตรงๆ
 *    ได้ผลลัพธ์กลับมาในคำขอเดียวเหมือน Marketplace เลย ไม่ต้อง poll)
 *
 * ขั้นตอนตั้งค่า:
 * 1. สมัคร https://brightdata.com/cp/start
 * 2. สร้าง API token ที่หน้า Settings > API Keys (ใช้ตัวเดียวกับ Marketplace ได้เลย)
 * 3. ตั้งค่าใน .env.local:
 *      BRIGHTDATA_API_TOKEN=xxxxxxxx
 *      (เปิดใช้งาน provider "brightdata" ของ Group ได้จากปุ่มในหน้า health.html)
 *
 * กลุ่มที่จะดึงมาจากที่ตั้งค่าไว้ในหน้า settings.html (เหมือน provider อื่นๆ) ไม่ต้องตั้งซ้ำที่นี่
 */

const { scrapeSync } = require('./brightdata');
const { getSettings } = require('../settingsStore');

const DATASET_ID = process.env.BRIGHTDATA_GROUP_DATASET_ID || 'gd_lz11l67o2cb3r0lkj3';

// query params ที่ curl ทดสอบยืนยันว่าถูกต้องสำหรับโหมด collect-by-url (ไม่มี type/discover_by
// เพราะนี่คือดึงจาก URL กลุ่มตรงๆ ไม่ใช่ discover ด้วย keyword แบบ Marketplace)
const GROUP_PARAMS = { notify: 'false' };

function extractPrice(text = '') {
  const m = text.match(/([\d,]{4,})\s*(บาท|฿)/);
  return m ? m[1].replace(/,/g, '') : null;
}

function extractGroupId(url = '') {
  const m = String(url).match(/facebook\.com\/groups\/([^/?]+)/);
  return m ? m[1] : null;
}

function mapItem(item, labelByGroupId) {
  const text = item.content || item.post_text || item.text || item.description || '';
  const url = item.url || item.post_url || '';
  const groupUrl = item.group_url || item.url || '';
  const groupId = extractGroupId(groupUrl) || extractGroupId(url);

  return {
    source: 'facebook_group',
    title: text.slice(0, 150).trim() || '(ไม่มีข้อความ)',
    price: extractPrice(text),
    url,
    image: item.attachments?.[0]?.url || item.attachments?.[0]?.thumbnail_url || item.image || null,
    groupLabel: (groupId && labelByGroupId[groupId]) || null,
    scrapedAt: new Date().toISOString(),
  };
}

async function scrapeGroupViaBrightData() {
  const settings = getSettings();
  const groups = (settings.facebookGroups || []).filter(g => g.enabled);
  if (groups.length === 0) {
    console.log('⚠️ ยังไม่มีกลุ่ม Facebook ที่ตั้งค่าไว้ (ทั้งในหน้า UI) — ข้าม Facebook Group');
    return [];
  }

  const labelByGroupId = {};
  groups.forEach(g => {
    const id = extractGroupId(g.url);
    if (id) labelByGroupId[id] = g.label;
  });

  const input = groups.map(g => ({ url: g.url, user_to_not_include: '', start_date: '', end_date: '' }));
  console.log(`🔍 [facebook_group] เรียก Bright Data สำหรับ ${groups.length} กลุ่ม`);

  let items;
  try {
    items = await scrapeSync(DATASET_ID, input, { extraParams: GROUP_PARAMS });
  } catch (e) {
    console.log(`❌ [facebook_group] เรียก Bright Data ไม่สำเร็จ: ${e.message}`);
    return [];
  }
  console.log(`🔍 [facebook_group] Bright Data คืนมาดิบๆ ${items.length} รายการ`);
  if (items.length > 0) {
    console.log(`🔍 [facebook_group] ตัวอย่างรายการแรก:`, JSON.stringify(items[0]).slice(0, 500));
  }

  const mapped = items.map(item => mapItem(item, labelByGroupId)).filter(l => l.title && l.url);
  if (items.length > 0 && mapped.length === 0) {
    console.log('⚠️ [facebook_group] มีข้อมูลดิบแต่ map แล้วเหลือ 0 — เช็ค field จาก log ด้านบน แล้วแก้ mapItem()');
  }
  return mapped;
}

module.exports = { scrapeGroupViaBrightData };
