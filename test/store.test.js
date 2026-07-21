import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clientCredentials } from '../src/credentials.js';
import { LEGACY_ROUTE_AUTH_VERSION, newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest, verifyRouteToken } from '../src/route-auth.js';
import { deriveKey, tokenDigest } from '../src/security.js';
import { migrationBackupPath, restoreMigrationBackup, STORE_SCHEMA_VERSION, Store } from '../src/store.js';
import { routesForAgent } from '../src/agent-registry.js';
import { compileDesiredSnapshot, generatePanelSigningIdentity } from '../src/snapshot.js';

function writeEncrypted(file, key, data) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final()]);
  fs.writeFileSync(file,JSON.stringify({v:1,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:encrypted.toString('base64url')}),{mode:0o600});
}

function readEncrypted(file, key) {
  const env=JSON.parse(fs.readFileSync(file,'utf8'));
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(env.iv,'base64url'));
  decipher.setAuthTag(Buffer.from(env.tag,'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(env.data,'base64url')),decipher.final()]));
}

test('encrypted store round trips without plaintext leakage', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-')),file=path.join(dir,'db');
  try {
    const key=deriveKey('k'.repeat(32)),s=new Store(file,key);
    s.data.routes.push({upstream:'https://secret.example',accessKey:'client-secret'});
    s.data.sessions.adminSession={csrf:'csrf-secret',expires:Date.now()+60_000};
    s.save();
    const raw=fs.readFileSync(file,'utf8');
    assert.equal(raw.includes('secret.example'),false);
    assert.equal(raw.includes('client-secret'),false);
    assert.equal(raw.includes('csrf-secret'),false);
    const restored=new Store(file,key).data;
    assert.equal(restored.routes[0].upstream,'https://secret.example');
    assert.equal(restored.routes[0].accessKey,'client-secret');
    assert.equal(restored.sessions.adminSession.csrf,'csrf-secret');
  } finally { fs.rmSync(dir,{recursive:true}); }
});

test('schema v1 route authentication migrates atomically without changing the client address', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-migration-')),file=path.join(dir,'aegis.enc.json');
  try {
    const key=deriveKey('m'.repeat(32)),accessKey='existing-client-key';
    const original={version:1,admin:null,routes:[{id:'node-1',alias:'charity',enabled:true,accessMode:'key',accessKey,keyDigest:tokenDigest(accessKey,key)}],audit:[],sessions:{}};
    const beforePath=clientCredentials(original.routes[0],accessKey).clientPath;
    writeEncrypted(file,key,original);
    const originalEnvelope=fs.readFileSync(file,'utf8');

    const store=new Store(file,key),route=store.data.routes[0];
    assert.equal(store.data.schemaVersion,STORE_SCHEMA_VERSION);
    assert.deepEqual(store.data.agents.map(agent=>agent.id),['local']);
    assert.deepEqual(store.data.deployments.map(item=>[item.agentId,item.routeId]),[['local','node-1']]);
    assert.equal(route.authVersion,ROUTE_AUTH_VERSION);
    assert.equal(route.accessKey,accessKey);
    assert.equal(clientCredentials(route,route.accessKey).clientPath,beforePath);
    assert.equal(verifyRouteToken(route,accessKey),true);
    assert.equal(verifyRouteToken(route,accessKey,deriveKey('different-master-key'.padEnd(32,'x'))),true);
    assert.notEqual(route.keyDigest,original.routes[0].keyDigest);
    assert.equal(fs.readFileSync(migrationBackupPath(file),'utf8'),originalEnvelope);
    assert.deepEqual(readEncrypted(migrationBackupPath(file),key),original);
    assert.equal(fs.statSync(migrationBackupPath(file)).mode&0o777,0o600);

    const migratedEnvelope=fs.readFileSync(file,'utf8'),routeAuthKey=route.routeAuthKey;
    const second=new Store(file,key);
    assert.equal(second.migration.changed,false);
    assert.equal(second.data.routes[0].routeAuthKey,routeAuthKey);
    assert.equal(fs.readFileSync(file,'utf8'),migratedEnvelope);
    assert.deepEqual(fs.readdirSync(dir).filter(name=>name.endsWith('.tmp')),[]);

    restoreMigrationBackup(file,key);
    assert.equal(fs.readFileSync(file,'utf8'),originalEnvelope);
  } finally { fs.rmSync(dir,{recursive:true}); }
});

test('digest-only legacy routes stay usable locally and require rotation before agent deployment', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-legacy-')),file=path.join(dir,'aegis.enc.json');
  try {
    const key=deriveKey('l'.repeat(32)),accessKey='lost-plaintext-key';
    writeEncrypted(file,key,{version:1,admin:null,routes:[{id:'legacy',alias:'legacy',enabled:true,accessMode:'key',keyDigest:tokenDigest(accessKey,key)}],audit:[],sessions:{}});
    const route=new Store(file,key).data.routes[0];
    assert.equal(route.authVersion,LEGACY_ROUTE_AUTH_VERSION);
    assert.equal(route.authMigrationRequired,true);
    assert.equal(route.routeAuthKey,undefined);
    assert.equal(verifyRouteToken(route,accessKey,key),true);
    assert.equal(verifyRouteToken(route,accessKey),false);
  } finally { fs.rmSync(dir,{recursive:true}); }
});

test('schema v2 deployment migration keeps the local snapshot byte-for-byte stable', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-deployment-migration-')),file=path.join(dir,'aegis.enc.json');
  try {
    const key=deriveKey('d'.repeat(32)),identity=generatePanelSigningIdentity(),accessKey='stable-client-key',routeAuthKey=newRouteAuthKey();
    const route={id:'stable',alias:'stable',name:'Stable',enabled:true,upstreams:['https://emby.example.com'],playbackUpstreams:[],allowPrivate:false,tlsVerify:true,showOnHome:false,clientProfile:{enabled:false},speedLimitMbps:0,monthlyQuotaGB:0,accessMode:'key',accessKey,authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest(accessKey,routeAuthKey)};
    const original={version:1,schemaVersion:2,admin:null,routes:[route],audit:[],sessions:{},controlPlane:{panelSigningIdentity:identity}};
    const before=compileDesiredSnapshot({nodes:original.routes,signingIdentity:identity});
    writeEncrypted(file,key,original);
    const store=new Store(file,key),after=compileDesiredSnapshot({nodes:routesForAgent(store.data,'local'),signingIdentity:identity});
    assert.equal(store.data.schemaVersion,3);
    assert.deepEqual(after,before);
    assert.equal(fs.existsSync(migrationBackupPath(file,2)),true);
  } finally { fs.rmSync(dir,{recursive:true}); }
});
