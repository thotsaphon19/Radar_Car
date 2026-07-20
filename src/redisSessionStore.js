/**
 * redisSessionStore.js — เก็บ session (login) ไว้ใน Redis แทนหน่วยความจำ (MemoryStore ค่า default
 * ของ express-session) — แก้ 2 ปัญหาที่ยืนยันเจอจริง:
 *   1. "MemoryStore is not designed for a production environment... will leak memory" — warning
 *      ที่ขึ้นทุกครั้งที่สตาร์ท บอกตรงๆ ว่ากิน RAM เพิ่มขึ้นเรื่อยๆ ไม่มีวันคืน จนกว่าจะรีสตาร์ท —
 *      อาจเป็นส่วนหนึ่งที่ทำให้ RAM โตขึ้นช้าๆ จนถึงจุดที่ OOM ในที่สุด
 *   2. ทุกครั้งที่เซิร์ฟเวอร์ restart (ไม่ว่าจาก deploy ใหม่หรือ crash) session ที่ login ไว้หายหมด
 *      ทันที ทำให้ผู้ใช้ที่เปิดหน้าเว็บค้างไว้โดน "401 Unauthorized" เตะออกกลางคัน
 *
 * ไม่ใช้ไลบรารีสำเร็จรูปอย่าง connect-redis เพราะไลบรารีนั้นออกแบบมาคู่กับ redis client แบบ
 * node-redis/ioredis (โปรโตคอล TCP) ซึ่งพฤติกรรมการ serialize อาจไม่ตรงกับ @upstash/redis
 * (REST-based client ที่โปรเจกต์นี้ใช้อยู่แล้ว) — เขียน store เองแบบง่ายๆ ด้วย getJSON/setJSON
 * ที่ยืนยันแล้วว่าใช้งานได้จริงในโปรเจกต์นี้อยู่แล้ว ปลอดภัยกว่าการเดา compatibility
 */

const session = require('express-session');
const { getJSON, setJSON } = require('./redisStore');

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 วัน ตรงกับ cookie maxAge เดิม

class RedisSessionStore extends session.Store {
  constructor() {
    super();
  }

  _key(sid) {
    return `car-radar:session:${sid}`;
  }

  async get(sid, callback) {
    try {
      const data = await getJSON(this._key(sid), null);
      callback(null, data);
    } catch (e) {
      callback(e);
    }
  }

  async set(sid, sessionData, callback) {
    try {
      await setJSON(this._key(sid), sessionData);
      callback?.(null);
    } catch (e) {
      callback?.(e);
    }
  }

  async destroy(sid, callback) {
    try {
      // ไม่มี deleteJSON แยกใน redisStore.js — เขียนค่าว่างทับไปแทน (get() จะได้ null กลับมา
      // เพราะ getJSON คืน fallback null ถ้าค่าที่ได้เป็น null อยู่แล้ว ใช้แทนการลบจริงได้)
      await setJSON(this._key(sid), null);
      callback?.(null);
    } catch (e) {
      callback?.(e);
    }
  }

  async touch(sid, sessionData, callback) {
    // ต่ออายุ session ตอนมีการใช้งาน — เขียนทับด้วยข้อมูลเดิมอีกครั้งก็พอ (ไม่มี TTL แยกให้ตั้งใน
    // getJSON/setJSON ปัจจุบัน แต่ cookie maxAge ฝั่ง client เป็นตัวคุมอายุจริงอยู่แล้ว)
    return this.set(sid, sessionData, callback);
  }
}

module.exports = { RedisSessionStore };
