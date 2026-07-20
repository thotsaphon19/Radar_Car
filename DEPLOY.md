# คู่มือ Deploy ระบบเรดาร์รถมือสอง

ตรวจสอบโค้ดทุกไฟล์แล้ว (require/export ครบ, endpoint หน้าเว็บตรงกับ backend ทุกจุด, แก้บั๊ก Google
Sheets credentials ที่จะพังตอน deploy บน hosting ไม่มี persistent disk) พร้อม deploy จริง

---

## 0. ไฟล์ไหนใช้จริง ไฟล์ไหนไม่ต้องเอาไป deploy

ระบบผ่านการปรับหลายรอบ มีไฟล์รุ่นเก่าที่ถูกแทนที่แล้วค้างอยู่ **ไม่ต้อง deploy ไฟล์เหล่านี้**:
- `auto-fb.ps1`, `start-fb-scraper.bat` — สคริปต์ตัวจับเวลารุ่นแรกสุด ถูกแทนที่ด้วย `server.js` ที่รันลูปในตัวเองแล้ว
- `fb-scraper.js`, `fb-realtime.js`, `main-realtime.js` — ตัวรันรุ่นกลางที่ยังไม่มีแดชบอร์ด/login ถูกแทนที่ด้วย `server.js`

**ไฟล์ที่ต้อง deploy จริง (โฟลเดอร์นี้ทั้งหมด ยกเว้นไฟล์ข้างบน):**
```
server.js                  ← ตัวรันหลัก ตัวเดียวที่สั่ง node ตรงๆ
package.json
src/
  redisStore.js
  authStore.js
  settingsStore.js
  leadsStore.js
  scrapers/
    fbMarketplaceApify.js
    fbGroupApify.js
    fbDiscovery.js
    httpFetch.js              ← ตัวช่วยกลาง ดึงหน้าเว็บด้วย header เบราว์เซอร์จริง (ใช้โดย one2car.js/kaidee.js)
    puppeteerFetch.js         ← ตัวช่วยกลาง ดึง HTML ที่ render จริงแล้วด้วย headless browser (fallback ของ kaidee.js เวลาโดนบล็อก)
    one2car.js
    kaidee.js
    fbWatcher.js               ← สำรองไว้เผื่อไม่ใช้ Apify (ไม่ได้ใช้ถ้าตั้ง APIFY_TOKEN)
    facebookRSS.js             ← สำรองเช่นกัน
    facebookMarketplace.js     ← สำรองเช่นกัน (fbWatcher.js ใช้แทนแล้ว)
  integrations/
    googleSheets.js
    lineMessaging.js
public/
  login.html
  index.html
  leads.html
  settings.html
  users.html
  health.html
  logs.html            ← หน้าดู console log แบบ live (ไม่ต้องเข้า Render dashboard) — เฉพาะ admin
```

---

## 1. เตรียมบัญชีบริการภายนอกทั้งหมดก่อน (ทำครั้งเดียว)

ทำตามลำดับนี้ แต่ละอันจะได้ค่ามาใส่ใน `.env.local`

### 1.1 Upstash Redis (บังคับ — เก็บ user/settings/leads ให้ถาวร)
1. สมัคร https://upstash.com (ฟรี ไม่ต้องบัตรเครดิต)
2. สร้าง Redis database ใหม่ → เลือกแบบ **Regional** (ธรรมดาพอ ไม่ต้อง Global)
3. เข้าหน้า database → คัดลอก **REST URL** และ **REST TOKEN**
4. ได้ค่า:
   ```
   UPSTASH_REDIS_REST_URL=https://xxxxx.upstash.io
   UPSTASH_REDIS_REST_TOKEN=xxxxxxxx
   ```

### 1.2 Facebook Marketplace — Puppeteer + cookies บัญชีจริง (ค่า default)
Apify actor สำหรับ Marketplace ที่ทดสอบไปหลายตัว/หลาย input แล้วโดน Facebook บล็อกอยู่ดี
("Empty or private data") จึงใช้วิธีเดิม (browser จริง + login) เป็นค่า default แทน

1. **แนะนำให้สร้างบัญชี Facebook สำรอง** (ไม่ใช่บัญชีจริงของร้าน) ใช้แค่สำหรับ scrape เท่านั้น
   กันความเสี่ยงบัญชีจริงโดนบล็อกจากการสแกนอัตโนมัติ
2. Login เข้าบัญชีนั้นในเบราว์เซอร์ปกติ แล้ว export cookies ด้วย extension เช่น "Cookie-Editor"
   (ค้นหาใน Chrome Web Store) → export เป็น JSON
3. บันทึกไฟล์ที่ได้เป็น `fb-cookies.json` ไว้ที่ root ของโปรเจกต์ (ระดับเดียวกับ `server.js`)
4. ตั้งค่าใน `.env.local`:
   ```
   FB_COOKIES_PATH=./fb-cookies.json
   ```
   (ไม่ต้องตั้ง `MARKETPLACE_PROVIDER` แล้ว — เปิด/ปิด Bright Data/Apify/Watcher แต่ละตัวได้จากปุ่ม
   toggle ในหน้า "สถานะการเชื่อมต่อ" (`/health.html`) ของเว็บโดยตรง มีผลทันที ไม่ต้องรีสตาร์ท
   เซิร์ฟเวอร์ — ค่าที่ตั้งไว้เก็บถาวรผ่าน Redis เปิดพร้อมกันได้มากกว่า 1 ตัวด้วย)
5. **บน Render:** ไฟล์ `fb-cookies.json` ต้องอัปโหลดผ่าน Render "Secret Files" (ไม่ใช่ env var
   เพราะเป็น JSON array ยาว) — เข้า Render service → Environment → Secret Files → เพิ่มไฟล์
   ตั้ง path เป็น `/etc/secrets/fb-cookies.json` แล้วปรับ `FB_COOKIES_PATH=/etc/secrets/fb-cookies.json`

### 1.2b Apify (บังคับถ้าจะดึง Facebook Group — ทำงานได้ดี ทดสอบแล้ว)
1. สมัคร https://apify.com (Free plan ไม่ต้องบัตรเครดิต)
2. Settings → Integrations → คัดลอก API token
3. ไป Apify Store ค้นหา **"Facebook Groups Scraper"** เลือกตัวที่ rating สูง/อัปเดตล่าสุด คัดลอก Actor ID (รูปแบบ `owner/actor-name` จาก URL)
4. (ถ้าจะใช้ฟีเจอร์ค้นหากลุ่มอัตโนมัติ — หมายเหตุ: ตอนนี้ไม่เสถียร แนะนำใช้ปุ่ม "ใช้กลุ่มแนะนำ" ในหน้า settings.html แทน) ค้นหา **"Facebook Groups Search Scraper"** เพิ่มอีกตัว
5. ได้ค่า:
   ```
   APIFY_TOKEN=apify_api_xxxxxxxx
   APIFY_GROUP_ACTOR_ID=owner/facebook-groups-scraper
   APIFY_GROUP_DISCOVERY_ACTOR_ID=owner/facebook-groups-search-scraper
   ```
6. **สำคัญ:** รันทดสอบ actor ในหน้า Apify ก่อน ดู field ผลลัพธ์จริง (title/price/url/image ชื่ออะไร) แล้วเทียบกับ `mapItem()` ใน `src/scrapers/fbGroupApify.js` ถ้าไม่ตรงต้องแก้ mapping ตรงนั้น

### 1.3 Google Sheets (ไม่บังคับ — ข้ามได้ถ้าไม่ต้องการบันทึกลง Sheet)
1. https://console.cloud.google.com/ → สร้างโปรเจกต์ → เปิดใช้งาน "Google Sheets API"
2. สร้าง Service Account → สร้างคีย์แบบ JSON → ดาวน์โหลดไฟล์มา
3. เปิด Google Sheet ที่จะใช้เก็บข้อมูล → Share → แชร์ให้อีเมลใน field `client_email` ของไฟล์ JSON สิทธิ์ Editor
4. คัดลอก Spreadsheet ID จาก URL: `docs.google.com/spreadsheets/d/<ตรงนี้>/edit`
5. แปลงไฟล์ JSON เป็น base64 (สำคัญ — ใช้ตัวนี้ตอน deploy ไม่ใช่ path ไฟล์):
   ```bash
   base64 -i google-service-account.json | tr -d '\n'
   ```
6. ได้ค่า:
   ```
   GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<ผลลัพธ์จากคำสั่งข้างบน>
   GOOGLE_SHEET_ID=<SPREADSHEET_ID>
   GOOGLE_SHEET_TAB=Listings
   ```

### 1.4 LINE Messaging API (ไม่บังคับ — ข้ามได้ถ้าไม่ต้องการแจ้งเตือน LINE)
1. https://developers.line.biz/console/ → สร้าง Provider → สร้าง Messaging API Channel
2. แท็บ "Messaging API" → กด Issue → คัดลอก Channel access token
3. เพิ่มเพื่อน LINE Official Account ของ Channel นี้ (สแกน QR ในหน้า console)
4. หา userId/groupId ที่จะส่งแจ้งเตือนไปหา (ต้องตั้ง webhook รับ event ก่อนถึงจะเห็น — หรือใช้บริการ wrapper สำเร็จรูปแทนถ้าไม่อยากทำ webhook เอง)
5. ได้ค่า:
   ```
   LINE_CHANNEL_ACCESS_TOKEN=xxxxxxxx
   LINE_TARGET_ID=Uxxxxxxxx
   ```

### 1.5 Render (hosting)
1. สมัคร https://render.com (เชื่อม GitHub account)
2. Push โค้ดทั้งหมดขึ้น GitHub repo ก่อน (ยกเว้น `.env.local` ตัวจริง — ห้าม commit ไฟล์นี้เด็ดขาด เพราะมีรหัสลับ)
3. สร้างไฟล์ `.gitignore` ถ้ายังไม่มี ใส่:
   ```
   node_modules/
   .env.local
   ```

---

## 2. ตั้งค่า .env.local

คัดลอก `.env.local.example` เป็น `.env.local` แล้วกรอกค่าจากขั้นตอนที่ 1 ทั้งหมด จุดที่ต้องเช็คเป็นพิเศษ:

- `SESSION_SECRET` — ห้ามใช้ค่า default ที่ให้มา ต้องเปลี่ยนเป็นข้อความสุ่มยาวๆ ของตัวเอง (เช่นรันคำสั่ง `openssl rand -hex 32` แล้ว copy มาใส่)
- `APIFY_POLL_INTERVAL_MS` — ตั้งไว้ที่ 5 นาที (300000) ตามที่ขอ แต่**อ่านคำเตือนเรื่องเครดิต Apify ในหัวข้อ 5**
- ถ้าไม่ได้ตั้งค่า Google Sheets / LINE ไว้ ระบบจะข้ามสองส่วนนี้ไปเฉยๆ ไม่ error ไม่ต้องกังวล

---

## 3. ทดสอบในเครื่องตัวเองก่อน (สำคัญมาก อย่าข้าม)

```bash
npm install
node server.js
```

เช็คทีละอย่าง:
1. คอนโซลต้องมีบรรทัด `🔑 สร้างบัญชีแอดมินเริ่มต้นให้แล้ว` พร้อม username/password — จดไว้
2. เปิด `http://localhost:3000` → ต้องเด้งไปหน้า login อัตโนมัติ
3. ล็อกอินด้วยรหัสจาก console → ต้องเข้าแดชบอร์ดได้
4. เปิด `/settings.html` → กรอกกลุ่ม Facebook อย่างน้อย 1 กลุ่ม + บันทึก → รีเฟรชหน้า → ค่าต้องยังอยู่ (ยืนยันว่า Upstash Redis เชื่อมได้จริง)
5. รอ 5-10 นาที ดู console ว่ามีบรรทัด `🆕 [one2car] เจอใหม่ X คัน` หรือไม่ (One2Car/Kaidee ควรทำงานได้เลยไม่ต้องตั้งค่าอะไรเพิ่ม)
6. กดปุ่ม ☆ บนการ์ดรถคันไหนก็ได้ → ไปเช็คที่ `/leads.html` ว่าคันนั้นโผล่มา

ถ้าทุกข้อผ่าน ค่อยไป deploy จริง

---

## 4. Deploy บน Render

1. Render Dashboard → **New** → **Web Service**
2. เชื่อม GitHub repo ที่ push โค้ดไว้
3. ตั้งค่า:
   - **Build Command:** `npm install && npx puppeteer browsers install chrome`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free — **แต่อ่านคำเตือนด้านล่างก่อน**

   ⚠️⚠️ **สำคัญมาก — ต้องมี `npx puppeteer browsers install chrome` ต่อท้ายใน Build Command เสมอ**
   ไม่ใช่แค่ `npm install` เฉยๆ! ยืนยันแล้วจากการ deploy จริง: Puppeteer v22+ (ที่โปรเจกต์นี้ใช้) ไม่ได้
   ดาวน์โหลด Chrome ให้อัตโนมัติผ่าน postinstall hook แบบเดิมบน Render เสมอไป ถ้าลืมต่อคำสั่งนี้จะเจอ
   error แบบนี้ตอนรัน (ทั้ง One2Car และ Kaidee fallback ที่ใช้ Puppeteer เหมือนกัน):
   ```
   Could not find Chrome (ver. ...). This can occur if either
   1. you did not perform an installation before running the script...
   ```
   ถ้าเจอ error นี้หลัง deploy ไปแล้ว: ไปที่ Build Command แก้เป็นแบบข้างบน แล้ว **Manual Deploy →
   Clear build cache & deploy** (ต้องเคลียร์ cache ด้วย ไม่ใช่แค่ redeploy ธรรมดา ไม่งั้นจะไม่รันคำสั่ง
   ติดตั้งใหม่)

   ⚠️ **อัปเดตสำคัญ:** ตอนนี้ `one2car.js` เปลี่ยนมาใช้ Puppeteer (เปิด Chrome จริง) แทน axios แล้ว
   เพราะ One2Car มี Cloudflare bot-protection กิน RAM มากกว่าเดิมมาก ถ้า Render free tier (512MB RAM)
   ไม่พอ ให้สังเกตจาก log ว่า process ถูก kill เอง (มักมีคำว่า "OOM" หรือ service restart บ่อยผิดปกติ)
   ถ้าเจอ ให้อัปเกรดเป็น instance แบบ paid ที่ RAM เยอะขึ้น (เช่น Starter 512MB→ต้องเป็นแบบที่สูงกว่านี้)

   `kaidee.js` ปกติใช้ axios เบาๆ อยู่แล้ว (ไม่กิน RAM มาก) แต่ถ้าโดน Cloudflare บล็อกจะ fallback ไป
   เปิด Chrome จริงเหมือน One2Car ชั่วคราวโดยอัตโนมัติ (ดู log บรรทัด `🔀 [kaidee] axios โดนบล็อก`)
   ถ้าเห็นบรรทัดนี้บ่อยๆ แปลว่ากิน RAM เพิ่มขึ้นเป็นระยะ ให้จับตา RAM เหมือนกับ One2Car ด้วย

   ✅ **แก้ไขแล้ว (ยืนยันจากปัญหาจริง):** เดิม Facebook Marketplace watcher กับ Facebook Group
   watcher เปิด Chrome แยกกันคนละ process เต็มๆ (2 ตัว) ถ้าเปิดพร้อมกันบน Render free tier (512MB)
   ทำให้ OOM (โดน kill กลางคัน, เว็บขึ้น 502) จริง — ตอนนี้ทั้งสอง watcher ใช้ Chrome process
   **เดียวกัน** (คนละ tab) ผ่าน `src/scrapers/sharedBrowser.js` แล้ว ลด RAM ลงได้มาก เปิดพร้อมกันทั้ง
   Marketplace และ Group ได้โดยไม่ต้องอัปเกรด plan (ถ้ายัง OOM อยู่หลังอัปเดตนี้ แปลว่า RAM 512MB
   ไม่พอจริงๆ ต้องอัปเกรด plan แล้ว ไม่ใช่ปัญหาโค้ดอีกต่อไป)

   ✅ **เพิ่มอีกชั้น (ยืนยันจากปัญหาจริงอีกรอบ — ยัง OOM/502 อยู่แม้ใช้ Chrome ร่วมกันแล้ว):** ทุกหน้า
   ที่ Puppeteer เปิด (ทั้ง Facebook Marketplace/Group watcher, One2Car, Kaidee fallback) ตอนนี้
   **บล็อกการโหลดรูปภาพ/วิดีโอ/ฟอนต์** ผ่าน `optimizePage()` ใน `sharedBrowser.js` แล้ว — Facebook/
   One2Car เป็นหน้าที่โหลดรูปภาพเยอะมาก (กิน RAM เยอะสุดในบรรดา resource ทั้งหมด) แต่เราแค่ต้องการ
   URL ของรูป (อยู่ใน HTML attribute อยู่แล้ว) ไม่ต้องโหลดรูปจริงมาแสดงผลเลย บล็อกแล้วไม่กระทบการ
   ดึงข้อมูล/รูปภาพเลย แต่ลด RAM ต่อ tab ได้อีกมาก

   ✅ **แก้ครั้งสุดท้าย (ยืนยันจาก log จริง — สาเหตุที่แท้จริงของ 502 ที่เหลืออยู่):** เดิม `one2car.js`
   เปิด Chrome **แยกทั้งตัวใหม่ทุกครั้ง** ที่สแกน (ทุก ๆ `ONE2CAR_INTERVAL_MS` ~20 วิ) ซ้อนทับกับ
   Chrome ของ Facebook watcher ที่เปิดค้างอยู่แล้วตลอดเวลา กลายเป็นมี Chrome process 2 ตัวพร้อมกัน
   เป็นระยะๆ ตลอด ทำให้ OOM ต่อเนื่องแม้จะแก้ประเด็น Facebook 2 watcher ไปแล้วก็ตาม — ตอนนี้
   `one2car.js` และ `puppeteerFetch.js` (fallback ของ Kaidee) ใช้ **Chrome instance เดียวกันกับ
   Facebook watcher ทั้งหมดแล้ว** (คนละ tab) เหลือ Chrome แค่ **ตัวเดียวทั้งระบบ** ไม่ว่าจะเปิดกี่
   แหล่งพร้อมกันก็ตาม — นี่คือจุดที่ทำให้ RAM ลดลงมากที่สุดจริงๆ
4. Environment → Add Environment Variable → ใส่ **ทุกตัวแปรจาก `.env.local`** ทีละตัว (Render ไม่อ่านไฟล์ `.env.local` ให้อัตโนมัติ ต้องกรอกในหน้านี้เอง)
5. กด **Create Web Service** → รอ build เสร็จ (~2-5 นาที)
6. เปิด URL ที่ Render ให้มา (`https://your-app.onrender.com`) → ต้องเจอหน้า login

---

## 5. ตั้ง external pinger กัน service หลับ (บังคับ ไม่ทำจะพัง)

Render free tier จะหลับหลังไม่มีคนเข้าเว็บ 15 นาที ทำให้ loop ดึงข้อมูลเบื้องหลังหยุดไปด้วย

1. สมัคร https://cron-job.org (ฟรี ไม่ต้องบัตรเครดิต) หรือ UptimeRobot
2. สร้าง cron job ใหม่ ยิง GET request ไปที่ `https://your-app.onrender.com/api/ping` **ทุก 10 นาที**
3. เสร็จแล้ว service จะไม่หลับอีก ระบบดึงข้อมูลทำงานตลอด 24 ชม.

---

## 6. เรื่องเครดิต Apify ที่ต้องติดตามหลัง deploy (สำคัญ — ตั้งไว้ 5 นาทีตามที่ขอ)

จากการคำนวณคร่าวๆ ก่อนหน้านี้ **ที่ 5 นาที มีโอกาสสูงที่เครดิตฟรี $5/เดือนจะหมดภายใน 1-2 วันแรก** ไม่ใช่อยู่ได้ทั้งเดือน — ทำตามนี้เพื่อไม่ให้เจอปัญหาแบบไม่ทันตั้งตัว:

1. หลัง deploy เสร็จวันแรก เข้า Apify → **Billing → Usage** ทุกๆ ไม่กี่ชั่วโมง ดูว่าเครดิตลดเร็วแค่ไหน
2. คำนวณคร่าวๆ: ถ้าใช้ไป $X ใน Y ชั่วโมง → จะหมดใน `5 / (X/Y)` ชั่วโมง
3. ถ้าจะหมดเร็วเกินไป (ไม่ถึงสิ้นเดือน) มี 2 ทางเลือก:
   - เพิ่ม `APIFY_POLL_INTERVAL_MS` ใน Render Environment ให้นานขึ้น (เช่น 1800000 = 30 นาที) แล้ว restart service
   - หรือผูกบัตรเครดิตกับ Apify ยอมรับค่าใช้จ่ายจริงเพื่อคงความเร็ว 5 นาทีไว้
4. ถ้าไม่ผูกบัตร: เครดิตหมด = Facebook หยุดดึงข้อมูลเงียบๆ จนกว่าจะขึ้นรอบบิลใหม่ (One2Car/Kaidee ยังทำงานปกติ เพราะไม่ใช้ Apify) — เข้า `/settings.html` เช็คสถานะ "ดึงล่าสุดเมื่อไหร่" ของ Facebook เป็นระยะจะได้รู้ทันทีถ้าหยุดทำงาน

---

## 6.5 ลด Apify CU — สถาปัตยกรรมสำหรับใช้งานจริงระดับธุรกิจ (เร็วใกล้เคียงเรียลไทม์ + ประหยัด CU)

ปัญหาของการ "สแกนทุกกลุ่มทุก 5 นาทีเท่ากันหมด" (แบบเดิม) คือ CU ถูกใช้แม้กลุ่มนั้นจะไม่มีโพสต์ใหม่เลยก็ตาม
ยิ่ง poll ถี่เพื่อความเรียลไทม์ ยิ่งเปลือง ระบบตอนนี้แก้ด้วย **checkpoint ต่อกลุ่ม + แบ่งระดับความสำคัญ
(priority)** ซึ่งเป็นสิ่งที่ยืนยันได้แน่นอนว่าลด CU จริง (ไม่ต้องพึ่ง parameter เฉพาะของ actor ที่ยังไม่ยืนยัน):

### วิธีทำงาน (ทำไว้ให้แล้วในโค้ด ไม่ต้องทำอะไรเพิ่ม — ครอบคลุมทั้ง Facebook Group และ Marketplace)
- แต่ละกลุ่ม Facebook (และแต่ละจังหวัดของ Marketplace) ตั้ง priority ได้ในหน้า `/settings.html`:
  **สูง** (โพสต์ใหม่บ่อย เช่นกลุ่มซื้อขายรถใหญ่ๆ/กรุงเทพฯ), **ปกติ**, **ต่ำ** (กลุ่ม/จังหวัดนิ่งๆ)
- ทุกครั้งที่ระบบจะสแกน (ทุก `APIFY_POLL_INTERVAL_MS`) จะเช็คก่อนว่ากลุ่ม/จังหวัดไหน "ครบกำหนด" สแกนใหม่
  แล้วบ้าง (เทียบเวลาสแกนล่าสุด กับ `APIFY_GROUP/MARKETPLACE_HIGH/NORMAL/LOW_INTERVAL_MS`)
- **ถ้าไม่มีกลุ่ม/จังหวัดไหนครบกำหนดเลย จะข้ามไปเลย ไม่ยิง actor แม้แต่ครั้งเดียว** (ไม่เสีย CU)
- ถ้ามีบางกลุ่ม/จังหวัดครบกำหนด จะยิง actor เฉพาะที่ครบกำหนดเท่านั้น (ไม่ใช่ทุกอันเหมือนเดิม)
- checkpoint (เวลาสแกนล่าสุดต่อกลุ่ม/จังหวัด) เก็บถาวรใน Redis เลยไม่หายตอน redeploy/รีสตาร์ท
- โหมด Marketplace แบบพื้นที่เดียว (ไม่เปิดทั่วประเทศ — ค่า default) ก็ใช้ระบบเดียวกัน แค่มีจังหวัด
  เดียวในลิสต์ ประโยชน์หลักตรงนี้คือแยก "ความถี่เช็ค" ออกจาก "ความถี่สแกนจริง" ทำให้ตั้ง
  `APIFY_POLL_INTERVAL_MS` ต่ำได้อย่างปลอดภัยโดยไม่กระทบค่าใช้จ่าย

**วิธีตั้งให้ประหยัดสุด:** ตั้ง `APIFY_POLL_INTERVAL_MS=60000` (เช็คทุก 1 นาทีว่ามีอะไรครบกำหนดไหม —
เบามาก ไม่เสีย CU ตอนเช็ค) แล้วปรับ `APIFY_GROUP_HIGH_INTERVAL_MS`/`APIFY_MARKETPLACE_HIGH_INTERVAL_MS`
ให้สั้นเฉพาะกลุ่ม/จังหวัดที่ priority สูงจริงๆ เท่าที่จำเป็น ส่วนใหญ่ตั้งเป็น normal/low ได้ตามจริง
จะลด CU ลงได้มาก (สัดส่วนขึ้นกับว่ามีกี่อันที่ priority สูงเทียบกับทั้งหมด)

### ทางเลือกเสริม — Webhook แบบ event-driven (ทำไว้ให้พร้อมใช้ ต้องตั้งค่าเพิ่มเองใน Apify Console)
แทนที่จะให้เซิร์ฟเวอร์เราเป็นฝ่าย poll เรียก actor เองทุกรอบ (ต้องเปิดเซิร์ฟเวอร์ทิ้งไว้ตลอด) สามารถให้
Apify เป็นฝ่ายจัดตารางเวลาเองผ่าน **Apify Task + Scheduler** แล้วยิง **Webhook** มาบอกเราแทนเมื่อรันเสร็จ:

1. ใน Apify Console สร้าง **Task** จาก actor เดิม (`get-leads/all-in-one-facebook-scraper`) ตั้ง input
   (startUrls ของกลุ่ม priority สูง) แยกเป็นคนละ Task ตามกลุ่ม priority ก็ได้ (นี่คือ "แบ่ง Actor" ตามที่ถาม)
2. ตั้ง **Schedule** ของ Task นั้นตามความถี่ที่ต้องการ (Apify มี cron scheduler ในตัว ไม่ต้องพึ่งเซิร์ฟเวอร์เรา)
3. ไปที่ Task > **Integrations > Webhooks** เพิ่ม webhook ใหม่ event type **"Run succeeded"** ชี้ไปที่:
   ```
   https://your-app.onrender.com/api/webhooks/apify?source=group&secret=<APIFY_WEBHOOK_SECRET ที่ตั้งไว้>
   ```
   (เปลี่ยน `source=group` เป็น `source=marketplace` สำหรับ Task ฝั่ง Marketplace)
4. ตั้ง `APIFY_WEBHOOK_SECRET` ใน Render Environment เป็นค่าสุ่มของตัวเอง (กันคนอื่นยิง webhook ปลอมมา)
5. เซิร์ฟเวอร์เราจะรับ webhook, ดึงผลลัพธ์จาก dataset, กรองรุ่นรถ, แล้วบันทึก/แจ้งเตือนเหมือนโหมด poll ปกติ

**ข้อดี:** ไม่ต้องพึ่งเซิร์ฟเวอร์เราเปิดตลอดเวลาเพื่อ "จำ" ว่าต้อง poll เมื่อไหร่ Apify จัดตารางเองฝั่งเขา —
เหมาะกับสเกลใหญ่ที่มี Task แยกเยอะๆ ตามลำดับความสำคัญ **ข้อควรรู้:** วิธีนี้ไม่ได้ลด CU เพิ่มเติมจาก
checkpoint ด้านบน (CU ยังคิดตามที่ actor รันจริงเหมือนเดิม) แต่ช่วยเรื่องสถาปัตยกรรม/ความน่าเชื่อถือ
(ไม่พลาดรอบสแกนแม้เซิร์ฟเวอร์เรา restart/ล่มชั่วคราว)

### สิ่งที่ยังทำไม่ได้ตอนนี้ (ต้องตรวจสอบเองก่อนใช้)
Apify บาง actor รองรับ parameter แบบ "ดึงเฉพาะโพสต์ใหม่กว่าวันที่ที่กำหนด" (เช่น `onlyPostsNewerThan`)
ซึ่งจะลด CU ได้มากกว่านี้อีก เพราะตัว actor เองจะสแกนน้อยลง (หยุดเลื่อนหน้าเมื่อเจอโพสต์เก่าที่เคยเห็นแล้ว)
แต่ผมไม่มีทางยืนยัน parameter ที่ actor `get-leads/all-in-one-facebook-scraper` รองรับจริงได้ (ต้องเข้าไปดู
ที่แท็บ **Input** ของ actor นั้นในหน้า Apify Console โดยตรง) — ถ้าเจอ parameter แบบนี้ บอกชื่อ field มาได้เลย
จะเพิ่ม logic ส่ง checkpoint (เวลาสแกนล่าสุด) เข้าไปใน input ให้ทันที จะยิ่งลด CU ได้มากกว่านี้อีกชั้นหนึ่ง

---

## 6.6 Auto-fallback ไป Watcher เมื่อเครดิต Apify/Bright Data หมด

ระบบตรวจจับ error ที่เกี่ยวกับเครดิต/งบประมาณ/สถานะบัญชีหมดอัตโนมัติ (เช่น "insufficient", "exceed...
budget", "Customer is not active" ฯลฯ) — ถ้าเจอ error แบบนี้จาก Apify หรือ Bright Data และ **Watcher
(Puppeteer+cookies) ยังไม่ได้เปิดไว้** ระบบจะ**เปิด Watcher ให้อัตโนมัติทันที** เพื่อให้ยังดึงข้อมูลต่อได้
โดยไม่ต้องรอแอดมินมาเปิดเอง (ดู log บรรทัด `💳 [...] เครดิต/งบประมาณหมด — เปิด Watcher (ฟรี) ให้อัตโนมัติ`)

**ข้อควรรู้ (สำคัญ):**
- Watcher ที่เปิดอัตโนมัติแบบนี้จะ**ทำงานได้เต็มประสิทธิภาพก็ต่อเมื่อตั้งค่า `FB_COOKIES_PATH` ไว้ล่วงหน้า
  แล้ว** (คำแนะนำ: **ตั้ง cookies ไว้ล่วงหน้าเสมอตั้งแต่แรก แม้จะใช้ Apify เป็นหลักก็ตาม** เพื่อให้กลไก
  auto-fallback นี้มีประโยชน์จริงตอนที่เครดิตหมดกะทันหัน) — ถ้ายังไม่มี cookies ไว้ Watcher จะสแกนแบบ
  guest ซึ่ง Facebook อาจบล็อกไม่ให้ดู Marketplace ได้เลย (ดูหัวข้อ 1.2 ด้านบน)
- Provider ที่เครดิตหมด (Apify/Bright Data) **จะไม่ถูกปิดอัตโนมัติ** ยังคง retry ต่อไปเรื่อยๆ ตามปกติ
  (เผื่อเครดิตกลับมาใช้ได้ระหว่างนั้น) ถ้าไม่อยากให้ retry รัวๆ จน log รก ปิดเองได้จากหน้า `/health.html`
- เป็นการเปิดแบบ "เพิ่มเข้ามา" ไม่ใช่ "สลับแทน" — ถ้า Apify กลับมาใช้ได้ปกติ (เติมเครดิตแล้ว) ทั้ง Apify
  และ Watcher จะทำงานพร้อมกันต่อไป (ปิด Watcher เองได้ทีหลังถ้าไม่ต้องการให้ทำงานคู่กันตลอด)

---

## 7. Checklist สุดท้ายก่อนส่งลูกค้า

- [ ] ล็อกอินด้วยบัญชี admin ได้ และ**เปลี่ยนรหัสผ่านจากค่า random เริ่มต้นแล้ว**
- [ ] สร้างบัญชี staff ให้พนักงานแต่ละคนแยกกัน (อย่าแชร์บัญชี admin กัน)
- [ ] ตั้งค่ากลุ่ม Facebook + พื้นที่ Marketplace ในหน้า settings.html ตามที่ลูกค้าต้องการจริง
- [ ] ตั้ง external pinger เรียบร้อยแล้ว (ข้อ 5)
- [ ] เช็ค Apify billing ในวันแรกตามข้อ 6
- [ ] ทดสอบกดปุ่ม ☆ บันทึกรถ + เปลี่ยนสถานะใน `/leads.html` ได้จริง
- [ ] บอกลูกค้าให้ชัดเรื่องความเร็ว: One2Car/Kaidee ~20 วิ, Facebook ~5 นาที (หรือช้ากว่านั้นถ้าต้องปรับเพราะเครดิตหมด)
- [ ] เก็บ `.env.local` ตัวจริงไว้ที่ปลอดภัย (ไม่ใช่ใน git) เผื่อต้อง deploy ซ้ำ
