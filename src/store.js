import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = { version: 1, admin: null, routes: [], audit: [], sessions: {} };

export class Store {
  constructor(file, key) { this.file = file; this.key = key; this.data = structuredClone(EMPTY); this.load(); }
  load() {
    if (!fs.existsSync(this.file)) return;
    const env = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(env.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64url'));
    this.data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(env.data, 'base64url')), decipher.final()]));
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.data)), cipher.final()]);
    const payload = JSON.stringify({ v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') });
    const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, payload, { mode: 0o600 }); fs.renameSync(tmp, this.file); fs.chmodSync(this.file, 0o600);
  }
  audit(action, ip, detail = '') {
    this.data.audit.unshift({ at: new Date().toISOString(), action, ip: String(ip).slice(0, 64), detail: String(detail).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 180) });
    this.data.audit = this.data.audit.slice(0, 500); this.save();
  }
}
