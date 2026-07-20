/**
 * authStore.js — จัดการบัญชีผู้ใช้ (login) เก็บถาวรผ่าน Upstash Redis (ดู redisStore.js สำหรับวิธีตั้งค่า)
 * รหัสผ่านเก็บแบบ hash ด้วย bcrypt เท่านั้น ไม่เก็บ plain text เด็ดขาด
 *
 * รูปแบบการทำงาน: โหลดข้อมูลจาก Redis เข้าหน่วยความจำครั้งเดียวตอนเริ่มเซิร์ฟเวอร์ (init())
 * จากนั้นอ่านข้อมูล (listUsers/findByUsername/verifyLogin) เร็วจากหน่วยความจำโดยตรง
 * ส่วนการเขียน (createUser/deleteUser/changePassword) จะอัปเดตหน่วยความจำก่อน แล้วค่อยบันทึกลง Redis
 * ตามหลัง — ประหยัดโควตาการเรียก Redis (ฟรี 500,000 ครั้ง/เดือน) ไปมากเพราะไม่อ่านซ้ำทุก request
 *
 * ติดตั้งก่อนใช้งาน: npm install bcryptjs @upstash/redis
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getJSON, setJSON } = require('./redisStore');

const KEY = 'car-radar:users';

let users = [];
let initialized = false;

async function init() {
  if (initialized) return;
  const raw = await getJSON(KEY, []);
  users = Array.isArray(raw) ? raw : [];

  // log วินิจฉัย — ช่วยให้เห็นทันทีว่าโหลด user จาก Redis มาได้กี่คน ใครบ้าง แทนที่จะต้องเดา
  console.log(`🔍 [authStore] โหลดข้อมูลผู้ใช้จาก Redis: ${users.length} คน${users.length > 0 ? ' (' + users.map(u => u.username).join(', ') + ')' : ''}`);
  if (!Array.isArray(raw)) {
    console.log(`⚠️ [authStore] ข้อมูลที่โหลดมาจาก Redis ไม่ใช่ array ที่ถูกต้อง (ได้ ${typeof raw}) — จะสร้างบัญชี admin ใหม่แทน ข้อมูลเดิมอาจเสียหาย`);
  }

  // สร้างบัญชี admin เริ่มต้นอัตโนมัติถ้ายังไม่มีผู้ใช้เลยในระบบ
  if (users.length === 0) {
    const tempPassword = crypto.randomBytes(6).toString('base64url');
    const admin = {
      id: 'usr_' + Date.now(),
      username: 'admin',
      passwordHash: bcrypt.hashSync(tempPassword, 10),
      role: 'admin',
      createdAt: new Date().toISOString(),
    };
    users = [admin];
    await setJSON(KEY, users);
    printCredentialBanner('admin', tempPassword, 'สร้างบัญชีแอดมินเริ่มต้นให้แล้ว');
  }

  // ---- ทางออกฉุกเฉินเวลาลืมรหัสผ่าน/ล็อกอินไม่ได้ ----
  // ตั้ง FORCE_RESET_ADMIN_PASSWORD=true ใน .env.local แล้วรันใหม่ จะรีเซ็ตรหัสผ่านของ "admin"
  // เป็นค่าสุ่มใหม่ทันที (ไม่ต้องไปลบ key ใน Upstash เอง) แล้วอย่าลืมลบบรรทัดนี้ออกจาก .env.local
  // หลังจาก login ผ่านแล้ว ไม่งั้นรหัสผ่านจะถูกรีเซ็ตใหม่ทุกครั้งที่รันเซิร์ฟเวอร์
  if (process.env.FORCE_RESET_ADMIN_PASSWORD === 'true') {
    const adminUser = users.find(u => u.username.toLowerCase() === 'admin');
    const newPassword = crypto.randomBytes(6).toString('base64url');
    if (adminUser) {
      adminUser.passwordHash = bcrypt.hashSync(newPassword, 10);
    } else {
      users.push({
        id: 'usr_' + Date.now(),
        username: 'admin',
        passwordHash: bcrypt.hashSync(newPassword, 10),
        role: 'admin',
        createdAt: new Date().toISOString(),
      });
    }
    await setJSON(KEY, users);
    printCredentialBanner('admin', newPassword, 'รีเซ็ตรหัสผ่าน admin ตามที่สั่งผ่าน FORCE_RESET_ADMIN_PASSWORD=true');
    console.log('⚠️ อย่าลืมลบบรรทัด FORCE_RESET_ADMIN_PASSWORD ออกจาก .env.local หลัง login ผ่านแล้ว ไม่งั้นจะรีเซ็ตซ้ำทุกครั้งที่รัน\n');
  }

  // โชว์รายชื่อ username ที่มีอยู่ตอนนี้ทุกครั้งที่เริ่มเซิร์ฟเวอร์ (กันพลาดเรื่องจำ username ผิด)
  // ⚠️ โชว์รหัสผ่านซ้ำไม่ได้จริงๆ เพราะเก็บแบบ hash เท่านั้น ไม่มีทางถอดกลับเป็นข้อความเดิม
  //    ถ้าลืมรหัสผ่าน ใช้ FORCE_RESET_ADMIN_PASSWORD=true ด้านบนแทน
  console.log(`👤 [authStore] Username ที่มีอยู่ในระบบตอนนี้: ${users.map(u => u.username).join(', ')}`);

  initialized = true;
}

function printCredentialBanner(username, password, title) {
  console.log(`\n🔑 ${title} — ใช้ล็อกอินครั้งแรกแล้วรีบเปลี่ยนรหัสผ่านทันที`);
  console.log(`   Username: ${username}`);
  console.log(`   Password: ${password}\n`);
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt };
}

function listUsers() {
  return users.map(publicUser);
}

function findByUsername(username) {
  return users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
}

function verifyLogin(username, password) {
  const u = findByUsername(username);
  if (!u) {
    console.log(`❌ [authStore] login ล้มเหลว: ไม่พบชื่อผู้ใช้ "${username}" (มีผู้ใช้ในระบบตอนนี้: ${users.map(x => x.username).join(', ') || '(ไม่มีเลย)'})`);
    return null;
  }
  if (!bcrypt.compareSync(password || '', u.passwordHash)) {
    console.log(`❌ [authStore] login ล้มเหลว: พบชื่อผู้ใช้ "${username}" แต่รหัสผ่านไม่ตรง`);
    return null;
  }
  console.log(`✅ [authStore] login สำเร็จ: "${username}"`);
  return publicUser(u);
}

async function createUser({ username, password, role }) {
  if (!username || !password) throw new Error('ต้องกรอกทั้งชื่อผู้ใช้และรหัสผ่าน');
  if (password.length < 6) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
  if (findByUsername(username)) throw new Error('มีชื่อผู้ใช้นี้อยู่แล้ว');

  const user = {
    id: 'usr_' + Date.now() + Math.floor(Math.random() * 1000),
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === 'admin' ? 'admin' : 'staff',
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await setJSON(KEY, users);
  return publicUser(user);
}

async function deleteUser(id) {
  const target = users.find(u => u.id === id);
  if (!target) throw new Error('ไม่พบผู้ใช้นี้');
  const remainingAdmins = users.filter(u => u.role === 'admin' && u.id !== id);
  if (target.role === 'admin' && remainingAdmins.length === 0) {
    throw new Error('ลบไม่ได้ — ต้องมีแอดมินเหลืออย่างน้อย 1 คนในระบบเสมอ');
  }
  users = users.filter(u => u.id !== id);
  await setJSON(KEY, users);
}

async function changePassword(id, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร');
  const u = users.find(x => x.id === id);
  if (!u) throw new Error('ไม่พบผู้ใช้นี้');
  u.passwordHash = bcrypt.hashSync(newPassword, 10);
  await setJSON(KEY, users);
}

module.exports = { init, listUsers, verifyLogin, createUser, deleteUser, changePassword, findByUsername };
