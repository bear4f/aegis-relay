import crypto from 'node:crypto';
import { b64u, timingEqual } from './security.js';

const SALT=crypto.createHash('sha256').update('AegisRelay-Config-v1').digest();
const sha256=value=>b64u(crypto.createHash('sha256').update(value).digest());
const envelopeInput=signedPayload=>`AegisRelay-Config-Envelope-v1\n${signedPayload}`;

function publicKey(encoded,expected='x25519') {
  const key=crypto.createPublicKey({key:Buffer.from(encoded,'base64url'),format:'der',type:'spki'});
  if(key.asymmetricKeyType!==expected)throw new Error(`invalid ${expected} public key`);
  return key;
}

function privateKey(encoded,expected='x25519') {
  const key=crypto.createPrivateKey({key:Buffer.from(encoded,'base64url'),format:'der',type:'pkcs8'});
  if(key.asymmetricKeyType!==expected)throw new Error(`invalid ${expected} private key`);
  return key;
}

function configKey(shared,agentId,revision) {
  return Buffer.from(crypto.hkdfSync('sha256',shared,SALT,Buffer.from(`${agentId}:${revision}`),32));
}

function aad(agentId,revision,configId) {
  return Buffer.from(`AegisRelay-Config-AAD-v1\n${agentId}\n${revision}\n${configId}`);
}

export function sealAgentSnapshot({agent,snapshot,panelIdentity}) {
  if(!agent?.id||!agent.boxPublicKey)throw new Error('agent encryption identity is incomplete');
  const configId=snapshot.hash,revision=Number(snapshot.revision),plain=Buffer.from(JSON.stringify(snapshot));
  const ephemeral=crypto.generateKeyPairSync('x25519'),shared=crypto.diffieHellman({privateKey:ephemeral.privateKey,publicKey:publicKey(agent.boxPublicKey)}),iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',configKey(shared,agent.id,revision),iv);cipher.setAAD(aad(agent.id,revision,configId));
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
  const payload={agentId:agent.id,configId,revision,panelKeyId:panelIdentity.keyId,ephemeralBoxPublicKey:b64u(ephemeral.publicKey.export({format:'der',type:'spki'})),iv:b64u(iv),ciphertext:b64u(ciphertext),tag:b64u(cipher.getAuthTag()),plaintextSha256:sha256(plain)};
  const signedPayload=b64u(Buffer.from(JSON.stringify(payload))),panelPrivate=privateKey(panelIdentity.privateKey,'ed25519');
  return {protocolVersion:1,signedPayload,signature:b64u(crypto.sign(null,Buffer.from(envelopeInput(signedPayload)),panelPrivate))};
}

export function openAgentSnapshot({envelope,identity}) {
  if(envelope?.protocolVersion!==1||typeof envelope.signedPayload!=='string'||typeof envelope.signature!=='string')throw new Error('invalid config envelope');
  const panelPublic=publicKey(identity.panelSigningPublicKey,'ed25519');
  if(!crypto.verify(null,Buffer.from(envelopeInput(envelope.signedPayload)),panelPublic,Buffer.from(envelope.signature,'base64url')))throw new Error('config envelope signature rejected');
  let payload;try{payload=JSON.parse(Buffer.from(envelope.signedPayload,'base64url').toString('utf8'));}catch{throw new Error('invalid config envelope payload');}
  if(payload.agentId!==identity.agentId||!timingEqual(payload.panelKeyId||'',identity.panelKeyId||''))throw new Error('config envelope identity mismatch');
  const revision=Number(payload.revision);if(!Number.isSafeInteger(revision)||revision<1)throw new Error('invalid config revision');
  const shared=crypto.diffieHellman({privateKey:privateKey(identity.boxPrivateKey),publicKey:publicKey(payload.ephemeralBoxPublicKey)}),decipher=crypto.createDecipheriv('aes-256-gcm',configKey(shared,identity.agentId,revision),Buffer.from(payload.iv,'base64url'));
  decipher.setAAD(aad(identity.agentId,revision,payload.configId));decipher.setAuthTag(Buffer.from(payload.tag,'base64url'));
  let plain;try{plain=Buffer.concat([decipher.update(Buffer.from(payload.ciphertext,'base64url')),decipher.final()]);}catch{throw new Error('config envelope decryption rejected');}
  if(!timingEqual(sha256(plain),payload.plaintextSha256||''))throw new Error('config plaintext hash mismatch');
  let snapshot;try{snapshot=JSON.parse(plain.toString('utf8'));}catch{throw new Error('invalid config snapshot JSON');}
  if(snapshot.revision!==revision||!timingEqual(snapshot.hash||'',payload.configId||''))throw new Error('config snapshot metadata mismatch');
  return snapshot;
}
