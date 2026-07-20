/**
 * leadsStore.js — เก็บรายการ "รถที่ต้องการ" ที่พนักงานกดบันทึกไว้จากแดชบอร์ด ถาวรผ่าน Upstash Redis
 * แต่ละคันมีสถานะติดตามได้ (สนใจ → ติดต่อแล้ว → กำลังเจรจา → ซื้อแล้ว / ไม่เอา)
 */

const { getJSON, setJSON } = require('./redisStore');

const KEY = 'car-radar:leads';

const STATUSES = ['interested', 'contacted', 'negotiating', 'purchased', 'rejected'];
const STATUS_LABELS = {
  interested: 'สนใจ',
  contacted: 'ติดต่อแล้ว',
  negotiating: 'กำลังเจรจา',
  purchased: 'ซื้อแล้ว',
  rejected: 'ไม่เอา',
};

let leads = [];
let initialized = false;

async function init() {
  if (initialized) return;
  leads = await getJSON(KEY, []);
  initialized = true;
}

function listLeads() {
  return [...leads].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// เพิ่มใหม่ หรืออัปเดตถ้ามี url นี้อยู่แล้ว (upsert)
async function upsertLead(data, byUser) {
  if (!data || !data.url) throw new Error('ต้องมี url ของประกาศ');
  const idx = leads.findIndex(l => l.url === data.url);

  const base = idx >= 0 ? leads[idx] : {
    url: data.url,
    title: data.title || '',
    price: data.price || null,
    image: data.image || null,
    source: data.source || '',
    note: '',
    status: 'interested',
    createdAt: new Date().toISOString(),
  };

  const updated = {
    ...base,
    ...(data.title ? { title: data.title } : {}),
    ...(data.price !== undefined ? { price: data.price } : {}),
    ...(data.image ? { image: data.image } : {}),
    ...(data.status && STATUSES.includes(data.status) ? { status: data.status } : {}),
    ...(data.note !== undefined ? { note: data.note } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: byUser || base.updatedBy || null,
  };

  if (idx >= 0) leads[idx] = updated;
  else leads.push(updated);

  await setJSON(KEY, leads);
  return updated;
}

async function removeLead(url) {
  leads = leads.filter(l => l.url !== url);
  await setJSON(KEY, leads);
}

module.exports = { init, listLeads, upsertLead, removeLead, STATUSES, STATUS_LABELS };
