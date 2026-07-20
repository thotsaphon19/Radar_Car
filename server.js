/**
 * server.js — ตัวรันหลัก (ฉบับใช้ hosting ฟรีได้เต็มรูปแบบ ไม่พึ่ง WebSocket / persistent disk)
 * ทำหน้าที่ 3 อย่างในโปรเซสเดียว:
 *   1. ดึงรถจากทุกแหล่ง (Facebook Marketplace/Group, One2Car, Kaidee)
 *   2. เก็บสถานะ + ประกาศล่าสุดไว้ในหน่วยความจำ แล้วส่งต่อ backend เดิม / Google Sheet / LINE
 *   3. เสิร์ฟหน้าเว็บแดชบอร์ด — หน้าเว็บอัปเดตด้วยการ "โพล" (เรียก API ซ้ำเป็นระยะ) แทน WebSocket
 *      เพื่อให้ deploy บน hosting ฟรีที่ไม่รองรับ WebSocket ค้างได้ (เช่น Render free tier)
 *
 * ข้อมูลถาวร (ผู้ใช้/ตั้งค่า/รถที่ต้องการ/รายการที่เคยเห็นแล้ว) เก็บผ่าน Upstash Redis
 * แทนการเขียนไฟล์ลงดิสก์ เพราะ hosting ฟรีส่วนใหญ่ไม่มี persistent disk ให้ (ดู src/redisStore.js)
 *
 * ติดตั้งก่อนใช้งาน:
 *   npm install express express-session bcryptjs @upstash/redis axios cheerio puppeteer rss-parser googleapis
 *
 * รัน: node server.js
 * เปิดดูแดชบอร์ด: http://localhost:3000
 *
 * ⚠️ ถ้า deploy บน Render free tier: service จะ "หลับ" เมื่อไม่มีคนเข้าเว็บ 15 นาที ทำให้ loop ดึงข้อมูล
 *    เบื้องหลังหยุดไปด้วย ต้องตั้ง external pinger (เช่น cron-job.org หรือ UptimeRobot ฟรี) ให้ยิง
 *    request มาที่ URL ของเว็บทุก 10 นาที เพื่อกันไม่ให้ service หลับ
 */

require('dotenv').config({ path: '.env.local' });
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const axios = require('axios');

// ---- ดักจับ console.log/console.error ทุกครั้งที่เรียก เก็บไว้ในหน่วยความจำ (ring buffer) เพื่อให้
// หน้าเว็บ /logs.html ดึงไปแสดงแบบ live ได้ — ไม่ต้องเข้า Render dashboard/SSH เพื่อดู log อีกต่อไป
// วางไว้บนสุดของไฟล์ (ก่อน require อื่นๆ ที่อาจ log ตอน init) เพื่อจับ log ให้ได้ครบตั้งแต่ต้น
// ⚠️ อยู่ในหน่วยความจำเท่านั้น (ไม่ persist ผ่าน Redis) — รีสตาร์ทเซิร์ฟเวอร์แล้ว log เก่าหายเป็นปกติ
// (เหมือน log บน Render dashboard เองที่ก็หายตอน restart เหมือนกัน ไม่ใช่พฤติกรรมแปลกใหม่)
const LOG_BUFFER_MAX = 1000;
const logBuffer = [];
let logSeq = 0;
function pushLog(level, args) {
  const line = args
    .map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    })
    .join(' ');
  logSeq += 1;
  logBuffer.push({ seq: logSeq, ts: new Date().toISOString(), level, line });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}
const _origConsoleLog = console.log.bind(console);
const _origConsoleError = console.error.bind(console);
console.log = (...args) => { pushLog('log', args); _origConsoleLog(...args); };
console.error = (...args) => { pushLog('error', args); _origConsoleError(...args); };

const authStore = require('./src/authStore');
const leadsStore = require('./src/leadsStore');
const settingsStore = require('./src/settingsStore');
const healthCheck = require('./src/healthCheck');
const { getJSON, setJSON, getWriteHealth, logConfigPreview } = require('./src/redisStore');

const { FbWatcher, fetchSingleListing } = require('./src/scrapers/fbWatcher');
const { FbGroupWatcher } = require('./src/scrapers/fbGroupWatcher');
const { scrapeFacebookRSS } = require('./src/scrapers/facebookRSS');
const { scrapeMarketplaceViaApify, testMarketplaceSearch, mapItem: mapMarketplaceApifyItem } = require('./src/scrapers/fbMarketplaceApify');
const { scrapeGroupViaApify, mapItem: mapGroupApifyItem, extractGroupId } = require('./src/scrapers/fbGroupApify');
const { scrapeMarketplaceViaBrightData, testMarketplaceSearch: testMarketplaceSearchBrightData } = require('./src/scrapers/fbMarketplaceBrightData');
const { scrapeGroupViaBrightData } = require('./src/scrapers/fbGroupBrightData');
const { scrapeOne2Car } = require('./src/scrapers/one2car');
const { scrapeKaidee } = require('./src/scrapers/kaidee');
const { discoverGroups } = require('./src/scrapers/fbDiscovery');
const { appendListings, ensureHeader } = require('./src/integrations/googleSheets');
const { notifyBatch } = require('./src/integrations/lineMessaging');
const { matchesTargetModel } = require('./src/targetModels');

// ใช้เช็คว่า provider แต่ละตัวมี credential พร้อมใช้งานจริงไหม (ไม่ได้แปลว่า "เปิดใช้งานอยู่" —
// เปิด/ปิดจริงคุมผ่าน settingsStore.providerToggles ที่แก้ได้จากปุ่มในหน้า health.html)
const USE_APIFY = Boolean(process.env.APIFY_TOKEN);
// ทั้ง Marketplace และ Group ตอนนี้มี checkpoint/priority self-throttle ของตัวเองแล้ว (ดู
// fbMarketplaceApify.js/fbGroupApify.js) — ตัวแปรด้านล่างนี้เป็นแค่ "ความถี่ในการเช็คว่ามีอะไรครบ
// กำหนดสแกนใหม่บ้าง" ไม่ใช่ความถี่สแกนจริงอีกต่อไป ตั้งถี่ได้อย่างปลอดภัย (เช่น 60000 = เช็คทุก 1 นาที)
// ความถี่สแกนจริงคุมด้วย priority (high/normal/low) ต่อกลุ่ม/พื้นที่ ที่ตั้งได้ในหน้า settings.html
const APIFY_POLL_INTERVAL_MS = Number(process.env.APIFY_POLL_INTERVAL_MS || 5 * 60 * 1000); // 5 นาที (ใช้ทั้ง Marketplace และ Group ได้อย่างปลอดภัยแล้ว)
const BRIGHTDATA_POLL_INTERVAL_MS = Number(process.env.BRIGHTDATA_POLL_INTERVAL_MS || 5 * 60 * 1000); // 5 นาที

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'เปลี่ยนค่านี้ใน .env.local ด้วย-' + Math.random().toString(36);
const RENDER_URL = process.env.RENDER_URL || null; // ไม่ fallback ไปเดา URL เก่าอีกต่อไป — ว่าง = ข้ามการส่งไป backend เดิม
const SYNC_SECRET = process.env.SYNC_SECRET || 'sync-secret-key';

const ONE2CAR_INTERVAL_MS = Number(process.env.ONE2CAR_INTERVAL_MS || 20000);
const KAIDEE_INTERVAL_MS = Number(process.env.KAIDEE_INTERVAL_MS || 20000);
const RSS_INTERVAL_MS = Number(process.env.RSS_INTERVAL_MS || 60000);

const SOURCES = {
  facebook_marketplace: { label: 'Facebook Marketplace', icon: 'fb' },
  facebook_group: { label: 'Facebook Group', icon: 'fb' },
  one2car: { label: 'One2Car', icon: 'o2c' },
  kaidee: { label: 'Kaidee Auto', icon: 'kd' },
};

// ---------------------------------------------------------------------------
// สถานะในหน่วยความจำ (ไม่ต้องคงอยู่ข้าม deploy ก็ได้ — จะสร้างใหม่เองตอนเริ่มดึงรอบแรก)
// ---------------------------------------------------------------------------
const status = {};
Object.keys(SOURCES).forEach(key => {
  status[key] = { ...SOURCES[key], key, state: 'idle', lastSync: null, lastCount: 0, todayCount: 0, lastError: null };
});

// เก็บ controller ของแต่ละแหล่งที่รองรับ 3 provider (Bright Data/Apify/Watcher) เปิด-ปิดแยกกันได้
// จากปุ่มในหน้า health.html มีผลทันทีไม่ต้องรีสตาร์ทเซิร์ฟเวอร์ — สร้างจริงใน createSourceController()
// แล้วเก็บไว้ที่นี่ใน main() เพื่อให้ route handler ด้านล่าง (test/restart/providers) เรียกใช้ได้
const sourceControllers = {
  facebook_marketplace: null,
  facebook_group: null,
};

const MAX_LISTINGS = 500;
let listingsStore = []; // ใหม่สุดอยู่หน้าสุด

// ประกาศรถทั้งหมด (ไม่ใช่แค่ seen-urls) ก็ต้องคงอยู่ข้าม deploy ด้วย ไม่งั้นแดชบอร์ดจะว่างเปล่าทุกครั้ง
// ที่เซิร์ฟเวอร์รีสตาร์ท (เช่น Render redeploy) ทั้งที่ยังมีของจริงอยู่ — ก่อนหน้านี้เก็บแค่ในหน่วยความจำ
const LISTINGS_KEY = 'car-radar:listings';
async function loadListings() {
  listingsStore = await getJSON(LISTINGS_KEY, []);
}

// รายการ url ที่เคยเห็นแล้ว — อันนี้ต้องคงอยู่ข้าม deploy ถึงจะกันแจ้งเตือนซ้ำได้ จึงเก็บผ่าน Redis
const SEEN_KEY = 'car-radar:seen-urls';
const MAX_SEEN = 20000;
let seen = new Set();
async function loadSeen() {
  seen = new Set(await getJSON(SEEN_KEY, []));
}

// เซฟทั้ง seen-urls และ listingsStore พร้อมกัน debounce เดียว (สองอย่างนี้เปลี่ยนพร้อมกันเสมอ)
let saveTimer = null;
function saveStateDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    setJSON(SEEN_KEY, Array.from(seen).slice(-MAX_SEEN));
    setJSON(LISTINGS_KEY, listingsStore);
  }, 5000); // ดีเลย์ 5 วิ กันเรียก Redis ถี่เกินไปตอนเจอรถเข้าใหม่ติดๆ กันหลายคัน
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);

app.use(express.json());
// เก็บ session (login) ไว้ใน Redis แทน MemoryStore ค่า default — แก้ warning "MemoryStore...
// will leak memory" และกัน session หายทุกครั้งที่ restart/crash (ผู้ใช้ไม่โดนเตะออกกลางคัน)
const { RedisSessionStore } = require('./src/redisSessionStore');
app.use(session({
  store: new RedisSessionStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // อยู่ในระบบได้ 7 วันโดยไม่ต้องล็อกอินใหม่
}));

// ---- ตัวช่วยเช็คสิทธิ์ ----
function requireAuthPage(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/login.html');
}
function requireAdminPage(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.redirect('/');
}
function requireAuthApi(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ ok: false, error: 'ยังไม่ได้เข้าสู่ระบบ' });
}
function requireAdminApi(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.status(403).json({ ok: false, error: 'ต้องเป็นแอดมินเท่านั้นถึงจะทำรายการนี้ได้' });
}

// ---- Login แยกต่างหากสำหรับหน้า /logs.html — ไม่ผูกกับระบบ session/user หลัก (authStore) เลย
// ใช้ HTTP Basic Auth (เบราว์เซอร์เด้ง popup ถามชื่อผู้ใช้/รหัสผ่านเอง ไม่ต้องทำหน้า login เพิ่ม)
// ตั้งค่า username/password เองได้ผ่าน env — ถ้าไม่ตั้งจะใช้ค่า default ตามที่ขอ (check / P@ssw0rd)
// ⚠️ ควรเปลี่ยนเป็นค่าของตัวเองผ่าน env ตอน deploy จริง อย่าปล่อยเป็นค่า default ใน production
const LOGS_VIEWER_USER = process.env.LOGS_VIEWER_USER || 'check';
const LOGS_VIEWER_PASS = process.env.LOGS_VIEWER_PASS || 'P@ssw0rd';

function requireLogsAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const sepIdx = decoded.indexOf(':');
    const user = decoded.slice(0, sepIdx);
    const pass = decoded.slice(sepIdx + 1);
    if (user === LOGS_VIEWER_USER && pass === LOGS_VIEWER_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Log Viewer"');
  return res.status(401).send('ต้อง login ก่อนถึงจะดู log ได้');
}

// ---- หน้าเว็บ (ต้องประกาศก่อน express.static เพื่อให้ guard มีผลก่อนเสมอ) ----
app.get('/login.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', requireAuthPage, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/leads.html', requireAuthPage, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'leads.html')));
app.get('/settings.html', requireAuthPage, requireAdminPage, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/users.html', requireAuthPage, requireAdminPage, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'users.html')));
app.get('/health.html', requireAuthPage, requireAdminPage, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'health.html')));
app.get('/logs.html', requireLogsAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'logs.html')));

app.use(express.static(path.join(__dirname, 'public')));

// เอาไว้ให้ external pinger (คนละบริการ) เรียกกันเว็บหลับบน Render free tier — ไม่ต้องล็อกอิน
app.get('/api/ping', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---- Auth ----
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = authStore.verifyLogin(username, password);
  if (!user) return res.status(401).json({ ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  req.session.user = user;
  res.json({ ok: true, user });
});
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/auth/me', (req, res) => res.json({ ok: true, user: req.session?.user || null }));
app.post('/api/auth/change-password', requireAuthApi, async (req, res) => {
  try {
    await authStore.changePassword(req.session.user.id, req.body?.password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- จัดการผู้ใช้ (แอดมินเท่านั้น) ----
app.get('/api/users', requireAuthApi, requireAdminApi, (_req, res) => {
  res.json({ ok: true, users: authStore.listUsers() });
});
app.post('/api/users', requireAuthApi, requireAdminApi, async (req, res) => {
  try {
    const user = await authStore.createUser(req.body || {});
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
app.delete('/api/users/:id', requireAuthApi, requireAdminApi, async (req, res) => {
  try {
    if (req.session.user.id === req.params.id) throw new Error('ลบบัญชีที่ล็อกอินอยู่ตอนนี้ไม่ได้ ให้สลับไปใช้บัญชีอื่นก่อน');
    await authStore.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/status', requireAuthApi, (_req, res) => res.json({ sources: status, updatedAt: new Date().toISOString(), redis: getWriteHealth() }));

// ---- ตั้งค่ากลุ่ม Facebook / Marketplace จากหน้า UI หลังบ้าน (แอดมินเท่านั้น) ----
app.get('/api/settings', requireAuthApi, requireAdminApi, (_req, res) => res.json(settingsStore.getSettings()));

app.post('/api/settings', requireAuthApi, requireAdminApi, async (req, res) => {
  try {
    const updated = await settingsStore.saveSettings(req.body || {});
    console.log('⚙️  บันทึกการตั้งค่าใหม่แล้ว — รอบดึงข้อมูลถัดไปจะใช้ค่านี้');
    res.json({ ok: true, settings: updated });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- ค้นหากลุ่ม Facebook ที่เกี่ยวกับรถมือสองให้อัตโนมัติ (แอดมินเท่านั้น) ----
app.post('/api/discover/groups', requireAuthApi, requireAdminApi, async (req, res) => {
  try {
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords.filter(Boolean) : [];
    const result = await discoverGroups(keywords);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- ทดสอบดึง Facebook Marketplace ตามที่เปิดใช้งานอยู่ตอนนี้ (แอดมินเท่านั้น) — เห็นผลจริงในหน้าเว็บทันที ----
app.post('/api/test/marketplace', requireAuthApi, requireAdminApi, async (req, res) => {
  try {
    const controller = sourceControllers.facebook_marketplace;
    // เลือก provider ที่ "เปิดใช้งานอยู่ ✅ และมี credential พร้อมจริง" ก่อนเสมอ (ไม่ใช่แค่เปิดอยู่
    // เฉยๆ — เจอบั๊กจริง: เปิด Bright Data ไว้แต่ไม่ได้ตั้ง token เลยเลือก Bright Data มาทดสอบก่อน
    // Apify ที่ตั้งค่าไว้ครบแล้ว ทำให้ error เข้าใจผิดว่า Apify มีปัญหา ทั้งที่จริง Apify ใช้ได้ปกติ)
    const candidates = ['brightdata', 'apify'];
    const activeName = candidates.find(name => controller?.isEnabled(name) && isProviderAvailable(name))
      || candidates.find(name => controller?.isEnabled(name)) // เปิดอยู่แต่ไม่มี credential — ให้ error จริงจาก provider นั้นแทน
      || null;
    if (!activeName) {
      throw new Error('ยังไม่ได้เปิดใช้งาน Bright Data หรือ Apify สำหรับ Marketplace เลย — เปิดอย่างน้อย 1 ตัวในหน้า "สถานะการเชื่อมต่อ" ก่อน');
    }
    const testFn = activeName === 'brightdata' ? testMarketplaceSearchBrightData : testMarketplaceSearch;
    const result = await testFn();
    res.json({ ok: true, providerUsed: activeName, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/listings', requireAuthApi, (req, res) => {
  const { source, q, limit = 200 } = req.query;
  let items = listingsStore;
  if (source) items = items.filter(l => l.source === source);
  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter(l => l.title.toLowerCase().includes(needle));
  }
  res.json({ items: items.slice(0, Number(limit)), total: items.length });
});

// ---- Image proxy — แก้ปัญหารูปโหลดไม่ขึ้น (โชว์เป็น placeholder รถสีเทาตลอด) ----
// สาเหตุจริง: เว็บต้นทาง (One2Car, Kaidee, Facebook CDN) ส่วนใหญ่ทำ hotlink protection — เช็ค
// Referer header ตอนเบราว์เซอร์ของผู้ใช้ขอโหลดรูปตรงๆ จากเว็บเรา แล้วปฏิเสธเพราะ Referer ไม่ตรง
// กับเว็บต้นทาง วิธีแก้คือให้ "เซิร์ฟเวอร์ของเรา" เป็นฝ่ายไปขอรูปแทน (server-to-server ไม่ติด
// CORS/Referer check แบบเดียวกับ browser) แล้วส่งต่อ (proxy) ให้เบราว์เซอร์อีกที
//
// กัน SSRF (ไม่ให้ใช้ endpoint นี้เป็นทางยิง request เข้า network ภายในของเซิร์ฟเวอร์เอง):
//  - รับเฉพาะ http/https เท่านั้น
//  - ปฏิเสธ hostname ที่ชี้เข้า localhost/IP ภายใน (private range) ทั้งหมด
//  - จำกัดขนาดไฟล์และเวลา timeout กันโดนใช้เป็นช่องทาง DoS
function isPrivateOrLocalHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  // IPv4 private ranges: 10.x, 172.16-31.x, 192.168.x, 169.254.x (link-local/cloud metadata)
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(h)) return true;
  return false;
}

app.get('/api/image-proxy', requireAuthApi, async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).json({ ok: false, error: 'ต้องระบุ ?url=' });

  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'url ไม่ถูกต้อง' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ ok: false, error: 'รองรับแค่ http/https' });
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    return res.status(400).json({ ok: false, error: 'ไม่อนุญาตให้เรียก host นี้' });
  }

  try {
    const upstream = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 10 * 1024 * 1024, // จำกัด 10MB กันไฟล์ใหญ่ผิดปกติ
      headers: {
        // ตั้ง Referer เป็น origin ของรูปเอง (ทริคที่ใช้ผ่าน hotlink protection แบบพื้นฐานได้ส่วนใหญ่
        // เพราะเว็บต้นทางมักเช็คแค่ว่า Referer เป็นโดเมนตัวเองหรือเปล่า ไม่ได้เช็คทั้ง URL เป๊ะๆ)
        Referer: `${parsed.protocol}//${parsed.hostname}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      validateStatus: () => true,
    });

    if (upstream.status >= 400) {
      return res.status(502).json({ ok: false, error: `ต้นทางตอบ HTTP ${upstream.status}` });
    }

    res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400'); // cache 1 วันฝั่งเบราว์เซอร์ ลดโหลดซ้ำ
    res.send(Buffer.from(upstream.data));
  } catch (e) {
    console.log(`❌ [image-proxy] โหลดรูปไม่สำเร็จ (${imageUrl}): ${e.message}`);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ---- log แบบ live สำหรับหน้า /logs.html — poll แบบ incremental ด้วย ?after=<seq ล่าสุดที่มีอยู่แล้ว>
// จะได้ไม่ต้องโหลด log ทั้งหมดซ้ำทุกครั้งที่ poll (เบากว่า ใช้ bandwidth น้อยกว่า) ----
app.get('/api/logs', requireLogsAuth, (req, res) => {
  const after = Number(req.query.after || 0);
  const items = after > 0 ? logBuffer.filter(l => l.seq > after) : logBuffer;
  res.json({ items, latestSeq: logSeq });
});

// ---- Webhook รับผลจาก Apify Task (ทางเลือกสำหรับสถาปัตยกรรม event-driven — ดูคำอธิบายเต็มใน
// DEPLOY.md หัวข้อ "ลด Apify CU") — ตั้ง Apify Task + Scheduler ในตัวของ Apify เอง + Webhook ชี้มาที่
// URL นี้ แทนที่จะให้เซิร์ฟเวอร์เราเป็นฝ่าย poll เรียก actor เองทุกรอบ ไม่ต้องรอ .env มี provider
// อะไรเปิดอยู่ก็ทำงานได้ (เพราะ Apify เป็นฝ่ายยิงมาหาเราเอง) แต่ยังต้องใช้ ACTOR/TOKEN เดิม
// URL ที่ต้องตั้งใน Apify Task > Integrations > Webhooks:
//   https://your-app.onrender.com/api/webhooks/apify?source=group&secret=<APIFY_WEBHOOK_SECRET>
//   https://your-app.onrender.com/api/webhooks/apify?source=marketplace&secret=<APIFY_WEBHOOK_SECRET>
// Event type ที่ต้องเลือกตอนตั้งใน Apify: "Run succeeded"
app.post('/api/webhooks/apify', async (req, res) => {
  const { source, secret } = req.query;
  const configuredSecret = process.env.APIFY_WEBHOOK_SECRET;
  if (configuredSecret && secret !== configuredSecret) {
    return res.status(401).json({ ok: false, error: 'secret ไม่ถูกต้อง' });
  }

  const sourceKey = source === 'marketplace' ? 'facebook_marketplace' : source === 'group' ? 'facebook_group' : null;
  if (!sourceKey) {
    return res.status(400).json({ ok: false, error: 'ต้องระบุ ?source=marketplace หรือ ?source=group ใน webhook URL' });
  }

  const datasetId = req.body?.resource?.defaultDatasetId;
  if (!datasetId) {
    return res.status(400).json({ ok: false, error: 'ไม่พบ resource.defaultDatasetId ใน payload — เช็คว่าตั้ง event type เป็น "Run succeeded" ถูกไหม' });
  }

  // ตอบ Apify ทันทีก่อนประมวลผล กัน webhook timeout ฝั่ง Apify (ไม่ต้องรอเราดึง+ประมวลผลเสร็จ)
  res.json({ ok: true });

  try {
    const { data } = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items`, {
      params: { token: process.env.APIFY_TOKEN },
      timeout: 30000,
    });
    const items = Array.isArray(data) ? data : [];
    console.log(`🪝 [webhook/apify/${source}] ได้ ${items.length} รายการดิบจาก dataset ${datasetId}`);

    const mapItemFn = sourceKey === 'facebook_marketplace' ? mapMarketplaceApifyItem : mapGroupApifyItem;
    const mapped = items.map(mapItemFn).filter(l => l.title && l.url);

    if (sourceKey === 'facebook_group') {
      // แปะชื่อกลุ่มกลับเข้าไป เหมือน logic ใน scrapeGroupViaApify()
      const settings = settingsStore.getSettings();
      const labelByGroupId = {};
      (settings.facebookGroups || []).forEach(g => {
        const id = extractGroupId(g.url);
        if (id) labelByGroupId[id] = g.label;
      });
      mapped.forEach(l => {
        const id = extractGroupId(l.url);
        l.groupLabel = (id && labelByGroupId[id]) || null;
      });
    }

    const relevant = mapped.filter(l => matchesTargetModel(l.title));
    await handleNewListings(relevant, sourceKey);
    console.log(`🪝 [webhook/apify/${source}] ประมวลผลเสร็จ: ${mapped.length} รายการ → เหลือ ${relevant.length} รายการหลังกรองรุ่นรถ`);
  } catch (e) {
    console.log(`❌ [webhook/apify/${source}] ประมวลผล dataset ${datasetId} ไม่สำเร็จ: ${e.message}`);
  }
});
// GET คืนสถานะเปิด/ปิดปัจจุบัน + ว่า credential ของแต่ละตัวพร้อมใช้งานจริงไหม (แอดมินเท่านั้น)
app.get('/api/providers', requireAuthApi, requireAdminApi, (_req, res) => {
  const settings = settingsStore.getSettings();
  res.json({
    ok: true,
    toggles: settings.providerToggles,
    availability: {
      brightdata: Boolean(process.env.BRIGHTDATA_API_TOKEN),
      apify: USE_APIFY,
      watcher: true,
    },
  });
});

// POST เปลี่ยนสถานะเปิด/ปิด provider เดียว มีผลทันที (ไม่ต้องรีสตาร์ทเซิร์ฟเวอร์) — บันทึกถาวรผ่าน
// settingsStore ด้วย จะได้ไม่รีเซ็ตกลับตอน deploy ใหม่/เซิร์ฟเวอร์รีสตาร์ท
// :source ต้องเป็น "marketplace" หรือ "group", :provider ต้องเป็น "brightdata" | "apify" | "watcher"
app.post('/api/providers/:source/:provider', requireAuthApi, requireAdminApi, async (req, res) => {
  const { source, provider } = req.params;
  const enabled = Boolean(req.body?.enabled);
  const sourceKey = source === 'marketplace' ? 'facebook_marketplace' : source === 'group' ? 'facebook_group' : null;
  const controller = sourceKey ? sourceControllers[sourceKey] : null;
  if (!controller) return res.status(400).json({ ok: false, error: `ไม่รู้จักแหล่งข้อมูลชื่อ "${source}" (ต้องเป็น marketplace หรือ group)` });
  try {
    await controller.setEnabled(provider, enabled);
    res.json({ ok: true, source, provider, enabled });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- ปุ่ม "ดึงข้อมูลตอนนี้" — สั่งดึงทุกแหล่งที่ลงทะเบียนไว้ทันที ไม่ต้องรอรอบถัดไป ----
// อาจใช้เวลานานถ้ามี Facebook ผ่าน Apify (ต้องรอ actor รันเสร็จ) จึงรอผลจนกว่าจะครบทุกแหล่ง
app.post('/api/refresh', requireAuthApi, async (_req, res) => {
  const keys = Object.keys(sourceRegistry);
  if (keys.length === 0) return res.json({ ok: true, results: [] });

  const results = await Promise.all(keys.map(key => runOnce(key, sourceRegistry[key])));
  res.json({ ok: true, results });
});

// ---- ดึงข้อมูลเฉพาะแหล่งเดียว (ใช้หลังเพิ่มกลุ่ม Facebook ใหม่จากการค้นหาอัตโนมัติ ไม่ต้องรอ
// แหล่งอื่นที่ไม่เกี่ยวข้อง กันเปลือง Apify credit ของ Marketplace โดยไม่จำเป็น) ----
app.post('/api/refresh/:source', requireAuthApi, async (req, res) => {
  const key = req.params.source;
  const fn = sourceRegistry[key];
  if (!fn) return res.status(400).json({ ok: false, error: `ไม่มีแหล่งข้อมูลชื่อ "${key}" ที่ดึงข้อมูลตอนนี้ได้` });
  const result = await runOnce(key, fn);
  res.json({ ok: true, result });
});

// ---- สถานะการเชื่อมต่อทุกบริการภายนอก (แอดมินเท่านั้น) — ทดสอบเชื่อมต่อจริง ไม่ใช่แค่เช็ค env ----
app.get('/api/health/check', requireAuthApi, requireAdminApi, async (_req, res) => {
  try {
    const checks = await healthCheck.runAllChecks();
    res.json({ ok: true, checks, scraperStatus: status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- รีสตาร์ทการเชื่อมต่อ/บริการ (แอดมินเท่านั้น) ----
// - facebook_marketplace_watcher: ปิด-เปิด browser ใหม่จริง (มีความหมายเฉพาะโหมด watcher เท่านั้น)
// - อย่างอื่น (redis/apify/googleSheets/line/one2car/kaidee): เป็นการเชื่อมต่อแบบ REST ไม่มี "session"
//   ให้รีสตาร์ทจริง ตีความ "รีสตาร์ท" เป็นการทดสอบเชื่อมต่อใหม่ทันทีแทน
app.post('/api/health/restart/:service', requireAuthApi, requireAdminApi, async (req, res) => {
  const svc = req.params.service;
  try {
    if (svc === 'facebook_marketplace_watcher') {
      if (!sourceControllers.facebook_marketplace?.isEnabled('watcher')) {
        return res.status(400).json({ ok: false, error: 'ตอนนี้ปิดโหมด watcher (Puppeteer) ของ Marketplace อยู่ — เปิดใช้งานในหน้า "สถานะการเชื่อมต่อ" ก่อนถึงจะรีสตาร์ทได้' });
      }
      await restartFbWatcher();
      return res.json({ ok: true, message: 'รีสตาร์ท Facebook Marketplace watcher แล้ว (ปิด-เปิด browser ใหม่)' });
    }

    if (svc === 'facebook_group_watcher') {
      if (!sourceControllers.facebook_group?.isEnabled('watcher')) {
        return res.status(400).json({ ok: false, error: 'ตอนนี้ปิดโหมด watcher (Puppeteer) ของ Group อยู่ — เปิดใช้งานในหน้า "สถานะการเชื่อมต่อ" ก่อนถึงจะรีสตาร์ทได้' });
      }
      await restartFbGroupWatcher();
      return res.json({ ok: true, message: 'รีสตาร์ท Facebook Group watcher แล้ว (ปิด-เปิด browser ใหม่)' });
    }

    const checkFnMap = {
      redis: healthCheck.checkRedis,
      apify: healthCheck.checkApify,
      brightdata: healthCheck.checkBrightData,
      googleSheets: healthCheck.checkGoogleSheets,
      line: healthCheck.checkLine,
      one2car: () => healthCheck.checkWebsite(process.env.ONE2CAR_URL || 'https://www.one2car.com/en/cars-for-sale', 'One2Car'),
      kaidee: () => healthCheck.checkWebsite(process.env.KAIDEE_URL || 'https://rod.kaidee.com/used-cars/newarrival', 'Kaidee'),
      renderBackend: healthCheck.checkRenderBackend,
    };
    const fn = checkFnMap[svc];
    if (!fn) return res.status(400).json({ ok: false, error: `ไม่รู้จักบริการชื่อ "${svc}"` });
    const result = await fn();
    return res.json({ ok: true, message: 'ทดสอบเชื่อมต่อใหม่แล้ว', result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- รถที่ต้องการ (บันทึกได้ทั้ง admin/staff) ----
app.get('/api/leads', requireAuthApi, (_req, res) => {
  res.json({ ok: true, leads: leadsStore.listLeads(), statusLabels: leadsStore.STATUS_LABELS });
});
app.post('/api/leads', requireAuthApi, async (req, res) => {
  try {
    const lead = await leadsStore.upsertLead(req.body || {}, req.session.user.username);
    res.json({ ok: true, lead });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
app.delete('/api/leads', requireAuthApi, async (req, res) => {
  try {
    await leadsStore.removeLead(req.query.url);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- เพิ่มประกาศ Facebook Marketplace เองด้วยลิงก์ (สำรองไว้เผื่อการค้นหาอัตโนมัติใช้ไม่ได้ —
// ดึงจากลิงก์ที่รู้อยู่แล้วมีโอกาสผ่าน bot-protection ของ Facebook ได้ดีกว่าการค้นหาทั้งหน้า) ----
app.post('/api/marketplace/quick-add', requireAuthApi, async (req, res) => {
  try {
    const url = (req.body?.url || '').trim();
    if (!url || !/facebook\.com\/marketplace\/item\//.test(url)) {
      throw new Error('ต้องเป็นลิงก์ประกาศ Facebook Marketplace เท่านั้น (facebook.com/marketplace/item/...)');
    }
    const listing = await fetchSingleListing(url);
    const freshCount = await handleNewListings([listing], 'facebook_marketplace');
    res.json({ ok: true, listing, isNew: freshCount > 0 });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// helper กลาง: จัดการทุกอย่างเมื่อเจอรถใหม่จากแหล่งใดก็ตาม
// ---------------------------------------------------------------------------
function filterNew(listings) {
  const fresh = listings.filter(l => l.url && !seen.has(l.url));
  fresh.forEach(l => seen.add(l.url));
  if (fresh.length > 0) saveStateDebounced();
  return fresh;
}

async function pushToBackend(listings, sourceKey) {
  if (listings.length === 0 || !RENDER_URL) return;
  try {
    await axios.post(
      `${RENDER_URL}/internal/sync`,
      { listings, syncedAt: new Date().toISOString(), scrapeLog: { [sourceKey]: { count: listings.length, blocked: false, error: null } } },
      { headers: { 'x-sync-secret': SYNC_SECRET }, timeout: 15000 }
    );
  } catch (e) {
    console.log(`❌ [${sourceKey}] ส่งเข้า backend เดิมไม่สำเร็จ: ${e.message}`);
  }
}

function markSynced(sourceKey, count, error = null) {
  const s = status[sourceKey];
  s.lastSync = new Date().toISOString();
  s.lastCount = count;
  s.state = error ? 'error' : 'ok';
  s.lastError = error;
  if (count > 0) s.todayCount += count;
}

async function handleNewListings(listings, sourceKey) {
  const fresh = filterNew(listings);

  if (fresh.length > 0) {
    listingsStore = [...fresh, ...listingsStore].slice(0, MAX_LISTINGS);
    console.log(`🆕 [${sourceKey}] เจอใหม่ ${fresh.length} คัน`);

    await Promise.allSettled([
      pushToBackend(fresh, sourceKey),
      appendListings(fresh).catch(e => console.log(`❌ [${sourceKey}] Google Sheet: ${e.message}`)),
      notifyBatch(fresh).catch(e => console.log(`❌ [${sourceKey}] LINE: ${e.message}`)),
    ]);
  }

  markSynced(sourceKey, fresh.length);
  return fresh.length;
}

function markError(sourceKey, err) {
  console.log(`❌ [${sourceKey}] scrape ล้มเหลว: ${err.message}`);
  status[sourceKey].state = 'error';
  status[sourceKey].lastError = err.message;
}

// รันดึงข้อมูล 1 รอบสำหรับแหล่งเดียว — ใช้ร่วมกันทั้ง loop อัตโนมัติ และปุ่ม "ดึงข้อมูลตอนนี้"
// กรองเฉพาะรุ่นรถเป้าหมาย (src/targetModels.js) ตรงนี้จุดเดียว ครอบคลุมทุกแหล่งที่ผ่าน runOnce()
// (One2Car/Kaidee ที่ดึงประกาศทุกคันมาก่อนไม่ได้กรองจากต้นทาง, และเป็นชั้นกรองซ้ำให้ Bright
// Data/Apify Marketplace ที่กรองจากต้นทางไปแล้วชั้นหนึ่ง)
async function runOnce(sourceKey, scrapeFn) {
  try {
    const listings = await scrapeFn();
    const relevant = listings.filter(l => matchesTargetModel(l.title));
    if (listings.length > 0 && relevant.length < listings.length) {
      console.log(`🚗 [${sourceKey}] กรองรุ่นรถ: ${listings.length} → ${relevant.length} รายการ (เหลือเฉพาะรุ่นเป้าหมาย)`);
    }
    const freshCount = await handleNewListings(relevant, sourceKey);
    return { source: sourceKey, ok: true, newCount: freshCount };
  } catch (e) {
    markError(sourceKey, e);
    return { source: sourceKey, ok: false, error: e.message, errObj: e };
  }
}

// เก็บรายชื่อแหล่งที่ดึงแบบ poll ได้ (ไม่รวม Facebook Marketplace ตอนใช้โหมด watcher เดิม
// เพราะตัวนั้นสแกนต่อเนื่องอยู่แล้วทุก 15 วิ ไม่จำเป็นต้องกดดึงซ้ำ)
const sourceRegistry = {};

function startPolling(sourceKey, scrapeFn, intervalMs) {
  sourceRegistry[sourceKey] = scrapeFn;
  const tick = async () => {
    await runOnce(sourceKey, scrapeFn);
    setTimeout(tick, intervalMs);
  };
  tick();
  console.log(`▶️  polling ${sourceKey} ทุก ${intervalMs / 1000} วิ`);
}

// เช็คว่า provider นี้มี credential/สิ่งที่ต้องใช้พร้อมจริงไหม (ไม่ใช่ว่ากำลังเปิดอยู่หรือเปล่า —
// อันนั้นดูจาก controller.isEnabled() ที่อ่านจาก settingsStore.providerToggles)
function isProviderAvailable(provider) {
  if (provider === 'brightdata') return Boolean(process.env.BRIGHTDATA_API_TOKEN);
  if (provider === 'apify') return USE_APIFY;
  if (provider === 'watcher') return true; // ใช้ Puppeteer เสมอได้ (อาจ error เองถ้ายังไม่ตั้ง cookies)
  return false;
}

// ---- ตัวควบคุมกลางของแต่ละแหล่งข้อมูล (Marketplace/Group): เปิด/ปิด Bright Data, Apify, Watcher
// ได้อิสระทีละตัว มีผลทันทีไม่ต้องรีสตาร์ทเซิร์ฟเวอร์ — ค่าที่เปิด/ปิดไว้ถูกเก็บถาวรผ่าน settingsStore
// (Redis) เลยไม่หายตอน deploy ใหม่ ทำให้ "ใช้งานได้ทั้ง 3" จริง (เปิดพร้อมกันได้มากกว่า 1 ตัว) ----
//   sourceKey         — คีย์ที่ใช้กับ status/sourceRegistry/handleNewListings เช่น 'facebook_marketplace'
//   settingsSourceKey — คีย์ที่ใช้อ่าน/เขียน settingsStore.providerToggles เช่น 'marketplace'
//   providers         — { brightdata: {fn, intervalMs}, apify: {fn, intervalMs}, watcher: {start, stop} }
function createSourceController(sourceKey, settingsSourceKey, providers) {
  const pollTimers = {};

  // 🔴 kill switch ฉุกเฉิน — ปิด watcher ได้จาก Render Environment โดยตรง (ไม่ต้องเข้าเว็บเลย)
  // สำหรับตอนที่เว็บ 502/เข้าไม่ได้ จนกดปิดใน /health.html เองไม่ได้ — ตั้ง env var
  // DISABLE_WATCHER_SOURCES=marketplace,group (คั่นด้วย comma) เพื่อบังคับปิด watcher ของแหล่งนั้น
  // ไม่ว่าค่าที่บันทึกไว้ใน Redis จะเป็นอะไรก็ตาม มีผลเฉพาะ watcher เท่านั้น (brightdata/apify ไม่ผูก)
  const forceDisabledSources = (process.env.DISABLE_WATCHER_SOURCES || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  function isEnabled(name) {
    if (name === 'watcher' && forceDisabledSources.includes(settingsSourceKey)) return false;
    const toggles = settingsStore.getSettings().providerToggles?.[settingsSourceKey] || {};
    return Boolean(toggles[name]);
  }

  // เริ่ม/ต่อ loop ดึงข้อมูลของ provider แบบ poll (brightdata/apify) — เช็ค isEnabled() ทุกรอบ
  // ถ้าปิดอยู่ก็แค่ข้าม ไม่ scrape แต่ยังนับเวลารอบต่อไปอยู่ (พอเปิดกลับมาจะทำงานต่อเองรอบถัดไป
  // หรือถ้าสั่งเปิดผ่าน setEnabled() จะเรียกฟังก์ชันนี้ใหม่ทันทีเพื่อดึงทันทีไม่ต้องรอ)
  function schedulePoll(name) {
    clearTimeout(pollTimers[name]);
    const def = providers[name];
    const runTick = async () => {
      if (isEnabled(name)) {
        const result = await runOnce(sourceKey, def.fn);
        // ถ้า error นี้เป็น "เครดิต/งบประมาณหมด" (ตรวจจับไว้ใน fbMarketplaceApify.js/fbGroupApify.js)
        // และมี Watcher (ฟรี ไม่ใช้เครดิตเลย) ให้ใช้ แต่ยังไม่ได้เปิดไว้ → เปิดให้อัตโนมัติทันที เพื่อให้
        // ยังดึงข้อมูลต่อได้แม้ provider ที่ใช้เครดิตหมด ไม่ต้องรอแอดมินมาเปิดเอง
        if (!result.ok && result.errObj?.isCreditExhausted && providers.watcher && !isEnabled('watcher') && !forceDisabledSources.includes(settingsSourceKey)) {
          console.log(`💳 [${sourceKey}] "${name}" เครดิต/งบประมาณหมด — เปิด Watcher (ฟรี) ให้อัตโนมัติเพื่อให้ยังดึงข้อมูลต่อได้ (ปิด "${name}" ไว้ก่อนได้จากหน้า health.html ถ้าไม่อยากให้มัน retry ซ้ำๆ จนกว่าจะเติมเครดิต — หมายเหตุ: ถ้ายังไม่ได้ตั้งค่า FB_COOKIES_PATH ไว้ Watcher จะสแกนแบบ guest ซึ่งอาจถูก Facebook บล็อกไม่ให้ดู Marketplace ได้ ดู DEPLOY.md หัวข้อ 1.2 สำหรับวิธีตั้งค่า cookies บัญชีจริง)`);
          await setEnabled('watcher', true).catch(e => console.log(`⚠️ เปิด Watcher อัตโนมัติไม่สำเร็จ: ${e.message}`));
        }
      }
      pollTimers[name] = setTimeout(runTick, def.intervalMs);
    };
    runTick();
  }

  async function applyWatcher() {
    const def = providers.watcher;
    if (!def) return;
    if (isEnabled('watcher')) await def.start();
    else await def.stop();
  }

  // ให้ปุ่ม "ดึงข้อมูลตอนนี้" (/api/refresh) เรียกทุก provider แบบ poll ที่เปิดอยู่ตอนนี้พร้อมกัน
  // แล้วรวมผลลัพธ์เป็นชุดเดียว (watcher ไม่รวมด้วยเพราะสแกนต่อเนื่องอยู่แล้ว ไม่ใช่แบบดึงเป็นรอบ)
  sourceRegistry[sourceKey] = async () => {
    const pollNames = Object.keys(providers).filter(name => name !== 'watcher' && isEnabled(name));
    if (pollNames.length === 0) return [];
    const results = await Promise.all(pollNames.map(name => providers[name].fn()));
    return results.flat();
  };

  async function init() {
    if (providers.brightdata) schedulePoll('brightdata');
    if (providers.apify) schedulePoll('apify');
    if (providers.watcher) await applyWatcher();

    const onNames = Object.keys(providers).filter(isEnabled);
    console.log(`✅ [${sourceKey}] เปิดใช้งาน: ${onNames.length > 0 ? onNames.join(', ') : '(ไม่มีเลย — ยังไม่ดึงข้อมูลจากแหล่งนี้)'}`);
  }

  async function setEnabled(name, enabled) {
    if (!providers[name]) throw new Error(`ไม่มี provider "${name}" สำหรับแหล่งข้อมูลนี้`);
    if (enabled && !isProviderAvailable(name)) {
      throw new Error(`ยังไม่ได้ตั้งค่า credential ของ "${name}" ใน .env.local — ตั้งก่อนถึงจะเปิดใช้งานได้`);
    }
    if (name === 'watcher' && enabled && forceDisabledSources.includes(settingsSourceKey)) {
      throw new Error(`Watcher ของแหล่งนี้ถูกบังคับปิดไว้ผ่าน env var DISABLE_WATCHER_SOURCES — ต้องลบ "${settingsSourceKey}" ออกจาก env นั้นก่อนถึงจะเปิดได้`);
    }

    const settings = settingsStore.getSettings();
    const currentToggles = settings.providerToggles || {};
    const nextForSource = { ...(currentToggles[settingsSourceKey] || {}), [name]: enabled };
    await settingsStore.saveSettings({ providerToggles: { ...currentToggles, [settingsSourceKey]: nextForSource } });

    if (name === 'watcher') {
      await applyWatcher();
    } else if (enabled) {
      schedulePoll(name); // เปิดแล้วลองดึงทันทีเลย ไม่ต้องรอรอบถัดไป
    }
    // ปิด brightdata/apify ไม่ต้องทำอะไรเพิ่ม — runTick() เช็ค isEnabled() ทุกรอบอยู่แล้ว จะข้ามเอง
    console.log(`🔘 [${sourceKey}] ${enabled ? 'เปิด' : 'ปิด'} provider "${name}" แล้ว`);
  }

  return { init, setEnabled, isEnabled };
}

// เก็บ instance ไว้ระดับโมดูล เพื่อให้ "รีสตาร์ท"/เปิด-ปิดจากหน้า health.html ปิด/เปิด browser ใหม่ได้จริง
let fbWatcherInstance = null;
async function startFbWatcher() {
  if (fbWatcherInstance) return; // เปิดอยู่แล้ว ไม่ต้องเปิดซ้ำ
  try {
    const fbWatcher = new FbWatcher();
    fbWatcher.on('listing', (listing) => {
      if (matchesTargetModel(listing.title)) handleNewListings([listing], 'facebook_marketplace');
    });
    fbWatcher.on('status', (s) => console.log(`ℹ️  [facebook_marketplace] ${s.msg}`));
    fbWatcher.on('error', (err) => markError('facebook_marketplace', err));
    await fbWatcher.start();
    fbWatcherInstance = fbWatcher;
    console.log('▶️  Facebook Marketplace watcher เริ่มทำงานแล้ว');
  } catch (e) {
    markError('facebook_marketplace', e);
    console.log(`⚠️ เปิด Facebook watcher ไม่สำเร็จ: ${e.message}`);
  }
}
async function stopFbWatcher() {
  if (fbWatcherInstance) {
    await fbWatcherInstance.stop().catch(() => {});
    fbWatcherInstance = null;
    console.log('⏹️  Facebook Marketplace watcher หยุดทำงานแล้ว (ปิดจากหน้า health.html)');
  }
}
async function restartFbWatcher() {
  await stopFbWatcher();
  await startFbWatcher();
}

// เหมือนกันแต่สำหรับ Facebook Group
let fbGroupWatcherInstance = null;
async function startFbGroupWatcher() {
  if (fbGroupWatcherInstance) return;
  try {
    const groupWatcher = new FbGroupWatcher();
    groupWatcher.on('listing', (listing) => {
      if (matchesTargetModel(listing.title)) handleNewListings([listing], 'facebook_group');
    });
    groupWatcher.on('status', (s) => console.log(`ℹ️  [facebook_group] ${s.msg}`));
    groupWatcher.on('error', (err) => markError('facebook_group', err));
    await groupWatcher.start();
    fbGroupWatcherInstance = groupWatcher;
    console.log('▶️  Facebook Group watcher เริ่มทำงานแล้ว');
  } catch (e) {
    markError('facebook_group', e);
    console.log(`⚠️ เปิด Facebook Group watcher ไม่สำเร็จ: ${e.message}`);
  }
}
async function stopFbGroupWatcher() {
  if (fbGroupWatcherInstance) {
    await fbGroupWatcherInstance.stop().catch(() => {});
    fbGroupWatcherInstance = null;
    console.log('⏹️  Facebook Group watcher หยุดทำงานแล้ว (ปิดจากหน้า health.html)');
  }
}
async function restartFbGroupWatcher() {
  await stopFbGroupWatcher();
  await startFbGroupWatcher();
}

// ---------------------------------------------------------------------------
// เริ่มการทำงาน
// ---------------------------------------------------------------------------
async function main() {
  // โหลดข้อมูลถาวรทั้งหมดจาก Redis ก่อนเปิดรับ request
  logConfigPreview();
  await Promise.all([authStore.init(), settingsStore.init(), leadsStore.init(), loadSeen(), loadListings()]);

  server.listen(PORT, () => console.log(`\n🌐 แดชบอร์ด: http://localhost:${PORT}\n`));

  try {
    await ensureHeader();
    console.log('✅ Google Sheet พร้อมใช้งาน');
  } catch (e) {
    console.log(`⚠️ Google Sheet ยังใช้ไม่ได้: ${e.message}`);
  }

  // ---- Facebook Marketplace: เปิด/ปิด Bright Data, Apify, Watcher ได้อิสระทีละตัว (ค่าเริ่มต้น
  // เก็บถาวรใน settingsStore/Redis อยู่แล้ว — ดูปุ่มเปิด/ปิดได้ที่หน้า "สถานะการเชื่อมต่อ") ----
  sourceControllers.facebook_marketplace = createSourceController('facebook_marketplace', 'marketplace', {
    brightdata: { fn: scrapeMarketplaceViaBrightData, intervalMs: BRIGHTDATA_POLL_INTERVAL_MS },
    apify: { fn: scrapeMarketplaceViaApify, intervalMs: APIFY_POLL_INTERVAL_MS },
    watcher: { start: startFbWatcher, stop: stopFbWatcher },
  });
  await sourceControllers.facebook_marketplace.init();

  // ---- Facebook Group: เหมือนกัน แยก state จาก Marketplace ----
  sourceControllers.facebook_group = createSourceController('facebook_group', 'group', {
    brightdata: { fn: scrapeGroupViaBrightData, intervalMs: BRIGHTDATA_POLL_INTERVAL_MS },
    apify: { fn: scrapeGroupViaApify, intervalMs: APIFY_POLL_INTERVAL_MS },
    watcher: { start: startFbGroupWatcher, stop: stopFbGroupWatcher },
  });
  await sourceControllers.facebook_group.init();

  // 🔴 kill switch เพิ่มเติม — ปิด One2Car/Kaidee ได้จาก env โดยตรงเหมือนกัน (ใช้เป็นเครื่องมือ
  // วินิจฉัยว่าตัวไหนกันแน่ที่ทำให้ OOM — ตั้งชื่อแหล่งคั่นด้วย comma เช่น "one2car" หรือ "one2car,kaidee"
  const disabledPollSources = (process.env.DISABLE_POLL_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!disabledPollSources.includes('one2car')) {
    startPolling('one2car', scrapeOne2Car, ONE2CAR_INTERVAL_MS);
  } else {
    console.log('🔴 [one2car] ปิดไว้ผ่าน DISABLE_POLL_SOURCES');
  }
  if (!disabledPollSources.includes('kaidee')) {
    startPolling('kaidee', scrapeKaidee, KAIDEE_INTERVAL_MS);
  } else {
    console.log('🔴 [kaidee] ปิดไว้ผ่าน DISABLE_POLL_SOURCES');
  }
}

main().catch(console.error);
