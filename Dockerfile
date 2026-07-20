# Dockerfile สำหรับ deploy บน Hugging Face Spaces (Docker SDK)
# ดูคู่มือเต็มได้ที่ DEPLOY_HUGGINGFACE.md

FROM node:20-bookworm-slim

# ติดตั้ง Chromium ของระบบ + library ที่ Puppeteer ต้องใช้ (แทนที่จะให้ Puppeteer ดาวน์โหลด Chrome
# เอง ซึ่งบางครั้งดาวน์โหลดไม่สำเร็จ/ช้าตอน build บน hosting บางเจ้า — ใช้ Chromium จาก apt แทน
# เชื่อถือได้กว่าและ build เร็วกว่า)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# ชี้ Puppeteer ไปใช้ Chromium ของระบบที่เพิ่งติดตั้ง แทน Chrome ที่ปกติจะดาวน์โหลดเอง
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Hugging Face Spaces (Docker SDK) คาดหวังให้แอปฟังที่ port 7860 เป็น default
ENV PORT=7860

WORKDIR /app

# copy แค่ package.json ก่อนเพื่อให้ Docker cache layer นี้ไว้ (ถ้าไม่แก้ dependency จะไม่ต้องรัน
# npm install ใหม่ทุกครั้งที่ build ทำให้ build เร็วขึ้นมากในรอบถัดๆ ไป)
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# เขียนไฟล์ fb-cookies.json จาก secret env var (FB_COOKIES_JSON) ก่อนสตาร์ทเซิร์ฟเวอร์จริง —
# ดู entrypoint.sh + คำอธิบายเต็มใน DEPLOY_HUGGINGFACE.md ว่าทำไมต้องทำแบบนี้ (กันไฟล์ cookies
# จริงหลุดไปอยู่ใน image/git repo ตรงๆ)
RUN chmod +x /app/entrypoint.sh

EXPOSE 7860

ENTRYPOINT ["/app/entrypoint.sh"]
