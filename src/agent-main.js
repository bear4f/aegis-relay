import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { b64u, randomToken, timingEqual } from './security.js';
import { agentRequestInput, panelResponseInput } from './agent-api.js';
import { writeAtomic } from './store.js';

const DATA_DIR=process.env.AGENT_DATA_DIR||'/app/agent-data',IDENTITY_FILE=path.join(DATA_DIR,'identity.json');
const PANEL_URL=cleanPanel(process.env.PANEL_URL),AGENT_DOMAIN=String(process.env.AGENT_DOMAIN||'').trim(),VERSION=process.env.AGENT_VERSION||'0.5.0';
const sha256=value=>b64u(crypto.createHash('sha256').update(value).digest());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function cleanPanel(value){const url=new URL(String(value||''));if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('PANEL_URL must be an HTTPS origin');return url.origin;}
function publicDer(key){return b64u(key.export({format:'der',type:'spki'}));}
function privateDer(key){return b64u(key.export({format:'der',type:'pkcs8'}));}
function privateKey(identity){return crypto.createPrivateKey({key:Buffer.from(identity.signPrivateKey,'base64url'),format:'der',type:'pkcs8'});}
function panelPublicKey(identity){return crypto.createPublicKey({key:Buffer.from(identity.panelSigningPublicKey,'base64url'),format:'der',type:'spki'});}

function newIdentity(){const sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519');return{signPublicKey:publicDer(sign.publicKey),signPrivateKey:privateDer(sign.privateKey),boxPublicKey:publicDer(box.publicKey),boxPrivateKey:privateDer(box.privateKey)}}
function loadIdentity(){return JSON.parse(fs.readFileSync(IDENTITY_FILE,'utf8'));}

function verifyResponse(response,raw,identity,nonce){const timestamp=Number(response.headers.get('x-aegis-timestamp')),contentHash=response.headers.get('x-aegis-content-sha256')||'',signature=response.headers.get('x-aegis-signature')||'',keyId=response.headers.get('x-aegis-panel-key-id')||'';if(!timingEqual(contentHash,sha256(raw))||!timingEqual(keyId,identity.panelKeyId))throw new Error('panel response identity rejected');const input=panelResponseInput({status:response.status,requestNonce:nonce,timestamp,contentHash});if(!crypto.verify(null,Buffer.from(input),panelPublicKey(identity),Buffer.from(signature,'base64url')))throw new Error('panel response signature rejected');}

async function enroll(){
  const token=String(process.env.ENROLLMENT_TOKEN||'');if(!token)throw new Error('ENROLLMENT_TOKEN is required');
  fs.mkdirSync(DATA_DIR,{recursive:true,mode:0o700});if(fs.existsSync(IDENTITY_FILE))throw new Error('agent is already enrolled');
  const identity=newIdentity(),requestNonce=randomToken(16),payload={protocolVersion:1,requestNonce,token,agent:{name:String(process.env.AGENT_NAME||os.hostname()).slice(0,80),signPublicKey:identity.signPublicKey,boxPublicKey:identity.boxPublicKey,agentVersion:VERSION,capabilities:['registry-v1']},machine:{hostname:os.hostname().slice(0,80),architecture:process.arch,platform:process.platform}};
  const response=await fetch(`${PANEL_URL}/api/agent/v1/enroll`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),raw=Buffer.from(await response.arrayBuffer()),result=JSON.parse(raw.toString('utf8'));
  if(!response.ok)throw new Error(result.error||`enrollment failed (${response.status})`);
  const pinned={...identity,agentId:result.agentId,panelKeyId:result.panelKeyId,panelSigningPublicKey:result.panelSigningPublicKey,panelUrl:PANEL_URL,enrolledAt:new Date().toISOString()};verifyResponse(response,raw,pinned,requestNonce);writeAtomic(IDENTITY_FILE,JSON.stringify(pinned));console.log(`AegisRelay Agent registered: ${result.agentId}`);
}

async function signedCheckIn(identity,startedAt,bootId){
  const body=Buffer.from(JSON.stringify({protocolVersion:1,agentVersion:VERSION,bootId,uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),currentRevision:0,currentConfigId:null,applyState:'waiting',proxyHealthy:false,domain:AGENT_DOMAIN,certificateNotAfter:null,capabilities:['registry-v1']})),timestamp=Math.floor(Date.now()/1000),nonce=randomToken(16),contentHash=sha256(body),pathname='/api/agent/v1/check-in';
  const signature=b64u(crypto.sign(null,Buffer.from(agentRequestInput({method:'POST',path:pathname,agentId:identity.agentId,timestamp,nonce,contentHash})),privateKey(identity)));
  const response=await fetch(`${PANEL_URL}${pathname}`,{method:'POST',headers:{'content-type':'application/json','x-aegis-agent-id':identity.agentId,'x-aegis-timestamp':String(timestamp),'x-aegis-nonce':nonce,'x-aegis-content-sha256':contentHash,'x-aegis-signature':signature},body}),raw=Buffer.from(await response.arrayBuffer());verifyResponse(response,raw,identity,nonce);const result=JSON.parse(raw.toString('utf8'));if(!response.ok)throw new Error(result.error||`check-in failed (${response.status})`);return result;
}

async function run(){const identity=loadIdentity();if(identity.panelUrl!==PANEL_URL)throw new Error('pinned panel URL mismatch');const startedAt=Date.now(),bootId=randomToken(16);let delay=2_000;for(;;){try{const result=await signedCheckIn(identity,startedAt,bootId);delay=Math.max(5_000,Number(result.heartbeatSeconds||30)*1000);await sleep(delay)}catch(error){console.error(`[aegis-agent] ${String(error.message||error).slice(0,160)}`);await sleep(delay);delay=Math.min(300_000,delay*2)}}}

if(process.argv.includes('--enroll'))await enroll();else await run();
