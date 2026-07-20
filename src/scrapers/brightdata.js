/**
 * brightdata.js — ตัวช่วยกลางเรียก Bright Data Dataset API
 * เอกสารทางการ: https://docs.brightdata.com/datasets/scrapers/facebook/introduction
 *
 * มี 2 โหมดการเรียก:
 *  - scrapeSync()     ใช้ endpoint /scrape (ได้ผลลัพธ์ทันทีในคำขอเดียว เหมาะกับงานเล็ก ≤20 URL/keyword)
 *  - triggerAndPoll() ใช้ endpoint /trigger + /snapshot (async: ยิงคำขอ แล้ว poll รอผลลัพธ์
 *                      พร้อม — จำเป็นสำหรับ dataset บางตัวอย่าง Facebook Groups)
 */

const axios = require('axios');
require('dotenv').config({ path: '.env.local' });

const API_TOKEN = process.env.BRIGHTDATA_API_TOKEN;

function authHeaders() {
  if (!API_TOKEN) throw new Error('ยังไม่ได้ตั้งค่า BRIGHTDATA_API_TOKEN ใน .env.local');
  return { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' };
}

/**
 * scrapeSync(datasetId, inputArray, opts)
 *   opts.extraParams   — query string เพิ่มเติมนอกจาก dataset_id/include_errors
 *                         (เช่น { notify: 'false', type: 'discover_new', discover_by: 'keyword' }
 *                         ที่จำเป็นสำหรับ Facebook Marketplace "discover by keyword")
 *   opts.limitPerInput  — ใส่ body.limit_per_input ถ้าต้องการจำกัดจำนวนผลลัพธ์ต่อ input (ไม่ใส่ = ไม่จำกัด)
 */
async function scrapeSync(datasetId, inputArray, opts = {}) {
  const { extraParams = {}, limitPerInput = null } = opts;
  const params = new URLSearchParams({ dataset_id: datasetId, include_errors: 'true', ...extraParams });
  const url = `https://api.brightdata.com/datasets/v3/scrape?${params.toString()}`;
  // curl ที่ทดสอบยืนยันแล้ว (ทั้ง Marketplace และ Group) ส่ง "limit_per_input": null เสมอในตัว body
  // เลยส่งแบบเดียวกันเป็นค่า default แทนที่จะละไว้เฉยๆ
  const body = { input: inputArray, limit_per_input: limitPerInput };
  try {
    const { data } = await axios.post(url, body, { headers: authHeaders(), timeout: 90000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    const msg = e.response?.data?.error || e.response?.data?.message || JSON.stringify(e.response?.data) || e.message;
    // เช็คว่า error นี้เกี่ยวกับบัญชี/เครดิต/งบประมาณหมดไหม (รวม "Customer is not active" ที่เจอจริง)
    // ถ้าใช่ ติด flag ไว้ให้ server.js เห็น จะได้ auto-enable Watcher (ฟรี) ให้อัตโนมัติเหมือน Apify
    const err = new Error(`Bright Data (dataset ${datasetId}) ล้มเหลว: ${msg}`);
    err.isCreditExhausted = /insufficient|not enough|exceed.*(budget|limit|usage)|account balance|out of credit|quota exceeded|not active|inactive|suspend/i.test(String(msg));
    throw err;
  }
}

async function triggerAndPoll(datasetId, inputArray, opts = {}) {
  const { maxAttempts = 60, pollIntervalMs = 3000 } = opts;
  const triggerUrl = `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${encodeURIComponent(datasetId)}&format=json`;

  let snapshotId;
  try {
    const { data } = await axios.post(triggerUrl, inputArray, { headers: authHeaders(), timeout: 30000 });
    snapshotId = data?.snapshot_id;
  } catch (e) {
    const msg = e.response?.data?.error || e.response?.data?.message || JSON.stringify(e.response?.data) || e.message;
    throw new Error(`Bright Data trigger (dataset ${datasetId}) ล้มเหลว: ${msg}`);
  }
  if (!snapshotId) throw new Error('Bright Data ไม่คืน snapshot_id มา — เช็ค dataset_id ว่าถูกต้องไหมในหน้า Bright Data');

  for (let i = 0; i < maxAttempts; i++) {
    const { data: snap } = await axios.get(
      `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`,
      { headers: authHeaders(), timeout: 30000 }
    );
    if (Array.isArray(snap)) return snap; // ผลลัพธ์พร้อมแล้ว
    if (snap?.status && ['running', 'building'].includes(snap.status)) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      continue;
    }
    return []; // สถานะ error/อื่นๆ — คืนค่าว่างแทนที่จะค้าง
  }
  throw new Error('รอผลลัพธ์จาก Bright Data นานเกินไป (timeout) — อาจต้องเพิ่ม maxAttempts');
}

module.exports = { scrapeSync, triggerAndPoll };
