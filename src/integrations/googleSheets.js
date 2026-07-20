/**
 * googleSheets.js — เก็บประกาศรถลง Google Sheet
 *
 * ติดตั้งก่อนใช้งาน: npm install googleapis
 *
 * ขั้นตอนตั้งค่า (ทำครั้งเดียว):
 * 1. ไป https://console.cloud.google.com/ สร้างโปรเจกต์ (หรือใช้ของเดิม)
 * 2. เปิดใช้งาน "Google Sheets API"
 * 3. สร้าง Service Account → สร้างคีย์แบบ JSON → ดาวน์โหลดมาเก็บไว้
 * 4. เปิด Google Sheet ที่จะใช้เก็บข้อมูล → กด Share → แชร์ให้กับอีเมลของ Service Account
 *    (อีเมลจะอยู่ในไฟล์ JSON ช่อง "client_email") ให้สิทธิ์ Editor
 * 5. คัดลอก Spreadsheet ID จาก URL ของ Google Sheet
 *    เช่น https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit
 *
 * มี 2 วิธีตั้งค่า credentials — ใช้อย่างใดอย่างหนึ่ง:
 *
 * (แนะนำสำหรับ deploy บน Render/hosting ฟรีที่ไม่มี persistent disk)
 * A) แปลงไฟล์ JSON ทั้งไฟล์เป็น base64 แล้ววางใส่ env var เดียว:
 *      base64 -i google-service-account.json | tr -d '\n'
 *    เอาผลลัพธ์มาใส่ GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 ใน .env.local หรือ Environment ของ Render
 *
 * (สำหรับรันบนเครื่องตัวเองระหว่างพัฒนา)
 * B) เก็บไฟล์ไว้ในเครื่อง แล้วชี้ path ผ่าน GOOGLE_SERVICE_ACCOUNT_PATH
 */

const fs = require('fs');
require('dotenv').config({ path: '.env.local' });

let google;
try {
  ({ google } = require('googleapis'));
} catch (e) {
  throw new Error('ต้องติดตั้ง googleapis ก่อน: npm install googleapis');
}

const KEY_PATH   = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './google-service-account.json';
const KEY_BASE64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB  = process.env.GOOGLE_SHEET_TAB || 'Listings';

let sheetsClient = null;

function loadCredentials() {
  if (KEY_BASE64) {
    try {
      return JSON.parse(Buffer.from(KEY_BASE64, 'base64').toString('utf-8'));
    } catch (e) {
      throw new Error('ถอดรหัส GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 ไม่สำเร็จ — เช็คว่า copy มาครบและไม่มีช่องว่างแทรก');
    }
  }
  if (fs.existsSync(KEY_PATH)) {
    return JSON.parse(fs.readFileSync(KEY_PATH, 'utf-8'));
  }
  throw new Error(
    `ไม่พบ Google credentials — ตั้งค่า GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 (แนะนำสำหรับ deploy) ` +
    `หรือวางไฟล์ไว้ที่ ${KEY_PATH} (สำหรับรันในเครื่อง) ดูขั้นตอนในคอมเมนต์ด้านบนไฟล์นี้`
  );
}

async function getClient() {
  if (sheetsClient) return sheetsClient;
  if (!SHEET_ID) throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_SHEET_ID ใน .env.local');

  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// เพิ่มแถวใหม่ต่อท้าย sheet ทีเดียวหลายรายการ (ประหยัด quota กว่าเรียกทีละแถว)
async function appendListings(listings) {
  if (!listings || listings.length === 0) return;

  const sheets = await getClient();
  const rows = listings.map(l => [
    l.scrapedAt || new Date().toISOString(),
    l.source || '',
    l.title || '',
    l.price || '',
    l.url || '',
    l.image || '',
    l.groupLabel || '',
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:G`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

// เรียกครั้งแรกตอนเริ่มระบบ เพื่อใส่หัวตารางถ้ายังไม่มี
async function ensureHeader() {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:G1`,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['เวลาที่ดึง', 'แหล่งที่มา', 'ชื่อประกาศ', 'ราคา', 'ลิงก์', 'รูปภาพ', 'ชื่อกลุ่ม (ถ้ามี)']] },
    });
  }
}

// ใช้โดยหน้าสถานะการเชื่อมต่อ — ทดสอบว่าอ่านข้อมูล spreadsheet ได้จริงไหม (ไม่ได้แค่เช็คว่ามี env var)
async function checkConnection() {
  if (!SHEET_ID) return { ok: null, message: 'ยังไม่ได้ตั้งค่า GOOGLE_SHEET_ID' };
  try {
    const sheets = await getClient();
    const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    return { ok: true, message: `เชื่อมต่อ Google Sheet OK ("${res.data.properties?.title || SHEET_ID}")` };
  } catch (e) {
    const status = e.response?.status || e.code;
    if (status === 403 || status === 404) {
      return { ok: false, message: 'เข้าถึง Sheet ไม่ได้ — เช็คว่าแชร์สิทธิ์ Editor ให้อีเมล Service Account แล้วหรือยัง' };
    }
    return { ok: false, message: e.message };
  }
}

module.exports = { appendListings, ensureHeader, checkConnection };
