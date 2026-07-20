/**
 * lineMessaging.js — แจ้งเตือนเข้า LINE เมื่อเจอรถใหม่
 *
 * ⚠️ สำคัญ: LINE Notify ปิดให้บริการถาวรตั้งแต่ 31 มี.ค. 2568 ใช้ไม่ได้แล้ว
 * ไฟล์นี้ใช้ LINE Messaging API (ตัวที่ LINE แนะนำให้ใช้แทน) ผ่าน Push API
 *
 * ขั้นตอนตั้งค่า (ทำครั้งเดียว):
 * 1. ไป https://developers.line.biz/console/ สร้าง Provider + Messaging API Channel
 * 2. ในหน้า Channel → แท็บ "Messaging API" → คัดลอก "Channel access token"
 *    (กด Issue ถ้ายังไม่มี)
 * 3. หาว่าจะส่งแจ้งเตือนไปที่ไหน:
 *    - ส่งเข้าแชทส่วนตัว: เพิ่มเพื่อน LINE Official Account ของ Channel นี้ก่อน
 *      แล้วดู userId จาก webhook event (ต้องตั้ง webhook รับ event ก่อนถึงจะรู้ userId ของตัวเอง)
 *    - ส่งเข้ากลุ่ม LINE: เชิญ Official Account เข้ากลุ่ม แล้วดู groupId จาก webhook เช่นกัน
 *    - ทางลัดที่ง่ายกว่า: ใช้ LINE Official Account Manager > Broadcast แทน หรือใช้บริการ
 *      อย่าง LINE Notify Alternative (Messaging API wrapper) ที่ทำ webhook ให้สำเร็จรูป
 *
 * ตั้งค่าใน .env.local:
 *   LINE_CHANNEL_ACCESS_TOKEN=xxxxxxxx
 *   LINE_TARGET_ID=Uxxxxxxxx   (userId หรือ groupId ที่จะส่งแจ้งเตือนไปหา)
 *
 * ติดตั้งก่อนใช้งาน: npm install axios
 */

require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const TARGET_ID      = process.env.LINE_TARGET_ID;
const PUSH_URL       = 'https://api.line.me/v2/bot/message/push';

function formatMessage(listing) {
  const priceText = listing.price ? `${Number(listing.price).toLocaleString('th-TH')} บาท` : 'ไม่ระบุราคา';
  return `🚗 รถใหม่เข้า!\n${listing.title}\n💰 ${priceText}\n📍 แหล่งที่มา: ${listing.source}\n🔗 ${listing.url}`;
}

async function notifyNewListing(listing) {
  if (!CHANNEL_TOKEN || !TARGET_ID) {
    console.log('⚠️ ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN / LINE_TARGET_ID — ข้ามการแจ้งเตือน LINE');
    return;
  }

  try {
    await axios.post(
      PUSH_URL,
      {
        to: TARGET_ID,
        messages: [{ type: 'text', text: formatMessage(listing) }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CHANNEL_TOKEN}`,
        },
        timeout: 10000,
      }
    );
  } catch (e) {
    console.log(`❌ ส่ง LINE ไม่สำเร็จ: ${e.response?.data?.message || e.message}`);
  }
}

// ส่งสรุปรวมหลายคันในข้อความเดียว (ใช้ตอนเจอพร้อมกันหลายคัน กัน spam แจ้งเตือน)
async function notifyBatch(listings) {
  if (!listings || listings.length === 0) return;
  if (listings.length === 1) return notifyNewListing(listings[0]);

  if (!CHANNEL_TOKEN || !TARGET_ID) {
    console.log('⚠️ ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN / LINE_TARGET_ID — ข้ามการแจ้งเตือน LINE');
    return;
  }

  const lines = listings
    .slice(0, 10) // LINE จำกัดความยาวข้อความ กันข้อความยาวเกินไปถ้าเจอเยอะมาก
    .map(l => `• ${l.title} — ${l.price ? Number(l.price).toLocaleString('th-TH') + ' บาท' : '-'} (${l.source})`)
    .join('\n');
  const more = listings.length > 10 ? `\n...และอีก ${listings.length - 10} คัน` : '';
  const text = `🚗 พบรถใหม่ ${listings.length} คัน\n\n${lines}${more}`;

  try {
    await axios.post(
      PUSH_URL,
      { to: TARGET_ID, messages: [{ type: 'text', text }] },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHANNEL_TOKEN}` }, timeout: 10000 }
    );
  } catch (e) {
    console.log(`❌ ส่ง LINE ไม่สำเร็จ: ${e.response?.data?.message || e.message}`);
  }
}

module.exports = { notifyNewListing, notifyBatch };
