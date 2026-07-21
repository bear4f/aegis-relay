import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LEGACY_ROUTE_AUTH_VERSION, newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from './route-auth.js';

export const STORE_SCHEMA_VERSION = 2;
const EMPTY = { version: 1, schemaVersion: STORE_SCHEMA_VERSION, admin: null, routes: [], audit: [], sessions: {} };

export function migrationBackupPath(file) {
  return `${file}.schema-v1.bak`;
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeAtomic(file, payload) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function decryptStore(payload, key) {
  const env = JSON.parse(payload);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(env.data, 'base64url')), decipher.final()]));
}

export function migrateRouteAuthData(input) {
  const sourceVersion = Number(input?.schemaVersion || 1);
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) throw new Error('invalid store schemaVersion');
  if (sourceVersion > STORE_SCHEMA_VERSION) throw new Error(`store schemaVersion ${sourceVersion} is newer than supported ${STORE_SCHEMA_VERSION}`);
  if (sourceVersion === STORE_SCHEMA_VERSION) return { data:input, changed:false, sourceVersion, migrated:0, legacy:0 };

  const data = structuredClone(input);
  let migrated = 0, legacy = 0;
  for (const route of Array.isArray(data.routes) ? data.routes : []) {
    if ((route.accessMode || 'key') === 'alias_only') continue;
    if (route.accessKey) {
      const routeAuthKey = newRouteAuthKey();
      route.routeAuthKey = routeAuthKey;
      route.authVersion = ROUTE_AUTH_VERSION;
      route.keyDigest = routeTokenDigest(route.accessKey, routeAuthKey);
      delete route.authMigrationRequired;
      migrated++;
    } else if (route.keyDigest) {
      route.authVersion = LEGACY_ROUTE_AUTH_VERSION;
      route.authMigrationRequired = true;
      delete route.routeAuthKey;
      legacy++;
    } else {
      route.routeAuthKey = newRouteAuthKey();
      route.authVersion = ROUTE_AUTH_VERSION;
      route.authMigrationRequired = true;
      legacy++;
    }
  }
  data.schemaVersion = STORE_SCHEMA_VERSION;
  return { data, changed:true, sourceVersion, migrated, legacy };
}

export function restoreMigrationBackup(file, key) {
  const backup = migrationBackupPath(file);
  if (!fs.existsSync(backup)) throw new Error(`migration backup not found: ${backup}`);
  const payload = fs.readFileSync(backup, 'utf8');
  decryptStore(payload, key);
  writeAtomic(file, payload);
  return backup;
}

export class Store {
  constructor(file, key) { this.file = file; this.key = key; this.data = structuredClone(EMPTY); this.load(); this.migration = this.migrate(); }
  load() {
    if (!fs.existsSync(this.file)) return;
    this.data = decryptStore(fs.readFileSync(this.file, 'utf8'), this.key);
  }
  migrate() {
    const result = migrateRouteAuthData(this.data);
    if (!result.changed) return result;
    if (fs.existsSync(this.file)) {
      const backup = migrationBackupPath(this.file);
      try {
        fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(backup, 0o600);
        fsyncFile(backup);
        fsyncDirectory(path.dirname(backup));
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!fs.readFileSync(backup).equals(fs.readFileSync(this.file))) throw new Error(`migration backup does not match the current store: ${backup}`);
      }
    }
    this.data = result.data;
    this.data.audit = Array.isArray(this.data.audit) ? this.data.audit : [];
    this.data.audit.unshift({ at:new Date().toISOString(), action:'store.schema_migrated', ip:'local', detail:`schema ${result.sourceVersion} -> ${STORE_SCHEMA_VERSION}; ${result.migrated} routes migrated; ${result.legacy} require rotation` });
    this.data.audit = this.data.audit.slice(0, 500);
    this.save();
    return { ...result, backup:fs.existsSync(migrationBackupPath(this.file)) ? migrationBackupPath(this.file) : null };
  }
  save() {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.data)), cipher.final()]);
    const payload = JSON.stringify({ v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') });
    writeAtomic(this.file, payload);
  }
  audit(action, ip, detail = '') {
    this.data.audit.unshift({ at: new Date().toISOString(), action, ip: String(ip).slice(0, 64), detail: String(detail).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 180) });
    this.data.audit = this.data.audit.slice(0, 500); this.save();
  }
}
