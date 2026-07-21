import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generatePanelSigningIdentity } from '../src/snapshot.js';
import { openAgentSnapshot, sealAgentSnapshot } from '../src/agent-config.js';
import { compileSnapshot, verifySnapshot } from '../src/snapshot.js';

const der=(key,type)=>key.export({format:'der',type}).toString('base64url');

test('agent snapshots are encrypted to one X25519 identity and retain the panel signature',()=>{
  const panel=generatePanelSigningIdentity(),box=crypto.generateKeyPairSync('x25519'),other=crypto.generateKeyPairSync('x25519'),agentId='agent-one';
  const snapshot=compileSnapshot({revision:1,nodes:[{id:'route-a',alias:'alpha',name:'Alpha',enabled:true,upstreams:['https://origin.example.com'],playbackUpstreams:[],allowPrivate:false,tlsVerify:true,showOnHome:false,clientProfile:{enabled:false},speedLimitMbps:0,monthlyQuotaGB:0,accessMode:'alias_only'}],signingIdentity:panel});
  const envelope=sealAgentSnapshot({agent:{id:agentId,boxPublicKey:der(box.publicKey,'spki')},snapshot,panelIdentity:panel}),identity={agentId,boxPrivateKey:der(box.privateKey,'pkcs8'),panelKeyId:panel.keyId,panelSigningPublicKey:panel.publicKey};
  const opened=openAgentSnapshot({envelope,identity});assert.deepEqual(opened,snapshot);assert.equal(verifySnapshot(opened,{algorithm:'Ed25519',keyId:panel.keyId,publicKey:panel.publicKey}).status,'apply');
  assert.throws(()=>openAgentSnapshot({envelope,identity:{...identity,boxPrivateKey:der(other.privateKey,'pkcs8')}}),/decryption rejected/);
  const tampered={...envelope,signature:(envelope.signature.startsWith('A')?'B':'A')+envelope.signature.slice(1)};assert.throws(()=>openAgentSnapshot({envelope:tampered,identity}),/signature rejected/);
});
