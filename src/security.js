import crypto from 'node:crypto';
import net from 'node:net';

export const b64u = b => Buffer.from(b).toString('base64url');
export const randomToken = (bytes = 32) => b64u(crypto.randomBytes(bytes));
export const timingEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function deriveKey(secret) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('APP_MASTER_KEY must be at least 32 bytes');
  return crypto.scryptSync(secret, 'aegis-relay:v1', 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  if (String(password).length < 14) throw new Error('password must contain at least 14 characters');
  const digest = crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$${b64u(salt)}$${b64u(digest)}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [kind, n, salt, expected] = encoded.split('$');
    if (kind !== 'scrypt' || n !== '32768') return false;
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return timingEqual(actual, Buffer.from(expected, 'base64url'));
  } catch { return false; }
}

export const tokenDigest = (token, key) => b64u(crypto.createHmac('sha256', key).update(token).digest());

export function newTotpSecret() {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bytes=crypto.randomBytes(20); let bits='', out='';
  for(const b of bytes) bits+=b.toString(2).padStart(8,'0'); for(let i=0;i<bits.length;i+=5) out+=alphabet[parseInt(bits.slice(i,i+5).padEnd(5,'0'),2)]; return out;
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const ch of value.replaceAll(' ', '').toUpperCase()) {
    const i = alphabet.indexOf(ch); if (i < 0) throw new Error('invalid base32');
    bits += i.toString(2).padStart(5, '0');
  }
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function totp(secret, at = Date.now(), step = 30) {
  const counter = Math.floor(at / 1000 / step); const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest(); const off = h[h.length - 1] & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret, code, now = Date.now()) {
  return /^\d{6}$/.test(String(code)) && [-1, 0, 1].some(w => now + w * 30000 >= 0 && timingEqual(totp(secret, now + w * 30000), code));
}

export function isPrivateIP(ip) {
  ip = ip.replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
  return true;
}

export function cleanAlias(v) {
  v = String(v || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(v)) throw new Error('alias must be 1-32 lowercase letters, digits, _ or -');
  return v;
}

export class RateLimiter {
  constructor(limit = 5, windowMs = 60000) { this.limit = limit; this.windowMs = windowMs; this.map = new Map(); }
  take(key, now = Date.now()) {
    const cur = this.map.get(key); if (!cur || now - cur.start >= this.windowMs) { this.map.set(key, { start: now, count: 1 }); return true; }
    cur.count++; return cur.count <= this.limit;
  }
}
