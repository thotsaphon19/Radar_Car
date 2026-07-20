/**
 * redisStore.js — ตัวช่วยเก็บข้อมูลถาวรผ่าน Upstash Redis (REST API)
 * ใช้แทนการเขียนไฟล์ลงดิสก์ เพราะ hosting ฟรีหลายเจ้า (เช่น Render free tier)
 * ไม่มี persistent disk ให้ใช้ — ไฟล์ที่เขียนไว้จะหายทุกครั้งที่ deploy ใหม่หรือ service รีสตาร์ท
 *
 * ขั้นตอนตั้งค่า (ทำครั้งเดียว, ฟรีไม่ต้องใช้บัตรเครดิต):
 * 1. สมัคร https://upstash.com
 * 2. สร้าง Redis database ใหม่ (เลือกแบบ Regional ธรรมดาพอ ไม่ต้อง Global)
 * 3. ในหน้า database คัดลอก "REST URL" และ "REST TOKEN"
 *
 * ตั้งค่าใน .env.local:
 *   UPSTASH_REDIS_REST_URL=https://xxxxx.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN=xxxxxxxx
 *
 * ติดตั้งก่อนใช้งาน: npm install @upstash/redis
 *
 * Free tier ของ Upstash ให้ 500,000 คำสั่ง/เดือน (256MB) — ระบบนี้ใช้ไม่ถึง 1% ของโควตานี้
 * เพราะอ่านแค่ตอนเปิดเซิร์ฟเวอร์ครั้งเดียว แล้วเขียนเฉพาะตอนมีการเปลี่ยนแปลงจริงเท่านั้น
 */

const { Redis } = require('@upstash/redis');
require('dotenv').config({ path: '.env.local' });

let client = null;
function getClient() {
  if (client) return client;

  // ตัดช่องว่าง/ขึ้นบรรทัดใหม่/เครื่องหมายคำพูดที่ครอบอยู่ทิ้ง — กันปัญหา copy-paste พลาด
  // (เจอบ่อยมาก: ติด " ครอบ หรือมี \n ท้ายบรรทัดติดมาจากการ copy จากเว็บ/เอกสาร ทำให้ token ผิดทั้งที่
  // ค่าดูถูกต้องตอนมองด้วยตา)
  const sanitize = (v) => (v || '').trim().replace(/^["']|["']$/g, '');
  const url = sanitize(process.env.UPSTASH_REDIS_REST_URL);
  const token = sanitize(process.env.UPSTASH_REDIS_REST_TOKEN);

  if (!url || !token) {
    throw new Error('ยังไม่ได้ตั้งค่า UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN ใน .env.local');
  }
  client = new Redis({ url, token });
  return client;
}

// เก็บสถานะว่าการเขียนลง Redis ล่าสุดสำเร็จไหม — ใช้โชว์แบนเนอร์เตือนบนหน้าเว็บโดยตรง
// (ปัญหา token ผิด/ไม่มีสิทธิ์เขียน เป็นปัญหาที่เจอบ่อยและมองข้ามง่ายถ้าดูแค่ log ในเทอร์มินัล)
let writeHealth = { ok: true, lastError: null, lastCheckedAt: null };
function getWriteHealth() {
  return writeHealth;
}

// โชว์ตัวอย่าง token/URL แบบปิดบังบางส่วน (ไม่โชว์เต็ม กันหลุดซ้ำ) ให้เทียบกับหน้า Upstash ได้เอง
// โดยไม่ต้องส่ง screenshot ไปมา — เรียกครั้งเดียวตอนเริ่มเซิร์ฟเวอร์
function logConfigPreview() {
  const sanitize = (v) => (v || '').trim().replace(/^["']|["']$/g, '');
  const url = sanitize(process.env.UPSTASH_REDIS_REST_URL);
  const token = sanitize(process.env.UPSTASH_REDIS_REST_TOKEN);
  const maskMiddle = (s, keep = 6) =>
    !s ? '(ว่างเปล่า — ยังไม่ได้ตั้งค่า)' : s.length <= keep * 2 ? s : `${s.slice(0, keep)}...${s.slice(-keep)} (ยาว ${s.length} ตัวอักษร)`;
  console.log(`🔍 [redisStore] UPSTASH_REDIS_REST_URL ที่ใช้จริง: ${maskMiddle(url, 20)}`);
  console.log(`🔍 [redisStore] UPSTASH_REDIS_REST_TOKEN ที่ใช้จริง: ${maskMiddle(token)}`);
  console.log(`   ↳ เอาไปเทียบกับค่าในหน้า Upstash Dashboard ตัวอักษรแรก/ท้ายควรตรงกันเป๊ะ`);
}

async function getJSON(key, fallback) {
  try {
    const val = await getClient().get(key);
    if (val === null || val === undefined) return fallback;
    return typeof val === 'string' ? JSON.parse(val) : val;
  } catch (e) {
    console.log(`⚠️ อ่านค่า "${key}" จาก Redis ไม่สำเร็จ: ${e.message} — ใช้ค่าเริ่มต้นแทน`);
    return fallback;
  }
}

async function setJSON(key, value) {
  try {
    await getClient().set(key, JSON.stringify(value));
    writeHealth = { ok: true, lastError: null, lastCheckedAt: new Date().toISOString() };
  } catch (e) {
    console.log(`⚠️ บันทึกค่า "${key}" ลง Redis ไม่สำเร็จ: ${e.message}`);
    writeHealth = { ok: false, lastError: e.message, lastCheckedAt: new Date().toISOString() };
  }
}

module.exports = { getJSON, setJSON, getWriteHealth, logConfigPreview };
