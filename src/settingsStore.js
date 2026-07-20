/**
 * settingsStore.js — เก็บค่าตั้งค่าที่ลูกค้ากรอกผ่านหน้า UI หลังบ้าน (กลุ่ม Facebook ที่จะดึง,
 * คำค้นหา Marketplace, ดึงทั่วประเทศหรือเจาะพื้นที่, เปิด/ปิด provider แต่ละตัว) ถาวรผ่าน Upstash Redis
 * (ดู redisStore.js สำหรับวิธีตั้งค่า — เดิมเก็บเป็นไฟล์ แต่ไฟล์หายเวลา deploy ใหม่บน hosting ฟรี
 * ที่ไม่มี persistent disk เช่น Render free tier จึงย้ายมาเก็บที่ Redis แทน)
 */

const { getJSON, setJSON } = require('./redisStore');

const KEY = 'car-radar:settings';

// เมืองหลักที่ใช้ประมาณ "ทั่วประเทศ" — field `query` เป็นชื่อเมืองสำหรับ actor Apify (get-leads/
// all-in-one-facebook-scraper) ตัวพิมพ์เล็กไม่มีเว้นวรรค เช่น "bangkok"
// field `brightDataCity` เป็นคนละแบบ — ใช้กับ Bright Data discover-by-keyword (พารามิเตอร์ `city`
// ในเอกสาร https://docs.brightdata.com/api-reference/scrapers/social-media-apis/facebook-marketplace-discover-by-keyword
// ใช้ชื่อเมืองภาษาอังกฤษตัวพิมพ์ใหญ่ตามธรรมชาติ เช่น "Bangkok" ไม่ใช่ slug — ยังไม่ยืนยัน 100% ว่า
// Bright Data รู้จักชื่อเมืองไทยทุกเมืองแม่นแค่ไหน ทดสอบผ่านปุ่ม "ทดสอบดึงข้อมูลตอนนี้" ก่อนใช้จริง
// ค่า priority เริ่มต้น: กรุงเทพฯ ตั้งเป็น "สูง" (เป็นตลาดหลักของเกือบทุกธุรกิจรถมือสอง) ที่เหลือ
// ตั้ง "ต่ำ" หมด — เพื่อยืดเครดิตฟรี Apify ให้ได้นานที่สุดโดย default (ปรับเปลี่ยนได้เองในหน้า
// settings.html ทุกจังหวัด ถ้าธุรกิจมีตลาดหลักที่จังหวัดอื่นแทน)
const DEFAULT_LOCATIONS = [
  { name: 'กรุงเทพมหานคร', query: 'bangkok', brightDataCity: 'Bangkok', enabled: true, priority: 'high' },
  { name: 'เชียงใหม่', query: 'chiangmai', brightDataCity: 'Chiang Mai', enabled: true, priority: 'low' },
  { name: 'นครราชสีมา', query: 'nakhonratchasima', brightDataCity: 'Nakhon Ratchasima', enabled: true, priority: 'low' },
  { name: 'ขอนแก่น', query: 'khonkaen', brightDataCity: 'Khon Kaen', enabled: true, priority: 'low' },
  { name: 'ชลบุรี / พัทยา', query: 'chonburi', brightDataCity: 'Chonburi', enabled: true, priority: 'low' },
  { name: 'สงขลา / หาดใหญ่', query: 'hatyai', brightDataCity: 'Hat Yai', enabled: true, priority: 'low' },
  { name: 'ภูเก็ต', query: 'phuket', brightDataCity: 'Phuket', enabled: true, priority: 'low' },
  { name: 'อุดรธานี', query: 'udonthani', brightDataCity: 'Udon Thani', enabled: true, priority: 'low' },
];

// เปิด/ปิด provider แต่ละตัวได้อิสระจากหน้า health.html — ค่าเริ่มต้น: เปิด Bright Data/Apify ให้
// อัตโนมัติถ้ามี credential ตั้งไว้ใน .env.local อยู่แล้ว (จะได้ไม่ต้องมาติ๊กเปิดเองตอน deploy ครั้งแรก)
// watcher (Puppeteer+cookies) เปิดเป็นค่าเริ่มต้นเสมอเหมือนพฤติกรรมเดิมของระบบ
function defaultProviderToggles() {
  return {
    marketplace: {
      brightdata: Boolean(process.env.BRIGHTDATA_API_TOKEN),
      apify: Boolean(process.env.APIFY_TOKEN),
      watcher: true,
    },
    group: {
      brightdata: Boolean(process.env.BRIGHTDATA_API_TOKEN),
      apify: Boolean(process.env.APIFY_TOKEN),
      watcher: true,
    },
  };
}

const DEFAULTS = {
  facebookGroups: [],          // [{ id, label, url, enabled }]
  marketplace: {
    keyword: 'รถมือสอง',
    nationwide: false,         // ปิดไว้เป็นค่าเริ่มต้น — ทั่วประเทศ = ยิงหลายจังหวัด ยิ่งเปลือง Apify credit
    singleLocation: 'bangkok',
    locations: DEFAULT_LOCATIONS,
    maxItemsPerLocation: 20,   // ลดจาก 40 → 20 ต่อรอบ เพื่อให้แต่ละรอบใช้เวลา/ CU น้อยลง
  },
  providerToggles: defaultProviderToggles(),
  updatedAt: null,
};

let cache = null;
let initialized = false;

function mergeProviderToggles(saved) {
  const defaults = defaultProviderToggles();
  const savedToggles = saved || {};
  return {
    marketplace: { ...defaults.marketplace, ...(savedToggles.marketplace || {}) },
    group: { ...defaults.group, ...(savedToggles.group || {}) },
  };
}

async function init() {
  if (initialized) return;
  const saved = await getJSON(KEY, null);
  cache = saved
    ? {
        ...DEFAULTS,
        ...saved,
        marketplace: { ...DEFAULTS.marketplace, ...(saved.marketplace || {}) },
        providerToggles: mergeProviderToggles(saved.providerToggles),
      }
    : JSON.parse(JSON.stringify(DEFAULTS));
  initialized = true;
}

function getSettings() {
  return cache;
}

async function saveSettings(patch = {}) {
  const next = {
    ...cache,
    ...patch,
    marketplace: { ...cache.marketplace, ...(patch.marketplace || {}) },
    providerToggles: patch.providerToggles ? mergeProviderToggles({ ...cache.providerToggles, ...patch.providerToggles }) : cache.providerToggles,
    updatedAt: new Date().toISOString(),
  };

  // กันข้อมูลเพี้ยน: ต้องมี label+url ทุกกลุ่ม, ตัด entry ว่างทิ้ง
  if (Array.isArray(next.facebookGroups)) {
    next.facebookGroups = next.facebookGroups
      .filter(g => g && g.url && g.url.trim())
      .map((g, i) => ({
        id: g.id || `grp_${Date.now()}_${i}`,
        label: (g.label || '').trim() || `กลุ่มที่ ${i + 1}`,
        url: g.url.trim(),
        enabled: g.enabled !== false,
        // priority คุมความถี่ในการสแกนกลุ่มนี้ (ใช้กับ Apify — ดู fbGroupApify.js) กลุ่มที่มีโพสต์
        // ใหม่บ่อยตั้งเป็น high ได้เอง — default เป็น "low" (ยืดเครดิตฟรีให้นานที่สุด) ผู้ใช้ต้อง
        // เลือกยกระดับกลุ่มหลัก 1-2 กลุ่มเป็น "high" เองในหน้า settings.html
        priority: ['high', 'normal', 'low'].includes(g.priority) ? g.priority : 'low',
      }));
  }

  cache = next;
  await setJSON(KEY, cache);
  return cache;
}

module.exports = { init, getSettings, saveSettings, DEFAULT_LOCATIONS };
