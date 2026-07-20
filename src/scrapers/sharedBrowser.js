/**
 * sharedBrowser.js — ใช้ Chrome instance เดียวกันสำหรับทั้ง Facebook Marketplace watcher และ
 * Facebook Group watcher (คนละ tab/page แต่ browser process เดียวกัน) แทนที่จะเปิด Chrome เต็มๆ
 * แยกกันคนละตัว 2 ตัว
 *
 * ทำไมถึงลด RAM ได้เยอะ: ต้นทุน RAM ส่วนใหญ่ของ Chrome อยู่ที่ตัว browser process หลักเอง
 * (renderer engine, GPU process ฯลฯ) ซึ่งเปิดครั้งเดียวใช้ร่วมกันได้ ส่วนแต่ละ tab ที่เพิ่มเข้ามาทีหลัง
 * กิน RAM เพิ่มน้อยกว่าเปิด Chrome process ใหม่ทั้งตัวมาก — สำคัญมากบน Render free tier ที่มี RAM
 * แค่ 512MB ซึ่งเปิด Chrome 2 ตัวพร้อมกันทำให้ OOM (โดน kill ทิ้งกลางคัน) มาแล้วจริง
 *
 * ใช้ reference counting (refCount) ป้องกัน watcher ตัวหนึ่งปิด browser ทิ้งทั้งที่อีกตัวยังใช้อยู่ —
 * ปิดจริงก็ต่อเมื่อไม่มี watcher ไหนใช้งานเหลืออยู่แล้วเท่านั้น (refCount กลับมาเป็น 0)
 */

require('dotenv').config({ path: '.env.local' });

let puppeteer;
try {
  puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
} catch (e) {
  throw new Error(
    'ต้องติดตั้งก่อน: npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer'
  );
}

const HEADLESS = process.env.FB_HEADLESS !== 'false';

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-networking',
  '--mute-audio',
  // ⚠️ ทางเลือกสุดท้ายถ้า RAM ยังไม่พอจริงๆ (เช่น Render free tier 512MB) — รวม browser process
  // หลักกับ renderer เข้าเป็น process เดียว ลด RAM ได้อีกก้อนใหญ่ แต่ **เสี่ยง Chrome ไม่เสถียร/
  // crash ง่ายขึ้น** (ข้อแลกเปลี่ยนที่ยอมรับได้ถ้าจำเป็นต้องประหยัด RAM สุดๆ บนเครื่องฟรี) ปิดไว้เป็น
  // default ต้องเปิดเองผ่าน env ถ้าจะลอง
  ...(process.env.PUPPETEER_SINGLE_PROCESS === 'true' ? ['--single-process'] : []),
];

// ถ้าตั้ง PUPPETEER_EXECUTABLE_PATH ไว้ (เช่น /usr/bin/chromium-browser บน ARM/Oracle Cloud ที่ต้องใช้
// Chromium ที่ระบบติดตั้งเองแทน Chrome ที่ Puppeteer ดาวน์โหลดมาให้ ซึ่งส่วนใหญ่มีแต่ build x86_64)
// จะใช้ตัวนั้นแทน — ถ้าไม่ตั้งไว้ (undefined) Puppeteer จะใช้ Chrome ที่ดาวน์โหลดมาเองตามปกติ
const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

let sharedBrowser = null;
let launchPromise = null; // กัน race condition ถ้า watcher ทั้ง 2 ตัวเรียกพร้อมกันตอนยังไม่มี browser
let refCount = 0;

// บล็อกการโหลดรูป/วิดีโอ/ฟอนต์/สไตล์ชีต (ปรับ resource type ที่จะบล็อกได้ผ่าน blockTypes) —
// Facebook Marketplace/Group เป็นหน้าที่โหลดรูปภาพเยอะมาก (กิน RAM เยอะสุดในบรรดา resource ทั้งหมด
// ที่หน้าเว็บโหลด) แต่เราไม่ได้ต้องการให้ Puppeteer render รูปจริงเลย แค่ต้องการ URL ของรูป ซึ่งอยู่ใน
// HTML/DOM (attribute src) อยู่แล้วไม่ว่าจะโหลดรูปจริงสำเร็จหรือไม่ก็ตาม — บล็อกแล้วไม่กระทบการดึง
// ข้อมูลเลย แต่ลด RAM ต่อ tab ได้เยอะมาก (สำคัญบน Render free tier 512MB ที่เจอปัญหา OOM จริง)
//
// ⚠️ ค่า default ไม่บล็อก "stylesheet" เพราะบางหน้า (เช่น one2car.js) ต้องพึ่ง computed style ของ
// CSS จริง (เช่น background-image ที่มาจาก class ไม่ใช่ inline style) ถ้าบล็อก stylesheet ไปด้วย
// CSS จะไม่ถูกอ่านค่าเลย ทำให้ตรวจับ background-image ไม่ได้ — หน้าที่ไม่ต้องพึ่ง CSS computed style
// (เช่น Facebook watcher ที่อ่านจาก attribute ตรงๆ) ส่ง blockTypes เพิ่ม 'stylesheet' เข้าไปเองได้
async function optimizePage(page, blockTypes = ['image', 'media', 'font']) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (blockTypes.includes(type)) {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    refCount += 1;
    return sharedBrowser;
  }
  // มีอีก watcher กำลัง launch อยู่พอดี (เรียกมาก่อนแล้ว) — รอตัวเดียวกัน ไม่ launch ซ้ำสอง process
  if (launchPromise) {
    const browser = await launchPromise;
    refCount += 1;
    return browser;
  }

  launchPromise = puppeteer.launch({ headless: HEADLESS, args: LAUNCH_ARGS, executablePath: EXECUTABLE_PATH });
  try {
    sharedBrowser = await launchPromise;
    sharedBrowser.on('disconnected', () => {
      // Chrome ปิดตัวเอง/crash โดยไม่ผ่าน releaseSharedBrowser() — reset state ไว้ launch ใหม่ได้
      sharedBrowser = null;
      refCount = 0;
    });
    refCount += 1;
    return sharedBrowser;
  } finally {
    launchPromise = null;
  }
}

// เรียกตอน watcher ตัวใดตัวหนึ่งเลิกใช้ browser (ใน stop()) — ปิด Chrome จริงๆ ก็ต่อเมื่อไม่มี watcher
// ไหนใช้งานเหลืออยู่แล้ว (refCount ลงมาเป็น 0)
async function releaseSharedBrowser() {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && sharedBrowser) {
    const b = sharedBrowser;
    sharedBrowser = null;
    await b.close().catch(() => {});
  }
}

module.exports = { getSharedBrowser, releaseSharedBrowser, optimizePage };
