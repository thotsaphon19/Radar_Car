/**
 * fbDiscovery.js — ค้นหากลุ่ม Facebook ที่เกี่ยวกับรถมือสองให้อัตโนมัติ (ผ่าน Apify)
 *
 * ⚠️⚠️ สำคัญมาก: APIFY_GROUP_DISCOVERY_ACTOR_ID ต้องเป็นคนละตัวกับ APIFY_GROUP_ACTOR_ID/
 * APIFY_MARKETPLACE_ACTOR_ID เสมอ! actor "get-leads/all-in-one-facebook-scraper" ที่ใช้ดึงโพสต์
 * จากกลุ่ม/Marketplace ที่รู้ URL อยู่แล้ว **ไม่ใช่ actor สำหรับค้นหา "กลุ่มไหนมีอยู่บ้าง" จากคำค้นหา**
 * ถ้าตั้ง APIFY_GROUP_DISCOVERY_ACTOR_ID เป็น actor ตัวเดียวกับที่ใช้ scrape จะได้ error
 * "Actor run did not succeed (status: FAILED)" เพราะ input ที่ส่งไป (ลิงก์หน้าค้นหากลุ่มของ FB)
 * ไม่ตรงกับสิ่งที่ actor ตัวนั้นออกแบบมารองรับ — ต้องไปหา actor คนละตัวใน Apify Store ที่ทำหน้าที่
 * "ค้นหา/discover กลุ่ม Facebook จากคำค้นหา" โดยเฉพาะ (เช่นค้นคำว่า "facebook group search scraper")
 *
 * ขั้นตอนตั้งค่า:
 * 1. ไปที่ Apify Store ค้นหา "Facebook Groups Search Scraper" (มีหลายเจ้าให้เลือก เลือกตัวรีวิวดี —
 *    คนละตัวกับ actor ที่ใช้ scrape โพสต์จากกลุ่ม!)
 * 2. คัดลอก Actor ID มาใส่ APIFY_GROUP_DISCOVERY_ACTOR_ID ใน .env.local
 *
 * ตั้งค่าใน .env.local:
 *   APIFY_GROUP_DISCOVERY_ACTOR_ID=<owner>/<actor-name>
 *   FB_DISCOVERY_MAX_ITEMS=40
 *
 * ⚠️ ผลลัพธ์ที่ได้เป็น "รายชื่อผู้สมัครให้เลือก" เท่านั้น ไม่ได้เพิ่มเข้าระบบดึงข้อมูลอัตโนมัติ
 *    ต้องให้คนกดเลือกยืนยันก่อนเสมอ (ทำในหน้า settings.html) กันเผลอไปติดตามกลุ่มที่ไม่เกี่ยวข้อง
 *    หรือกลุ่มที่มีคุณภาพต่ำ
 *
 * ⚠️ input ของแต่ละ actor ไม่เหมือนกัน — ไฟล์นี้ส่ง { startUrls, maxItems } ซึ่งใช้ได้กับ actor
 *    ที่ต้องการ "ลิงก์เริ่มต้น" (พบบ่อยสุด) ถ้า deploy แล้วยังเจอ error "Field input.xxx is required"
 *    อีก ให้เข้าไปดูแท็บ "Input" ในหน้า actor บน Apify console จะเห็น schema ที่ถูกต้องแน่นอน
 *    แล้วปรับ input object ในฟังก์ชัน discoverGroups() ให้ตรงกัน
 */

const axios = require('axios');
require('dotenv').config({ path: '.env.local' });

const APIFY_TOKEN = process.env.APIFY_TOKEN;
// เดิม hardcode 180000ms (3 นาที) ไว้ ซึ่งไม่พอจริงเวลาค้นหลายคำ/หลายพื้นที่พร้อมกันในคำขอเดียว
// (เจอจริง: "timeout of 180000ms exceeded" ตอนค้น 12 รุ่นรถพร้อมกัน) เพิ่ม default เป็น 8 นาที
// ปรับได้ผ่าน env ถ้ายังไม่พอ (actor ยิ่งค้นหลายคำ/หลายพื้นที่พร้อมกัน ยิ่งใช้เวลานานขึ้นตามจริง)
const APIFY_RUN_TIMEOUT_MS = Number(process.env.APIFY_RUN_TIMEOUT_MS || 8 * 60 * 1000);
const ACTOR_ID = process.env.APIFY_GROUP_DISCOVERY_ACTOR_ID;

async function runActor(actorId, input) {
  if (!APIFY_TOKEN) throw new Error('ยังไม่ได้ตั้งค่า APIFY_TOKEN ใน .env.local');
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  try {
    const { data } = await axios.post(url, input, { timeout: APIFY_RUN_TIMEOUT_MS });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    // ดึงข้อความ error จริงจาก Apify ออกมา แทนที่จะโชว์แค่ "status code 400" เฉยๆ
    const apiMsg = e.response?.data?.error?.message || e.response?.data?.error || JSON.stringify(e.response?.data) || e.message;
    // ข้อความ "did not succeed" จาก Apify sync endpoint ไม่บอกสาเหตุจริง (blocked/timeout/input ผิด/
    // เครดิตหมด ฯลฯ) แค่บอก run ID + status — ต้องเข้า Apify Console ไปดู log จริงของ run นั้นถึงจะรู้
    // สาเหตุ ต่อ link ให้อัตโนมัติถ้าดึง run ID จากข้อความได้
    const runIdMatch = apiMsg.match(/run ID:\s*([A-Za-z0-9]+)/);
    const consoleHint = runIdMatch
      ? ` — เช็คสาเหตุจริงได้ที่ https://console.apify.com/actors/runs/${runIdMatch[1]} (sync endpoint ไม่บอกสาเหตุจริง แค่บอกว่าไม่สำเร็จ)`
      : '';
    throw new Error(`Apify actor "${actorId}" ล้มเหลว: ${apiMsg}${consoleHint}`);
  }
}

function mapGroup(item) {
  return {
    name: item.name || item.title || item.groupName || '(ไม่มีชื่อ)',
    url: item.url || item.link || item.groupUrl || '',
    members: item.memberCount || item.members || item.membersCount || null,
    privacy: item.privacy || item.type || null,
    description: (item.description || item.about || '').slice(0, 160),
  };
}

async function discoverGroups(keywords) {
  if (!ACTOR_ID) {
    throw new Error('ยังไม่ได้ตั้งค่า APIFY_GROUP_DISCOVERY_ACTOR_ID ใน .env.local — ดูขั้นตอนในคอมเมนต์บนไฟล์นี้');
  }
  // เช็คเคสที่พบบ่อยที่สุด: ตั้ง discovery actor เป็นตัวเดียวกับ actor ที่ใช้ scrape โพสต์ (ผิด!) —
  // เตือนไว้ล่วงหน้าก่อนจะยิงจริงแล้วได้ error "Actor run did not succeed" ที่ไม่บอกสาเหตุชัดเจน
  const scrapeActorIds = [process.env.APIFY_GROUP_ACTOR_ID, process.env.APIFY_MARKETPLACE_ACTOR_ID].filter(Boolean);
  if (scrapeActorIds.includes(ACTOR_ID)) {
    // ยืนยันแล้วจากการทดสอบจริง (ไม่ใช่แค่เดา): ตั้งค่าแบบนี้แล้วได้ 0 รายการทุกครั้ง เพราะ actor
    // "get-leads/all-in-one-facebook-scraper" ถูกออกแบบมาให้ดึงโพสต์จาก URL กลุ่ม/Marketplace ที่รู้
    // อยู่แล้ว ไม่ใช่ค้นหา "มีกลุ่มอะไรบ้าง" จากหน้าค้นหาของ Facebook (input ที่ส่งไปเป็นลิงก์หน้า
    // ค้นหา ซึ่ง actor ตัวนี้ไม่รู้จักโครงสร้างเลย) — หยุดก่อนยิงจริงเพื่อไม่ให้เสีย Apify CU ฟรีๆ
    throw new Error(
      `APIFY_GROUP_DISCOVERY_ACTOR_ID ตั้งเป็น actor ตัวเดียวกับที่ใช้ scrape โพสต์ ("${ACTOR_ID}") ` +
      `ซึ่งยืนยันแล้วว่าใช้ค้นหากลุ่มไม่ได้ (ทดสอบแล้วได้ 0 รายการทุกครั้ง) — actor ตัวนี้ออกแบบมาสำหรับ ` +
      `ดึงโพสต์จาก URL กลุ่มที่รู้อยู่แล้วเท่านั้น ไม่ใช่ค้นหากลุ่มจากคำค้นหา ` +
      `กรุณาใช้ปุ่ม "ใช้กลุ่มแนะนำ" แทนไปก่อน หรือไปหา actor คนละตัวชื่อทำนอง ` +
      `"Facebook Groups Search Scraper" ใน Apify Store มาใส่แทน (ดูคอมเมนต์บนสุดของไฟล์ fbDiscovery.js)`
    );
  }
  const kws = (Array.isArray(keywords) && keywords.length > 0)
    ? keywords
    : ['รถมือสอง', 'ซื้อขายรถมือสอง', 'เต็นท์รถมือสอง'];

  // actor ตัวนี้ต้องการ startUrls (ลิงก์เริ่มต้น) ไม่ใช่ keywords ตรงๆ — สร้างลิงก์ค้นหากลุ่มบน Facebook
  // จากคำค้นหาแต่ละคำแทน (รูปแบบ URL มาตรฐานของหน้าค้นหากลุ่ม Facebook)
  const input = {
    startUrls: kws.map(kw => ({ url: `https://www.facebook.com/search/groups/?q=${encodeURIComponent(kw)}` })),
    maxItems: Number(process.env.FB_DISCOVERY_MAX_ITEMS || 40),
  };
  const items = await runActor(ACTOR_ID, input);
  console.log(`🔍 [discover_groups] Apify คืนมาดิบๆ ${items.length} รายการ`);
  if (items.length > 0) {
    console.log(`🔍 [discover_groups] ตัวอย่างรายการแรก:`, JSON.stringify(items[0]).slice(0, 800));
  }

  const mapped = items.map(mapGroup).filter(g => g.url && g.name);
  if (items.length > 0 && mapped.length === 0) {
    console.log(`⚠️ [discover_groups] มีข้อมูลดิบ ${items.length} รายการ แต่หลัง map แล้วเหลือ 0 — mapGroup() แกะ field ผิด`);
  }

  const seen = new Set();
  const groups = mapped.filter(g => {
    if (seen.has(g.url)) return false;
    seen.add(g.url);
    return true;
  });

  return {
    groups,
    rawCount: items.length,
    mappedCount: mapped.length,
    inputSent: input,
    sampleRawItem: items[0] ? JSON.stringify(items[0], null, 2).slice(0, 1500) : null,
  };
}

module.exports = { discoverGroups };
