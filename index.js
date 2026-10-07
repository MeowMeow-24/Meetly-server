const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const scrypt = require('util').promisify(crypto.scrypt);

types.setTypeParser(1082, (v) => v);            // DATE → 'YYYY-MM-DD'
types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC → number

const {
  DATABASE_URL, PGSSL, PORT = 3000,
  JWT_SECRET = 'dev-secret-change-me',
  GOOGLE_CLIENT_ID = '593161598887-sdk2tei3d7unugpurlq8tkjmpbmv691u.apps.googleusercontent.com',
  ALLOWED_DOMAIN = 'udru.ac.th', ADMIN_EMAILS = '', DEMO_LOGIN = 'false', SEED = 'true', ALLOW_PIN_SIGNUP = 'true',
} = process.env;

const db = new Pool({ connectionString: DATABASE_URL, ssl: PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
const gClient = new OAuth2Client();

// ───────── schema (ชื่อคอลัมน์ตรงกับหัวชีตเดิม นำเข้า CSV ได้ตรงๆ) ─────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS "Users"(
  "Email" TEXT PRIMARY KEY, "FullName" TEXT NOT NULL, "Status" TEXT, "Faculty" TEXT, "Major" TEXT, "Phone" TEXT,
  "Role" TEXT NOT NULL DEFAULT 'user', "CreatedAt" TIMESTAMPTZ DEFAULT now());
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "AuthType" TEXT NOT NULL DEFAULT 'google';
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "PinHash" TEXT;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "FailCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "LockedUntil" TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS "Rooms"(
  "RoomID" TEXT PRIMARY KEY, "RoomName" TEXT NOT NULL, "Capacity" INTEGER DEFAULT 1, "PricePerRound" NUMERIC(10,2) DEFAULT 0,
  "Status" TEXT DEFAULT 'active', "Location" TEXT DEFAULT '', "Equipment" TEXT DEFAULT '', "Description" TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS "Bookings"(
  "BookingID" TEXT PRIMARY KEY, "RoomID" TEXT NOT NULL REFERENCES "Rooms"("RoomID"), "UserName" TEXT, "UserEmail" TEXT NOT NULL,
  "Date" DATE NOT NULL, "StartTime" TEXT NOT NULL, "EndTime" TEXT NOT NULL, "Attendees" INTEGER DEFAULT 1, "Purpose" TEXT DEFAULT '',
  "PricePerRound" NUMERIC(10,2) DEFAULT 0, "TotalPrice" NUMERIC(10,2) DEFAULT 0, "Status" TEXT NOT NULL DEFAULT 'pending',
  "CreatedAt" TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS bookings_room_date ON "Bookings"("RoomID","Date");`;

// ───────── helpers ─────────
const fail = (m) => { throw Object.assign(new Error(m), { user: true }); };
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const rid = (p) => p + crypto.randomBytes(4).toString('hex').toUpperCase();
const sign = (email) => jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
const pubUser = (u) => ({ Email: u.Email, FullName: u.FullName, Status: u.Status, Faculty: u.Faculty, Major: u.Major, Phone: u.Phone, Role: u.Role, AuthType: u.AuthType });
const isAdminEmail = (e) => ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(String(e).toLowerCase());
const needUser = (u) => u || fail('กรุณาเข้าสู่ระบบ');
const needAdmin = (u) => (needUser(u).Role === 'admin' ? u : fail('เฉพาะผู้ดูแลระบบเท่านั้น'));

// ───────── PIN 6 หลัก (บัญชีที่ไม่ใช้ Google) ─────────
const normPhone = (p) => String(p || '').replace(/[\s-]/g, '');
const phoneEmail = (p) => `${p}@pin.local`; // ใช้เป็นตัวระบุผู้ใช้ภายใน ให้เข้ากับตารางเดิม
const weakPin = (p) => /^(\d)\1{5}$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p);
function checkPinFormat(pin) {
  if (!/^\d{6}$/.test(String(pin || ''))) fail('PIN ต้องเป็นตัวเลข 6 หลัก');
  if (weakPin(String(pin))) fail('PIN เดาง่ายเกินไป (เช่น 123456 หรือเลขซ้ำ) กรุณาตั้งใหม่');
}
async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + (await scrypt(String(pin), salt, 32)).toString('hex');
}
async function verifyPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const got = await scrypt(String(pin), Buffer.from(salt, 'hex'), 32), want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const MAX_TRIES = 5;

function bkk() { // เวลาไทย (เซิร์ฟเวอร์ Railway เป็น UTC)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

async function verifyGoogle(credential) {
  if (!credential) fail('ไม่พบข้อมูลบัญชี Google');
  let payload;
  try { payload = (await gClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID })).getPayload(); }
  catch { fail('ตรวจสอบบัญชี Google ไม่สำเร็จ'); }
  const email = String(payload.email || '').toLowerCase();
  if (!payload.email_verified || !email.endsWith('@' + ALLOWED_DOMAIN)) fail(`ใช้ได้เฉพาะบัญชี @${ALLOWED_DOMAIN}`);
  return { email, name: payload.name || '' };
}

async function userFromToken(token) {
  if (!token) return null;
  try {
    const { email } = jwt.verify(token, JWT_SECRET);
    return (await db.query('SELECT * FROM "Users" WHERE "Email"=$1', [email])).rows[0] || null;
  } catch { return null; }
}

async function ensureRole(u) {
  if (isAdminEmail(u.Email) && u.Role !== 'admin') {
    u = (await db.query('UPDATE "Users" SET "Role"=\'admin\' WHERE "Email"=$1 RETURNING *', [u.Email])).rows[0];
  }
  return u;
}

// ───────── actions (ชื่อเดียวกับ Apps Script เดิม) ─────────
const actions = {
  async GET({ user }) {
    const rooms = (await db.query('SELECT * FROM "Rooms" ORDER BY "RoomName"')).rows;
    const bookings = (await db.query('SELECT * FROM "Bookings" ORDER BY "Date","StartTime"')).rows;
    const users = user?.Role === 'admin'
      ? (await db.query('SELECT * FROM "Users"')).rows.map(pubUser)
      : (await db.query('SELECT "Email","Faculty","Status" FROM "Users"')).rows;
    return { success: true, rooms, bookings, users };
  },

  async googleLogin({ body }) {
    const g = await verifyGoogle(body.credential);
    let u = (await db.query('SELECT * FROM "Users" WHERE "Email"=$1', [g.email])).rows[0];
    if (!u) return { success: false, requiresProfile: true, profile: { FullName: g.name, Email: g.email } };
    u = await ensureRole(u);
    return { success: true, user: pubUser(u), token: sign(u.Email) };
  },

  async googleCompleteProfile({ body }) {
    const g = await verifyGoogle(body.credential);
    const { fullName, status, faculty, major, phone } = body;
    if (![fullName, status, faculty, major, phone].every((v) => String(v || '').trim())) fail('กรุณากรอกข้อมูลให้ครบ');
    const role = isAdminEmail(g.email) ? 'admin' : 'user';
    const u = (await db.query(
      `INSERT INTO "Users"("Email","FullName","Status","Faculty","Major","Phone","Role") VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT("Email") DO UPDATE SET "FullName"=$2,"Status"=$3,"Faculty"=$4,"Major"=$5,"Phone"=$6 RETURNING *`,
      [g.email, fullName.trim(), status, faculty.trim(), major.trim(), phone.trim(), role])).rows[0];
    return { success: true, user: pubUser(u), token: sign(u.Email) };
  },

  async demoLogin({ body }) { // ใช้เฉพาะตอนพรีเซนต์ — ปิดด้วย DEMO_LOGIN=false
    if (DEMO_LOGIN !== 'true') fail('โหมดทดลองถูกปิดอยู่');
    const admin = body.role === 'admin';
    const email = `demo.${admin ? 'admin' : 'user'}@${ALLOWED_DOMAIN}`;
    const u = (await db.query(
      `INSERT INTO "Users"("Email","FullName","Status","Faculty","Major","Phone","Role") VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT("Email") DO UPDATE SET "Role"=$7 RETURNING *`,
      [email, admin ? 'ผู้ดูแลระบบ (ทดลอง)' : 'ผู้ใช้ทดลอง', admin ? 'บุคลากร' : 'นักศึกษา', 'วิศวกรรมศาสตร์', 'วิศวกรรมคอมพิวเตอร์', '0800000000', admin ? 'admin' : 'user'])).rows[0];
    return { success: true, user: pubUser(u), token: sign(email) };
  },

  async pinRegister({ body }) {
    if (ALLOW_PIN_SIGNUP !== 'true') fail('ขณะนี้ปิดรับสมัครด้วย PIN');
    const phone = normPhone(body.phone);
    const { fullName, status, faculty, major } = body;
    if (![fullName, status, faculty, major].every((v) => String(v || '').trim())) fail('กรุณากรอกข้อมูลให้ครบ');
    if (!/^0\d{9}$/.test(phone)) fail('เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก ขึ้นต้นด้วย 0');
    checkPinFormat(body.pin);
    const r = await db.query(
      `INSERT INTO "Users"("Email","FullName","Status","Faculty","Major","Phone","Role","AuthType","PinHash") VALUES($1,$2,$3,$4,$5,$6,'user','pin',$7)
       ON CONFLICT("Email") DO NOTHING RETURNING *`,
      [phoneEmail(phone), fullName.trim(), status, faculty.trim(), major.trim(), phone, await hashPin(body.pin)]);
    if (!r.rows[0]) fail('เบอร์นี้สมัครไว้แล้ว กรุณาเข้าสู่ระบบ');
    return { success: true, user: pubUser(r.rows[0]), token: sign(r.rows[0].Email) };
  },

  async pinLogin({ body }) {
    const bad = 'เบอร์โทรหรือ PIN ไม่ถูกต้อง';
    const u = (await db.query('SELECT * FROM "Users" WHERE "Email"=$1 AND "AuthType"=\'pin\'', [phoneEmail(normPhone(body.phone))])).rows[0];
    if (!u) fail(bad);
    if (u.LockedUntil && new Date(u.LockedUntil) > new Date()) {
      fail(`ใส่ PIN ผิดหลายครั้ง กรุณาลองใหม่ในอีก ${Math.ceil((new Date(u.LockedUntil) - Date.now()) / 60000)} นาที`);
    }
    if (!(await verifyPin(body.pin, u.PinHash))) {
      const n = (await db.query('UPDATE "Users" SET "FailCount"="FailCount"+1 WHERE "Email"=$1 RETURNING "FailCount"', [u.Email])).rows[0].FailCount;
      if (n >= MAX_TRIES) {
        await db.query('UPDATE "Users" SET "FailCount"=0,"LockedUntil"=now()+interval \'15 minutes\' WHERE "Email"=$1', [u.Email]);
        fail(`ใส่ PIN ผิดครบ ${MAX_TRIES} ครั้ง ระบบล็อกบัญชี 15 นาที`);
      }
      fail(`${bad} (เหลืออีก ${MAX_TRIES - n} ครั้ง)`);
    }
    await db.query('UPDATE "Users" SET "FailCount"=0,"LockedUntil"=NULL WHERE "Email"=$1', [u.Email]);
    return { success: true, user: pubUser(u), token: sign(u.Email) };
  },

  async changePin({ user, body }) {
    needUser(user);
    if (user.AuthType !== 'pin') fail('บัญชี Google ไม่มี PIN');
    if (!(await verifyPin(body.oldPin, user.PinHash))) fail('PIN เดิมไม่ถูกต้อง');
    checkPinFormat(body.newPin);
    await db.query('UPDATE "Users" SET "PinHash"=$2 WHERE "Email"=$1', [user.Email, await hashPin(body.newPin)]);
    return { success: true };
  },

  async updateProfile({ user, body }) {
    needUser(user);
    const { FullName, Status, Phone, Faculty, Major } = body;
    if (![FullName, Status, Phone, Faculty, Major].every((v) => String(v || '').trim())) fail('กรุณากรอกข้อมูลให้ครบ');
    const u = (await db.query(
      'UPDATE "Users" SET "FullName"=$2,"Status"=$3,"Phone"=$4,"Faculty"=$5,"Major"=$6 WHERE "Email"=$1 RETURNING *',
      [user.Email, FullName.trim(), Status, user.AuthType === 'pin' ? user.Phone : Phone.trim(), Faculty.trim(), Major.trim()])).rows[0];
    return { success: true, user: pubUser(u) };
  },

  async book({ user, body }) {
    needUser(user);
    const { RoomID, Date: date, StartTime: s, EndTime: e } = body;
    const att = parseInt(body.Attendees, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(s) || !/^\d{2}:\d{2}$/.test(e)) fail('ข้อมูลวันเวลาไม่ถูกต้อง');
    if (toMin(s) < 480 || toMin(e) > 1080 || toMin(s) >= toMin(e)) fail('เวลาจองต้องอยู่ระหว่าง 08:00 - 18:00 น.');
    const now = bkk();
    if (date < now.date) fail('ไม่สามารถจองย้อนหลังได้');
    if (date === now.date && now.min >= 1080) fail('ปิดรับจองสำหรับวันนี้แล้ว (หลัง 18:00 น.)');
    if (date === now.date && toMin(s) < now.min) fail('ไม่สามารถเลือกเวลาที่ผ่านไปแล้วได้');

    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const room = (await c.query('SELECT * FROM "Rooms" WHERE "RoomID"=$1 FOR UPDATE', [RoomID])).rows[0]; // ล็อกห้อง กันจองซ้อนพร้อมกัน
      if (!room || room.Status === 'inactive') fail('ห้องนี้ไม่เปิดให้จอง');
      if (!(att >= 1) || (room.Capacity > 0 && att > room.Capacity)) fail(`${room.RoomName} รองรับได้สูงสุด ${room.Capacity} คน`);
      const clash = (await c.query(
        `SELECT "RoomID","StartTime","EndTime" FROM "Bookings"
         WHERE "Date"=$1 AND "Status" IN ('pending','confirmed') AND "StartTime"<$3 AND "EndTime">$2 AND ("RoomID"=$4 OR "UserEmail"=$5)`,
        [date, s, e, RoomID, user.Email])).rows;
      if (clash.some((r) => r.RoomID === RoomID)) fail('ช่วงเวลานี้ถูกจองแล้ว กรุณาเลือกช่วงเวลาอื่น');
      if (clash.length) fail(`คุณมีการจองในช่วงเวลา ${clash[0].StartTime}-${clash[0].EndTime} น. ไปแล้ว`);
      const b = (await c.query(
        `INSERT INTO "Bookings"("BookingID","RoomID","UserName","UserEmail","Date","StartTime","EndTime","Attendees","Purpose","PricePerRound","TotalPrice","Status")
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,'pending') RETURNING *`,
        [rid('BK'), RoomID, user.FullName, user.Email, date, s, e, att, String(body.Purpose || '').slice(0, 200), room.PricePerRound])).rows[0];
      await c.query('COMMIT');
      return { success: true, booking: b };
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
  },

  async cancel({ user, body }) {
    needUser(user);
    const b = (await db.query('SELECT * FROM "Bookings" WHERE "BookingID"=$1', [body.BookingID])).rows[0];
    if (!b) fail('ไม่พบรายการจอง');
    if (b.UserEmail !== user.Email && user.Role !== 'admin') fail('ไม่มีสิทธิ์ยกเลิกรายการนี้');
    if (b.Date < bkk().date) fail('ไม่สามารถยกเลิกรายการที่ถึงวันใช้งานแล้วได้');
    await db.query('UPDATE "Bookings" SET "Status"=\'cancelled\' WHERE "BookingID"=$1', [b.BookingID]);
    return { success: true };
  },

  async adminSetBookingStatus({ user, body }) {
    needAdmin(user);
    if (!['confirmed', 'rejected', 'cancelled'].includes(body.Status)) fail('สถานะไม่ถูกต้อง');
    const r = await db.query('UPDATE "Bookings" SET "Status"=$2 WHERE "BookingID"=$1', [body.BookingID, body.Status]);
    if (!r.rowCount) fail('ไม่พบรายการจอง');
    return { success: true };
  },

  async adminSaveRoom({ user, body }) {
    needAdmin(user);
    if (!String(body.RoomName || '').trim()) fail('กรุณากรอกชื่อห้อง');
    const id = String(body.RoomID || '').trim() || rid('RM');
    const status = String(body.Status).toLowerCase() === 'inactive' ? 'inactive' : 'active';
    await db.query(
      `INSERT INTO "Rooms"("RoomID","RoomName","Capacity","PricePerRound","Status","Location","Equipment","Description") VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT("RoomID") DO UPDATE SET "RoomName"=$2,"Capacity"=$3,"PricePerRound"=$4,"Status"=$5,"Location"=$6,"Equipment"=$7,"Description"=$8`,
      [id, body.RoomName.trim(), Math.max(0, parseInt(body.Capacity, 10) || 0), Math.max(0, Number(body.PricePerRound) || 0), status,
        body.Location || '', body.Equipment || '', body.Description || '']);
    return { success: true, RoomID: id };
  },
};

// ───────── server ─────────
const app = express();
app.use(cors());
app.use(express.json({ type: () => true })); // แอปส่ง text/plain มาเหมือน Apps Script เดิม

app.get('/health', (_, res) => res.json({ ok: true }));
app.all('/', async (req, res) => {
  const body = req.body || {};
  const action = req.method === 'GET' ? 'GET' : body.action;
  try {
    const fn = Object.hasOwn(actions, action) ? actions[action] : fail('ไม่รู้จักคำสั่ง: ' + action);
    const user = await userFromToken(req.method === 'GET' ? req.query.token : body.token);
    res.json(await fn({ user, body }));
  } catch (err) {
    if (!err.user) console.error(err);
    res.json({ success: false, message: err.user ? err.message : 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
  }
});

async function init() {
  await db.query(SCHEMA);
  if (SEED === 'false') return;
  if (!(await db.query('SELECT 1 FROM "Rooms" LIMIT 1')).rowCount) {
    const rooms = [
      ['R001', 'ห้องประชุม A', 10, 300, 'อาคาร 8 ชั้น 2', 'โปรเจกเตอร์, Wi-Fi'],
      ['R002', 'ห้องประชุม B', 20, 450, 'อาคาร 8 ชั้น 3', 'โปรเจกเตอร์, ไมโครโฟน, Wi-Fi'],
      ['R003', 'ห้องสัมมนา', 50, 800, 'อาคารเรียนรวม ชั้น 1', 'เครื่องเสียง, จอ LED'],
      ['R004', 'ห้องประชุมใหญ่', 100, 1200, 'หอประชุม ชั้น 2', 'เวที, เครื่องเสียง, Live stream'],
    ];
    for (const r of rooms) await db.query('INSERT INTO "Rooms"("RoomID","RoomName","Capacity","PricePerRound","Location","Equipment") VALUES($1,$2,$3,$4,$5,$6)', r);
    console.log('seeded rooms');
  }
  if (DEMO_LOGIN === 'true' && !(await db.query('SELECT 1 FROM "Bookings" LIMIT 1')).rowCount) { // ข้อมูลตัวอย่างให้หน้าจอดูไม่โล่ง
    const t = bkk().date;
    const demo = [
      ['R001', 'สมชาย ใจดี', 'somchai@' + ALLOWED_DOMAIN, addDays(t, 1), '09:00', '11:00', 8, 'ประชุมทีมโปรเจกต์', 'confirmed'],
      ['R002', 'สมหญิง รักเรียน', 'somying@' + ALLOWED_DOMAIN, addDays(t, 1), '13:00', '15:00', 15, 'ติวสอบกลางภาค', 'pending'],
      ['R003', 'วิชัย พัฒนา', 'wichai@' + ALLOWED_DOMAIN, addDays(t, 2), '10:00', '12:00', 40, 'สัมมนาวิชาการ', 'confirmed'],
    ];
    for (const d of demo) {
      const price = (await db.query('SELECT "PricePerRound" FROM "Rooms" WHERE "RoomID"=$1', [d[0]])).rows[0].PricePerRound;
      await db.query(
        `INSERT INTO "Bookings"("BookingID","RoomID","UserName","UserEmail","Date","StartTime","EndTime","Attendees","Purpose","Status","PricePerRound","TotalPrice")
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`, [rid('BK'), ...d, price]);
    }
  }
}

init().then(() => app.listen(PORT, () => console.log('Meetly API on :' + PORT))).catch((e) => { console.error('init failed', e); process.exit(1); });
