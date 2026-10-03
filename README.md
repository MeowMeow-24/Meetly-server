# Meetly Server (Node.js + PostgreSQL) — สำหรับ deploy บน Railway

API ตัวเดียวแทน Google Apps Script เดิม ใช้ชื่อ action เดิมทั้งหมด แอป Flutter เปลี่ยนแค่ `API_URL`

## Deploy บน Railway (ประมาณ 5 นาที)
1. นำโฟลเดอร์นี้ขึ้น GitHub (ถ้ารวมกับ repo อื่น ให้ตั้ง Root Directory เป็น `meetly_server`)
2. railway.com → **New Project → Deploy from GitHub repo** เลือก repo นี้
3. ในโปรเจกต์เดียวกัน กด **+ New → Database → Add PostgreSQL**
4. เปิดบริการ API → แท็บ **Variables** แล้วเพิ่ม
   | ตัวแปร | ค่า |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `JWT_SECRET` | ข้อความสุ่มยาวๆ (ห้ามใช้ค่าเริ่มต้น) |
   | `ADMIN_EMAILS` | อีเมลแอดมินจริง คั่นด้วยจุลภาค |
   | `DEMO_LOGIN` | `true` (เฉพาะตอนพรีเซนต์) |
5. แท็บ **Settings → Networking → Generate Domain** จะได้ URL เช่น `https://meetly-xxxx.up.railway.app`
6. เปิด `<URL>/health` ต้องได้ `{"ok":true}` ตารางและห้องตัวอย่างถูกสร้างอัตโนมัติตอนเริ่มระบบ

## รันแอป Flutter
```
flutter run --dart-define=API_URL=https://meetly-xxxx.up.railway.app --dart-define=DEMO=true
```
- `DEMO=true` แสดงปุ่ม "ทดลองใช้" (ผู้ใช้ / ผู้ดูแล) ข้ามการล็อกอิน Google ได้
- สร้างไฟล์ติดตั้ง: `flutter build apk --dart-define=API_URL=... --dart-define=DEMO=true`

## หลังพรีเซนต์
ตั้ง `DEMO_LOGIN=false` ไม่เช่นนั้นใครก็ล็อกอินเป็นแอดมินทดลองได้

## รันในเครื่อง
```
npm install
DATABASE_URL=postgres://... DEMO_LOGIN=true npm start
```

## ย้ายข้อมูลเดิมจาก Google Sheets
ชื่อคอลัมน์ในตาราง `Rooms`, `Bookings`, `Users` ตรงกับหัวชีตที่เว็บเดิมใช้ จึง export CSV แล้วนำเข้าด้วย `\copy` ของ psql หรือเมนู Data ของ Railway ได้ (นำเข้า Rooms ก่อน Bookings)

## สิ่งที่เซิร์ฟเวอร์ตรวจให้ (เดิมเช็กแค่ฝั่งเว็บ)
เวลา 08:00–18:00 (เขตเวลาไทย), ห้ามจองย้อนหลัง, ความจุห้อง, จองซ้อนทั้งห้องและตัวผู้จองเอง (ล็อกแถวห้อง กันจองชนพร้อมกัน), สิทธิ์แอดมิน, ราคาอ้างอิงจากตารางห้อง ไม่เชื่อค่าที่แอปส่งมา
