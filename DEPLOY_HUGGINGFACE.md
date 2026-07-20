# คู่มือ Deploy บน Hugging Face Spaces (ฟรี ไม่ต้องบัตรเครดิต, RAM 16GB)

เอกสารนี้สำหรับกรณีที่ไม่มีบัตรเครดิต/เดบิตสำหรับ Oracle Cloud และ Render free tier (512MB) ไม่พอ —
Hugging Face Spaces แจก **16GB RAM + 2 vCPU ฟรี ไม่ต้องผูกบัตรเลย** deploy แบบ git push คล้าย Render

⚠️ **ข้อจำกัดที่ต้องรู้ก่อน:**
- Space จะ **sleep** ถ้าไม่มีคนเข้านานๆ (เหมือน Render free tier) — ต้องตั้ง external pinger เหมือนเดิม
- ต้องเขียน **Dockerfile** เอง (ทำไว้ให้แล้วในโปรเจกต์ — ไม่ต้องเขียนเพิ่ม แค่เข้าใจว่ามันทำอะไร)
- Spec ที่บอกในนี้อ้างอิงจากข้อมูลที่เป็นที่รู้จักกันดี **แนะนำเปิด https://huggingface.co/pricing
  เช็คตัวเลขล่าสุดเองอีกทีก่อนเริ่ม** เผื่อมีการเปลี่ยนแปลงนโยบาย

---

## 1. สมัครบัญชี Hugging Face

1. ไปที่ https://huggingface.co/join
2. กรอก email + username + password (หรือกด Sign up with Google/GitHub ก็ได้) — **ไม่ต้องกรอกบัตรใดๆ ทั้งสิ้น**
3. ยืนยัน email ตามลิงก์ที่ส่งไป

---

## 2. สร้าง Space ใหม่

1. ไปที่ https://huggingface.co/new-space
2. ตั้งค่า:
   - **Space name**: ตั้งชื่อเอง เช่น `radar-car`
   - **License**: เลือกอะไรก็ได้ (เช่น `other` หรือปล่อยว่าง)
   - **Select the Space SDK**: เลือก **Docker** (สำคัญ — ต้องเลือกอันนี้ ไม่ใช่ Gradio/Streamlit)
   - **Docker template**: เลือก **Blank** (เราจะใช้ Dockerfile ของเราเอง)
   - **Space hardware**: เลือก **CPU basic · Free** (16GB RAM, 2 vCPU)
   - **Visibility**: แนะนำเลือก **Private** (กันคนอื่นเห็น dashboard/ข้อมูลลูกค้าของธุรกิจคุณ)
3. กด **Create Space**

จะได้หน้า Space เปล่าๆ พร้อม git repo ของตัวเอง (URL ประมาณ
`https://huggingface.co/spaces/<your-username>/radar-car`)

---

## 3. เตรียมไฟล์ในโปรเจกต์ (ทำไว้ให้แล้ว — แค่ตรวจสอบว่ามีครบ)

ไฟล์เหล่านี้ต้องอยู่ที่ root ของโปรเจกต์ (เพิ่มให้แล้วในโค้ดที่ส่งไปรอบล่าสุด):

- ✅ `Dockerfile` — สั่งติดตั้ง Node.js, Chromium, dependencies แล้วรันแอป
- ✅ `entrypoint.sh` — เขียนไฟล์ cookies จาก secret env var ก่อนสตาร์ทเซิร์ฟเวอร์
- ✅ `README.md` — มี YAML metadata บอก HF ว่าใช้ Docker SDK, port 7860
- ✅ `.dockerignore` — กัน node_modules/secrets หลุดเข้าไปใน image

**ไม่ต้องแก้ไฟล์พวกนี้เลย** ใช้ได้ตรงๆ ยกเว้นถ้าอยากเปลี่ยนชื่อ title ใน `README.md`

---

## 4. Clone Space repo มาที่เครื่อง แล้วใส่โค้ดเข้าไป

```bash
# clone repo ของ Space (ว่างเปล่า มีแค่ README.md default)
git clone https://huggingface.co/spaces/<your-username>/radar-car
cd radar-car
```

**คัดลอกไฟล์ทั้งหมดจากโปรเจกต์ `deploy-package` มาไว้ในโฟลเดอร์นี้** (ทับ README.md เดิมด้วย
README.md ของเราที่มี metadata ถูกต้องแล้ว) — วิธีง่ายสุด: copy ไฟล์ทั้งหมดจาก `deploy-package/`
มาวางในโฟลเดอร์ `radar-car/` นี้เลย (ยกเว้น `.git/` ของ radar-car ที่ clone มา อย่าทับโฟลเดอร์นั้น)

ตรวจสอบว่ามีไฟล์ `Dockerfile`, `entrypoint.sh`, `server.js`, `package.json`, โฟลเดอร์ `src/`,
`public/` อยู่ในโฟลเดอร์ `radar-car/` แล้ว

**⚠️ อย่า copy ไฟล์ `.env.local` หรือ `fb-cookies.json` ไปด้วย** (ถูกกันไว้ใน `.gitignore`/
`.dockerignore` แล้ว แต่เช็คซ้ำให้ชัวร์ว่าไม่ได้ copy ติดไปโดยไม่ตั้งใจ)

---

## 5. ตั้งค่า Environment Variables และ Secrets

ไปที่หน้า Space บนเว็บ → แท็บ **Settings** → เลื่อนหา **Variables and secrets**

**ใส่เป็น "Secret" (ซ่อนไว้ ไม่มีใครเห็นแม้แต่ตัวเอง หลังบันทึกแล้ว) สำหรับของที่เป็นความลับ:**
```
SESSION_SECRET=<รันคำสั่ง openssl rand -hex 32 ในเครื่องตัวเอง>
UPSTASH_REDIS_REST_URL=<จาก Upstash>
UPSTASH_REDIS_REST_TOKEN=<จาก Upstash>
LOGS_VIEWER_PASS=<ตั้งเอง>
APIFY_TOKEN=<ถ้าจะใช้>
BRIGHTDATA_API_TOKEN=<ถ้าจะใช้>
```

**Secret พิเศษสำหรับ cookies — ใส่ทั้งไฟล์ JSON เป็นค่าเดียว:**
```
FB_COOKIES_JSON=<เปิดไฟล์ fb-cookies.json ในเครื่อง copy เนื้อหาทั้งหมด (JSON array ทั้งก้อน) มาวางตรงนี้>
```
(entrypoint.sh ที่เตรียมไว้จะเขียนค่านี้ลงไฟล์ `/app/fb-cookies.json` อัตโนมัติตอน container เริ่มทำงาน)

**ใส่เป็น "Variable" ธรรมดา (ไม่ลับ) สำหรับที่เหลือ:**
```
LOGS_VIEWER_USER=check
APIFY_MARKETPLACE_ACTOR_ID=get-leads/all-in-one-facebook-scraper
APIFY_GROUP_ACTOR_ID=<ถ้ามี>
```

(ตัวแปรอื่นๆ ที่ไม่บังคับ เช่น การปรับความถี่ ข้ามไปได้ก่อน มีค่า default ในตัวอยู่แล้ว)

---

## 6. Push โค้ดขึ้น Space

```bash
git add .
git commit -m "Initial deploy"
git push
```

ถ้าเจอ prompt ให้ login ตอน push — ใช้ **username + Access Token** (ไม่ใช่ password ปกติ) สร้าง
token ได้ที่ https://huggingface.co/settings/tokens (เลือก permission แบบ **Write**)

---

## 7. ดู build log

กลับไปที่หน้า Space บนเว็บ → จะเห็นสถานะเปลี่ยนเป็น **Building** → กดแท็บ **Logs** ดู build process
แบบ live (คล้าย Render's build log) — รอจนสถานะเป็น **Running** (ใช้เวลาประมาณ 3-8 นาทีตอน build
ครั้งแรก เพราะต้องติดตั้ง Chromium + npm packages)

ถ้า build ผ่าน จะเห็น log จาก entrypoint.sh และ `🌐 แดชบอร์ด: http://localhost:7860` ปรากฏขึ้น

---

## 8. เข้าใช้งาน

URL ของแอปคือ `https://<your-username>-radar-car.hf.space` (รูปแบบ URL ของ HF Spaces เอง)

ทดสอบ:
1. เข้าหน้า login
2. เข้า `/logs.html` (login ด้วย LOGS_VIEWER_USER/PASS)
3. เช็คว่าเห็น `✅ เขียน fb-cookies.json จาก secret env var เรียบร้อย` (ยืนยันว่า secret ตั้งถูก)
4. เข้า `/health.html` เปิด provider ที่ต้องการ (เปิด Marketplace+Group watcher พร้อมกันได้เลย เพราะมี
   RAM เหลือเฟือ)

---

## 9. ตั้ง external pinger (บังคับ กัน Space หลับ)

เหมือนที่ทำกับ Render — https://cron-job.org → สร้าง cron job ยิง
`https://<your-username>-radar-car.hf.space/api/ping` ทุก 10 นาที

---

## แก้ปัญหาที่พบบ่อย

**Build fail ที่ขั้นตอน `apt-get install`** — ลองกด **Restart this Space** (บางครั้ง apt mirror
ของ HF ล่มชั่วคราว)

**เข้าเว็บแล้วขึ้น "Application not responding"** — เช็คว่า README.md metadata มี
`app_port: 7860` ตรงกับที่ Dockerfile ตั้ง `ENV PORT=7860` ไว้จริง (ต้องตรงกันเป๊ะ)

**Log ไม่เห็น "เขียน fb-cookies.json จาก secret env var เรียบร้อย"** — กลับไปเช็คว่าตั้งค่า
`FB_COOKIES_JSON` ใน Settings > Variables and secrets ถูกต้องไหม (ต้อง copy เนื้อหาทั้งไฟล์ ไม่ใช่
แค่ path)

**อยาก redeploy หลังแก้โค้ด:**
```bash
git add .
git commit -m "update"
git push
```
Space จะ build ใหม่ให้อัตโนมัติ

**Space ขึ้น sleep บ่อยแม้ตั้ง pinger แล้ว** — เช็คว่า cron-job.org ตั้ง schedule เป็น "Every X
minutes" จริง ไม่ใช่รันวันละครั้ง (ปัญหาเดียวกับที่เจอตอนตั้งค่าให้ Render ก่อนหน้านี้)
