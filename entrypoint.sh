#!/bin/sh
# entrypoint.sh — รันก่อน node server.js ทุกครั้งที่ container เริ่มทำงาน
#
# เขียนไฟล์ fb-cookies.json จาก secret env var FB_COOKIES_JSON (ถ้าตั้งไว้) ก่อนสตาร์ทเซิร์ฟเวอร์จริง
# ทำแบบนี้แทนที่จะ commit ไฟล์ fb-cookies.json ตรงๆ ลง git repo เพื่อความปลอดภัย (แม้ Space จะตั้ง
# เป็น Private ก็ตาม — ป้องกันเผื่อเปลี่ยนเป็น Public ทีหลังโดยไม่ได้ตั้งใจ)
#
# วิธีตั้งค่า FB_COOKIES_JSON: เปิดไฟล์ fb-cookies.json ในเครื่อง copy เนื้อหาทั้งหมด (JSON array
# ทั้งก้อน) ไปวางเป็น "Secret" ใน HF Space Settings > Variables and secrets (ดู DEPLOY_HUGGINGFACE.md)

set -e

if [ -n "$FB_COOKIES_JSON" ]; then
  echo "$FB_COOKIES_JSON" > /app/fb-cookies.json
  export FB_COOKIES_PATH=/app/fb-cookies.json
  echo "✅ เขียน fb-cookies.json จาก secret env var เรียบร้อย"
else
  echo "ℹ️  ไม่พบ FB_COOKIES_JSON — จะสแกนแบบ guest (ไม่ login) แทน"
fi

exec node server.js
