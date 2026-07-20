/**
 * targetModels.js — รายชื่อรุ่นรถที่ต้องการดึง/กรองเฉพาะ (ตามที่ลูกค้าระบุ: รถกระบะ + SUV/PPV
 * ที่เจอบ่อย) ใช้ร่วมกันทุกแหล่งข้อมูล (Bright Data, Apify, Watcher/Puppeteer, One2Car, Kaidee):
 *
 *  - แหล่งที่ค้นหาด้วย keyword ได้จริง (Bright Data discover-by-keyword, Apify marketplaceQueries)
 *    → ใช้ SEARCH_KEYWORDS (คำกว้างๆ ระดับ "ยี่ห้อ+รุ่นหลัก" ต่อ 1 คำ ลดจำนวนคำค้นหาลง เพราะรุ่นย่อย
 *    เช่น Hilux Revo/Rocco/Vigo/Champ ค้นด้วยคำว่า "Toyota Hilux" คำเดียวก็เจอครอบคลุมอยู่แล้ว)
 *  - แหล่งที่ดึงประกาศทุกคันมาก่อนแล้วต้องกรองเอาเฉพาะรุ่นที่ต้องการทีหลัง (One2Car, Kaidee,
 *    Facebook Group ทุกโหมด, Facebook Marketplace โหมด watcher/Puppeteer)
 *    → ใช้ matchesTargetModel(title) เทียบกับ ALIAS ทุกรุ่นย่อยที่ลูกค้าระบุมาจริงๆ (ละเอียดกว่า
 *    SEARCH_KEYWORDS เพราะต้องกันรุ่นที่ไม่เกี่ยวข้องหลุดเข้ามาปนในผลลัพธ์)
 */

const MODELS = [
  // ---- รถกระบะ (Pickup) ----
  {
    brand: 'Toyota', model: 'Hilux', category: 'pickup',
    searchKeyword: 'Toyota Hilux',
    aliases: ['hilux revo', 'hilux rocco', 'hilux vigo', 'hilux champ', 'hilux', 'ไฮลักซ์'],
  },
  {
    brand: 'Isuzu', model: 'D-Max', category: 'pickup',
    searchKeyword: 'Isuzu D-Max',
    aliases: ['d-max', 'dmax', 'd max', 'ดีแม็กซ์', 'ดีแมกซ์'],
  },
  {
    brand: 'Ford', model: 'Ranger', category: 'pickup',
    searchKeyword: 'Ford Ranger',
    aliases: ['ranger raptor', 'ranger', 'เรนเจอร์'],
  },
  {
    brand: 'Mitsubishi', model: 'Triton', category: 'pickup',
    searchKeyword: 'Mitsubishi Triton',
    aliases: ['triton', 'strada', 'ไทรทัน'],
  },
  {
    brand: 'Nissan', model: 'Navara', category: 'pickup',
    searchKeyword: 'Nissan Navara',
    aliases: ['navara', 'frontier', 'นาวารา'],
  },
  {
    brand: 'Mazda', model: 'BT-50', category: 'pickup',
    searchKeyword: 'Mazda BT-50',
    aliases: ['bt-50', 'bt50', 'bt 50'],
  },
  {
    brand: 'Chevrolet', model: 'Colorado', category: 'pickup',
    searchKeyword: 'Chevrolet Colorado',
    aliases: ['colorado', 'โคโลราโด'],
  },
  {
    brand: 'MG', model: 'Extender', category: 'pickup',
    searchKeyword: 'MG Extender',
    aliases: ['extender', 'เอ็กซ์เทนเดอร์'],
  },
  // ---- รถ SUV / PPV ที่เจอบ่อย ----
  {
    brand: 'Toyota', model: 'Fortuner', category: 'suv_ppv',
    searchKeyword: 'Toyota Fortuner',
    aliases: ['fortuner', 'ฟอร์จูนเนอร์'],
  },
  {
    brand: 'Isuzu', model: 'MU-X', category: 'suv_ppv',
    searchKeyword: 'Isuzu MU-X',
    aliases: ['mu-x', 'mux', 'mu x', 'mu-7', 'mu7', 'mu 7', 'มิว-เอ็กซ์', 'มิวเอ็กซ์', 'มิว-7', 'มิว7'],
  },
  {
    brand: 'Ford', model: 'Everest', category: 'suv_ppv',
    searchKeyword: 'Ford Everest',
    aliases: ['everest', 'เอเวอเรสต์'],
  },
  {
    brand: 'Nissan', model: 'Terra', category: 'suv_ppv',
    searchKeyword: 'Nissan Terra',
    aliases: ['terra', 'เทอร์ร่า', 'เทอร์รา'],
  },
];

// คำค้นหาสำหรับ provider ที่ยิง keyword ตรงๆ ได้ (Bright Data / Apify) — 1 คำต่อ 1 รุ่นหลัก
const SEARCH_KEYWORDS = MODELS.map(m => m.searchKeyword);

// alias ทุกตัวรวมกัน (ครอบคลุมรุ่นย่อยทั้งหมด) ใช้กับ matchesTargetModel()
const ALL_ALIASES = MODELS.flatMap(m => m.aliases);

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\-]+/g, ' ')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// เช็คว่า title นี้เข้าข่ายรุ่นที่ต้องการไหม — ใช้ regex ขอบเขตคำ (word boundary) กันจับผิดจากคำ
// ที่บังเอิญมีตัวอักษรพ้องกัน (เช่น "extender"/"terra"/"colorado" ที่เป็นคำสามัญด้วย)
function matchesTargetModel(title) {
  const t = normalize(title);
  if (!t) return false;
  return ALL_ALIASES.some(alias => {
    const pattern = new RegExp(`(^|[^a-z0-9ก-๙])${escapeRegExp(normalize(alias))}([^a-z0-9ก-๙]|$)`, 'i');
    return pattern.test(t);
  });
}

module.exports = { MODELS, SEARCH_KEYWORDS, ALL_ALIASES, matchesTargetModel };
