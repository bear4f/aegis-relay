import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';
import { deriveKey } from '../src/security.js';
import { compileDesiredSnapshot, ensurePanelSigningIdentity, generatePanelSigningIdentity, verifySnapshot } from '../src/snapshot.js';
import { Store } from '../src/store.js';

function keyedNode(id='node-b',name='Charity') {
  const routeAuthKey=newRouteAuthKey();
  return {id,alias:id,name,enabled:true,upstreams:['https://emby.example.com'],playbackUpstreams:[],allowPrivate:false,tlsVerify:true,directStream:false,showOnHome:false,clientProfile:{enabled:false},speedLimitMbps:0,monthlyQuotaGB:0,accessMode:'key',accessKey:'must-not-leak',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('must-not-leak',routeAuthKey)};
}

test('unchanged normalized configuration reuses revision, hash and signature exactly', () => {
  const identity=generatePanelSigningIdentity(),firstNode=keyedNode(),publicNode={id:'node-a',alias:'public',name:'Public',enabled:true,upstreams:['https://public.example.com'],accessMode:'alias_only'};
  const first=compileDesiredSnapshot({nodes:[firstNode,publicNode],signingIdentity:identity});
  const second=compileDesiredSnapshot({nodes:[publicNode,{...firstNode}],previousState:first.state,signingIdentity:identity});
  assert.deepEqual(second,first);
  assert.equal(first.snapshot.revision,1);
  assert.deepEqual(first.snapshot.nodes.map(node=>node.id),['node-a','node-b']);
  assert.equal(Object.isFrozen(first.snapshot),true);
  assert.equal(Object.isFrozen(first.snapshot.nodes),true);
  assert.equal(Object.isFrozen(first.snapshot.nodes[0].access),true);
  const serialized=JSON.stringify(first.snapshot);
  assert.equal(serialized.includes('must-not-leak'),false);
  assert.equal(serialized.includes('accessKey'),false);
});

test('a material node change increments revision and changes hash and signature', () => {
  const identity=generatePanelSigningIdentity(),node=keyedNode();
  const first=compileDesiredSnapshot({nodes:[node],signingIdentity:identity});
  const second=compileDesiredSnapshot({nodes:[{...node,name:'Changed'}],previousState:first.state,signingIdentity:identity});
  assert.equal(second.snapshot.revision,2);
  assert.notEqual(second.snapshot.hash,first.snapshot.hash);
  assert.notEqual(second.snapshot.signature,first.snapshot.signature);
});

test('panel signing-key rotation also advances revision', () => {
  const firstIdentity=generatePanelSigningIdentity(),node=keyedNode();
  const first=compileDesiredSnapshot({nodes:[node],signingIdentity:firstIdentity});
  const second=compileDesiredSnapshot({nodes:[node],previousState:first.state,signingIdentity:generatePanelSigningIdentity()});
  assert.equal(second.snapshot.revision,2);
  assert.notEqual(second.snapshot.keyId,first.snapshot.keyId);
});

test('snapshot verification rejects tampering and revision rollback', () => {
  const identity=generatePanelSigningIdentity(),{snapshot}=compileDesiredSnapshot({nodes:[keyedNode()],signingIdentity:identity});
  assert.deepEqual(verifySnapshot(snapshot,identity),{status:'apply',revision:1,hash:snapshot.hash});
  assert.deepEqual(verifySnapshot(snapshot,identity,{currentRevision:1,currentHash:snapshot.hash}),{status:'noop',revision:1,hash:snapshot.hash});
  assert.throws(()=>verifySnapshot(snapshot,identity,{currentRevision:2,currentHash:'newer'}),/rollback/);
  const tampered=structuredClone(snapshot);tampered.nodes[0].name='Attacker';
  assert.throws(()=>verifySnapshot(tampered,identity),/hash mismatch/);
  const otherIdentity=generatePanelSigningIdentity();
  assert.throws(()=>verifySnapshot(snapshot,otherIdentity),/signing key mismatch/);
});

test('legacy digest-only nodes cannot enter an agent snapshot', () => {
  const identity=generatePanelSigningIdentity();
  assert.throws(()=>compileDesiredSnapshot({nodes:[{id:'legacy',alias:'legacy',upstreams:['https://emby.example.com'],accessMode:'key',authMigrationRequired:true}],signingIdentity:identity}),/requires an access-key rotation/);
});

test('panel signing identity is generated once and remains encrypted in the store', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-signing-')),file=path.join(dir,'aegis.enc.json');
  try {
    const store=new Store(file,deriveKey('s'.repeat(32))),first=ensurePanelSigningIdentity(store),raw=fs.readFileSync(file,'utf8');
    assert.equal(raw.includes(first.privateKey),false);
    const second=ensurePanelSigningIdentity(new Store(file,deriveKey('s'.repeat(32))));
    assert.deepEqual(second,first);
  } finally { fs.rmSync(dir,{recursive:true}); }
});
