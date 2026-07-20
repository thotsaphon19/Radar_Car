# คู่มือ Deploy บน Oracle Cloud Free Tier (Always Free — ฟรีตลอดไป ไม่มีวันหมดอายุ)

เอกสารนี้สำหรับกรณีที่ Render free tier (512MB RAM) ไม่พอสำหรับรัน Facebook watcher (Puppeteer/Chrome)
พร้อมกันหลายตัว — Oracle Cloud แจก VM แบบ ARM (Ampere A1) **ฟรีสูงสุด 24GB RAM + 4 CPU core ตลอดไป**
ซึ่งเพียงพอมากสำหรับระบบนี้

⚠️ **ข้อแตกต่างสำคัญจาก Render:** Oracle Cloud ไม่ใช่ PaaS (ไม่มี "connect GitHub แล้ว deploy อัตโนมัติ")
ต้องตั้งเซิร์ฟเวอร์เองทุกขั้นตอน (SSH, ติดตั้ง Node.js, ตั้ง process manager, reverse proxy) คู่มือนี้
เขียนละเอียดที่สุดเท่าที่จะทำได้ ทำตามทีละขั้นได้เลย ไม่ต้องมีพื้นฐาน Linux มาก่อนก็ทำตามได้

---

## 1. สมัครบัญชี Oracle Cloud

1. ไปที่ https://www.oracle.com/cloud/free/ → กด **Start for free**
2. กรอกข้อมูล email, ประเทศ (เลือก Thailand) → กด verify email
3. กรอกข้อมูลบัตรเครดิต/เดบิต (Oracle ใช้ยืนยันตัวตนเท่านั้น **ไม่หักเงินถ้าอยู่ในโควตา Always Free**)
4. เลือก **Home Region** — แนะนำเลือกภูมิภาคที่ใกล้ไทยที่สุดที่มีให้เลือก (เช่น Singapore ถ้ามี) —
   **สำคัญ: เลือกแล้วเปลี่ยนทีหลังไม่ได้** เลือกให้ดีตั้งแต่แรก
5. รอระบบสร้างบัญชีเสร็จ (ปกติไม่กี่นาที)

---

## 2. สร้าง VM Instance (Always Free — ARM Ampere A1)

1. Login เข้า **Oracle Cloud Console** (https://cloud.oracle.com)
2. เมนูซ้ายบน (☰) → **Compute** → **Instances** → กด **Create Instance**
3. ตั้งค่า:
   - **Name**: ตั้งชื่อเอง เช่น `radar-car-vm`
   - **Image and shape** → กด **Edit**
     - **Image**: เลือก **Ubuntu** (เวอร์ชันล่าสุดที่มีให้ เช่น 22.04 หรือ 24.04)
     - **Shape**: กด **Change Shape** → เลือกแท็บ **Ampere** → เลือก **VM.Standard.A1.Flex**
     - ปรับ **OCPU** = 2, **Memory** = 12 GB (หรือจะใช้เต็ม 4 OCPU/24GB ก็ได้ ถ้าไม่ได้ใช้ VM อื่นในโควตา
       Always Free อยู่ — โควตารวมคือ 4 OCPU + 24GB ต่อบัญชี แบ่งเป็นกี่ VM ก็ได้)
   - **Networking**: ปล่อยค่า default (สร้าง VCN ใหม่ให้อัตโนมัติ)
   - **Add SSH keys**: เลือก **Generate a key pair for me** → กด **Save Private Key** (ดาวน์โหลดไฟล์
     `.key` เก็บไว้ให้ดี — ใช้ตอน SSH เข้าเครื่อง) และ **Save Public Key** ไว้ด้วย
4. กด **Create** → รอสัก 1-2 นาทีจนสถานะเป็น **Running** (จุดเขียว)
5. จด **Public IP Address** ของ instance ไว้ (แสดงอยู่ในหน้า instance details)

---

## 3. เปิด Firewall ให้เว็บเข้าถึงได้ (Security List)

Oracle บล็อก port ทุกอย่างยกเว้น SSH (22) เป็น default ต้องเปิดเองสำหรับ HTTP/HTTPS:

1. ในหน้า instance → เลื่อนลงหา **Virtual Cloud Network** → กดลิงก์ VCN ที่สร้างให้อัตโนมัติ
2. เมนูซ้าย → **Security Lists** → กด **Default Security List**
3. กด **Add Ingress Rules** เพิ่มทีละกฎ:
   - Rule 1: Source CIDR `0.0.0.0/0`, IP Protocol `TCP`, Destination Port Range `80`
   - Rule 2: Source CIDR `0.0.0.0/0`, IP Protocol `TCP`, Destination Port Range `443`
4. กด **Add Ingress Rules** บันทึก

---

## 4. SSH เข้า VM

**Windows:** ใช้ PowerShell หรือ Windows Terminal
**Mac/Linux:** ใช้ Terminal ปกติ

```bash
# ตั้งสิทธิ์ไฟล์ key ก่อน (ต้องทำครั้งเดียว มิฉะนั้น SSH จะปฏิเสธ)
chmod 400 /path/to/your-private-key.key

# SSH เข้าเครื่อง (username ของ Ubuntu image คือ ubuntu เสมอ)
ssh -i /path/to/your-private-key.key ubuntu@<PUBLIC_IP_ADDRESS>
```

ถ้าเจอคำถาม "Are you sure you want to continue connecting?" พิมพ์ `yes` แล้ว Enter

---

## 5. ติดตั้ง Node.js

```bash
# อัปเดตระบบก่อน
sudo apt update && sudo apt upgrade -y

# ติดตั้ง Node.js 20 LTS ผ่าน NodeSource (รองรับ ARM64 โดยตรง)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# ตรวจสอบว่าติดตั้งสำเร็จ
node -v    # ควรขึ้น v20.x.x
npm -v
```

---

## 6. ติดตั้ง Chromium (สำคัญมาก — เฉพาะ ARM ต้องใช้วิธีนี้)

Chrome ที่ Puppeteer ดาวน์โหลดเองส่วนใหญ่มีแต่ build สำหรับ x86_64 เท่านั้น บน ARM (Ampere) ต้องใช้
**Chromium ที่ระบบติดตั้งเองแทน**:

```bash
sudo apt install -y chromium-browser

# หา path ที่แน่นอนของ chromium (มักจะเป็น /usr/bin/chromium-browser หรือ /usr/bin/chromium)
which chromium-browser || which chromium
```

**จดบันทึก path ที่ได้ไว้** (จะใช้ตั้งค่า `PUPPETEER_EXECUTABLE_PATH` ในขั้นตอนที่ 9)

ติดตั้ง library เสริมที่ Chromium ต้องใช้ (กันปัญหา "error while loading shared libraries"):

```bash
sudo apt install -y libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
  libcairo2 libatspi2.0-0
```

---

## 7. เอาโค้ดขึ้น VM

**วิธีที่ 1 — ถ้ามี GitHub repo (แนะนำ):**
```bash
git clone https://github.com/<your-username>/<your-repo>.git deploy-package
cd deploy-package
```

**วิธีที่ 2 — อัปโหลดจากเครื่องตัวเองโดยตรง (ถ้าไม่ได้ใช้ Git):**
เปิด Terminal ใหม่ในเครื่องตัวเอง (ไม่ใช่ที่ SSH เข้า VM อยู่) แล้วรัน:
```bash
scp -i /path/to/your-private-key.key -r ./deploy-package ubuntu@<PUBLIC_IP_ADDRESS>:~/
```
รอจน upload เสร็จ แล้วกลับไปที่ SSH session เดิม `cd deploy-package`

---

## 8. ติดตั้ง dependencies

```bash
npm install
```

⚠️ **ไม่ต้องรัน** `npx puppeteer browsers install chrome` **บน ARM** เพราะเราจะใช้ Chromium ของระบบแทน
(ตั้งค่าในขั้นตอนถัดไป) — ถ้ารันไปก็ไม่เป็นไร เผื่อไว้เฉยๆ ไม่ได้ใช้จริง

---

## 9. ตั้งค่า `.env.local`

```bash
cp .env.local.example .env.local
nano .env.local
```

ใน `nano` (ตัวแก้ไขข้อความในเทอร์มินัล) ตั้งค่าตามนี้ — ใช้ปุ่มลูกศรเลื่อน, กด `Ctrl+O` แล้ว Enter เพื่อ
บันทึก, `Ctrl+X` เพื่อออก:

```dotenv
SESSION_SECRET=<รันคำสั่ง: openssl rand -hex 32 แล้วเอาผลลัพธ์มาใส่>
UPSTASH_REDIS_REST_URL=<จาก Upstash>
UPSTASH_REDIS_REST_TOKEN=<จาก Upstash>
LOGS_VIEWER_USER=<ตั้งเอง>
LOGS_VIEWER_PASS=<ตั้งเอง>

# ⚠️ สำคัญมากสำหรับ ARM — ชี้ไปที่ Chromium ที่ apt ติดตั้งให้ (path ที่จดไว้ในขั้นตอน 6)
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

FB_COOKIES_PATH=/home/ubuntu/deploy-package/fb-cookies.json

APIFY_TOKEN=<ถ้าจะใช้>
APIFY_MARKETPLACE_ACTOR_ID=get-leads/all-in-one-facebook-scraper
APIFY_GROUP_ACTOR_ID=<ถ้ามี>
BRIGHTDATA_API_TOKEN=<ถ้าจะใช้>
```

---

## 10. เอาไฟล์ `fb-cookies.json` ขึ้น VM (ง่ายกว่า Render มาก — ไม่ต้องใช้ Secret Files)

เปิด Terminal ใหม่ในเครื่องตัวเอง (ไม่ใช่ SSH session):
```bash
scp -i /path/to/your-private-key.key ./fb-cookies.json ubuntu@<PUBLIC_IP_ADDRESS>:~/deploy-package/fb-cookies.json
```
เสร็จแล้วกลับไปที่ SSH session เดิม ตรวจสอบว่าไฟล์อยู่จริง:
```bash
ls -la ~/deploy-package/fb-cookies.json
```

---

## 11. ทดสอบรันก่อน (ยังไม่ต้องตั้ง PM2)

```bash
node server.js
```

ควรเห็น `🌐 แดชบอร์ด: http://localhost:3000` — กด `Ctrl+C` เพื่อหยุดแล้วไปขั้นตอนถัดไป (ตั้งให้รันค้าง
ไว้ตลอดผ่าน PM2 แทนที่จะรันตรงๆ แบบนี้ซึ่งจะหยุดทันทีที่ปิด SSH)

---

## 12. ตั้งค่า PM2 (ให้รันค้างตลอดเวลา + auto-restart ถ้า crash + auto-start ตอนเครื่อง reboot)

```bash
# ติดตั้ง PM2 แบบ global
sudo npm install -g pm2

# เริ่มรันแอปผ่าน PM2
cd ~/deploy-package
pm2 start server.js --name radar-car

# ตั้งให้ PM2 จำ process list ปัจจุบันไว้
pm2 save

# ตั้งให้ PM2 auto-start ตอนเครื่อง reboot (รันคำสั่งที่ pm2 startup แสดงผลออกมา copy มารันอีกที)
pm2 startup
# ↑ คำสั่งนี้จะพิมพ์คำสั่งอีกบรรทัดออกมาให้ copy ไปรันต่อ (ขึ้นต้นด้วย sudo env PATH=...)
#   copy บรรทัดนั้นมารันเลย แล้วรัน pm2 save อีกครั้ง
```

**คำสั่ง PM2 ที่ใช้บ่อย:**
```bash
pm2 status              # ดูสถานะ
pm2 logs radar-car       # ดู log แบบ live (เหมือน /logs.html แต่ดูจาก terminal)
pm2 restart radar-car    # รีสตาร์ท
pm2 stop radar-car       # หยุด
```

---

## 13. ตั้ง Nginx เป็น reverse proxy (ให้เข้าเว็บผ่าน port 80 ปกติแทนพิมพ์ :3000 ต่อท้าย)

```bash
sudo apt install -y nginx

sudo nano /etc/nginx/sites-available/radar-car
```

วางเนื้อหานี้ในไฟล์ (แทนที่ `your-domain.com` ด้วยโดเมนจริงถ้ามี หรือใช้ Public IP ก็ได้):
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

บันทึก (`Ctrl+O`, Enter, `Ctrl+X`) แล้วเปิดใช้งาน:
```bash
sudo ln -s /etc/nginx/sites-available/radar-car /etc/nginx/sites-enabled/
sudo nginx -t          # ทดสอบว่า config ไม่มี syntax error
sudo systemctl restart nginx
```

**เปิด firewall ของ Ubuntu เองด้วย** (คนละชั้นกับ Security List ของ Oracle ในขั้นตอน 3 — ต้องเปิดทั้ง 2 ที่):
```bash
sudo ufw allow 'Nginx Full'
sudo ufw allow OpenSSH
sudo ufw enable
```

ตอนนี้เข้าเว็บผ่าน `http://<PUBLIC_IP_ADDRESS>` ได้แล้วโดยไม่ต้องพิมพ์ `:3000`

---

## 14. ตั้ง SSL (HTTPS) — ต้องมีโดเมนชื่อจริง (Let's Encrypt ออกใบรับรองให้ IP เปล่าๆ ไม่ได้)

ถ้ามีโดเมน ให้ไปตั้งค่า DNS ของโดเมนนั้น (A record) ชี้ไปที่ Public IP ของ VM ก่อน รอ DNS อัปเดต
(propagate) สัก 5-30 นาที แล้วค่อยรันคำสั่งนี้:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

ทำตามคำถามที่ certbot ถาม (ใส่ email, ยอมรับเงื่อนไข) — เสร็จแล้วจะได้ HTTPS อัตโนมัติ พร้อมต่ออายุ
ใบรับรองให้เองทุก 90 วัน

ถ้ายังไม่มีโดเมน ข้ามขั้นตอนนี้ไปก่อนได้ ใช้ `http://` ผ่าน IP ตรงๆ ไปพลางๆ

---

## 15. ตั้ง external pinger (ไม่บังคับสำหรับ VM แบบนี้)

ต่างจาก Render free tier ตรงที่ **VM ของ Oracle ไม่หลับเองเลย** (รันตลอด 24/7 จริง) เพราะงั้น
**ไม่จำเป็นต้องตั้ง cron-job.org ปิงกันหลับแบบ Render** — ยกเลิก/ไม่ต้องตั้งก็ได้ (แต่ถ้าอยากมี
monitoring เผื่อเช็คว่าเว็บล่มไหมก็ยังตั้งได้ตามปกติ ไม่มีผลเสีย)

---

## 16. Checklist ทดสอบสุดท้าย

1. เข้า `http://<PUBLIC_IP หรือโดเมน>` — เห็นหน้า login ไหม
2. เข้า `/logs.html` (login ด้วย LOGS_VIEWER_USER/PASS) — เห็น log แบบ live ไหม
3. เข้า `/health.html` — เปิด provider ที่ต้องการ (Watcher ทั้ง Marketplace และ Group เปิดพร้อมกันได้เลย
   เพราะมี RAM เหลือเฟือแล้ว)
4. เช็คว่าเห็น `✅ ใช้ cookies บัญชีจริง login สำเร็จ`
5. รอสักครู่ เข้าหน้าแรก `/` เช็คว่ามีรถขึ้นมาพร้อมรูปภาพจากทุกแหล่ง

---

## แก้ปัญหาที่พบบ่อย

**`pm2: command not found`** — ลอง `sudo npm install -g pm2` ใหม่ หรือเปิด SSH session ใหม่

**Chromium error "cannot open display"** — ตรวจสอบว่า `.env.local` ตั้ง `FB_HEADLESS` เป็นค่า default
(ไม่ได้ตั้ง `false`) เพราะ VM ไม่มีจอ ต้องรันแบบ headless เท่านั้น

**`error while loading shared libraries`** — กลับไปรันคำสั่งติดตั้ง library เสริมในขั้นตอน 6 อีกครั้ง

**เว็บเข้าไม่ได้เลยจาก IP** — เช็คว่าเปิด Security List (ขั้นตอน 3) และ `ufw` (ขั้นตอน 13) ครบทั้ง 2 ที่
แล้ว (ลืมอันใดอันหนึ่งบ่อยที่สุด)

**อยาก redeploy โค้ดใหม่หลังแก้ไฟล์** —
```bash
cd ~/deploy-package
git pull            # หรือ scp ไฟล์ใหม่ทับ
npm install         # เผื่อมี dependency ใหม่
pm2 restart radar-car
```
