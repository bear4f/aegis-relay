import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { b64u, randomToken, timingEqual } from './security.js';
import { agentRequestInput, panelResponseInput } from './agent-api.js';
import { openAgentSnapshot } from './agent-config.js';
import { AtomicRouteSource, runtimeRoutes } from './local-agent.js';
import { verifySnapshot } from './snapshot.js';
import { writeAtomic } from './store.js';
import { handleUpgrade, makeProxyHandler } from './proxy.js';
import { Metrics } from './metrics.js';

const DATA_DIR=process.env.AGENT_DATA_DIR||'/app/agent-data',IDENTITY_FILE=path.join(DATA_DIR,'identity.json'),CURRENT_FILE=path.join(DATA_DIR,'current.snapshot'),PREVIOUS_FILE=path.join(DATA_DIR,'previous.snapshot');
const PANEL_URL=cleanPanel(process.env.PANEL_URL),AGENT_DOMAIN=String(process.env.AGENT_DOMAIN||'').trim(),VERSION=process.env.AGENT_VERSION||'0.6.0',PROXY_PORT=Number(process.env.AGENT_PROXY_PORT||8080);
const sha256=value=>b64u(crypto.createHash('sha256').update(value).digest());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function cleanPanel(value){const url=new URL(String(value||''));if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('PANEL_URL must be an HTTPS origin');return url.origin;}
function publicDer(key){return b64u(key.export({format:'der',type:'spki'}));}
function privateDer(key){return b64u(key.export({format:'der',type:'pkcs8'}));}
function signPrivateKey(identity){return crypto.createPrivateKey({key:Buffer.from(identity.signPrivateKey,'base64url'),format:'der',type:'pkcs8'});}
function panelPublicKey(identity){return crypto.createPublicKey({key:Buffer.from(identity.panelSigningPublicKey,'base64url'),format:'der',type:'spki'});}
function panelIdentity(identity){return{algorithm:'Ed25519',keyId:identity.panelKeyId,publicKey:identity.panelSigningPublicKey};}
function storageKey(identity){const key=Buffer.from(identity.agentStorageKey||'','base64url');if(key.length!==32)throw new Error('invalid agent storage key');return key;}

function newIdentity(){const sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519');return{signPublicKey:publicDer(sign.publicKey),signPrivateKey:privateDer(sign.privateKey),boxPublicKey:publicDer(box.publicKey),boxPrivateKey:privateDer(box.privateKey),agentStorageKey:randomToken(32)}}
function loadIdentity(){const identity=JSON.parse(fs.readFileSync(IDENTITY_FILE,'utf8'));if(!identity.agentStorageKey){identity.agentStorageKey=randomToken(32);writeAtomic(IDENTITY_FILE,JSON.stringify(identity));}storageKey(identity);return identity;}

function verifyResponse(response,raw,identity,nonce){const timestamp=Number(response.headers.get('x-aegis-timestamp')),contentHash=response.headers.get('x-aegis-content-sha256')||'',signature=response.headers.get('x-aegis-signature')||'',keyId=response.headers.get('x-aegis-panel-key-id')||'';if(!Number.isSafeInteger(timestamp)||Math.abs(Math.floor(Date.now()/1000)-timestamp)>300||!timingEqual(contentHash,sha256(raw))||!timingEqual(keyId,identity.panelKeyId))throw new Error('panel response identity rejected');const input=panelResponseInput({status:response.status,requestNonce:nonce,timestamp,contentHash});if(!crypto.verify(null,Buffer.from(input),panelPublicKey(identity),Buffer.from(signature,'base64url')))throw new Error('panel response signature rejected');}

async function enroll(){
  const token=String(process.env.ENROLLMENT_TOKEN||'');if(!token)throw new Error('ENROLLMENT_TOKEN is required');
  fs.mkdirSync(DATA_DIR,{recursive:true,mode:0o700});if(fs.existsSync(IDENTITY_FILE))throw new Error('agent is already enrolled');
  const identity=newIdentity(),requestNonce=randomToken(16),payload={protocolVersion:1,requestNonce,token,agent:{name:String(process.env.AGENT_NAME||os.hostname()).slice(0,80),signPublicKey:identity.signPublicKey,boxPublicKey:identity.boxPublicKey,agentVersion:VERSION,capabilities:['registry-v1','config-v1','proxy-v1']},machine:{hostname:os.hostname().slice(0,80),architecture:process.arch,platform:process.platform}};
  const response=await fetch(`${PANEL_URL}/api/agent/v1/enroll`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),raw=Buffer.from(await response.arrayBuffer()),result=JSON.parse(raw.toString('utf8'));
  if(!response.ok)throw new Error(result.error||`enrollment failed (${response.status})`);
  const pinned={...identity,agentId:result.agentId,panelKeyId:result.panelKeyId,panelSigningPublicKey:result.panelSigningPublicKey,panelUrl:PANEL_URL,enrolledAt:new Date().toISOString()};verifyResponse(response,raw,pinned,requestNonce);writeAtomic(IDENTITY_FILE,JSON.stringify(pinned));console.log(`AegisRelay Agent registered: ${result.agentId}`);
}

async function signedRequest(identity,method,pathAndQuery,payload=null){
  const body=payload===null?Buffer.alloc(0):Buffer.from(JSON.stringify(payload)),timestamp=Math.floor(Date.now()/1000),nonce=randomToken(16),contentHash=sha256(body);
  const signature=b64u(crypto.sign(null,Buffer.from(agentRequestInput({method,path:pathAndQuery,agentId:identity.agentId,timestamp,nonce,contentHash})),signPrivateKey(identity))),headers={'x-aegis-agent-id':identity.agentId,'x-aegis-timestamp':String(timestamp),'x-aegis-nonce':nonce,'x-aegis-content-sha256':contentHash,'x-aegis-signature':signature};
  if(payload!==null)headers['content-type']='application/json';const options={method,headers};if(method!=='GET'&&payload!==null)options.body=body;
  const response=await fetch(`${PANEL_URL}${pathAndQuery}`,options),raw=Buffer.from(await response.arrayBuffer());verifyResponse(response,raw,identity,nonce);return{response,raw,data:raw.length?JSON.parse(raw.toString('utf8')):null};
}

function sealLocal(snapshot,identity){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',storageKey(identity),iv),data=Buffer.concat([cipher.update(JSON.stringify(snapshot)),cipher.final()]);return JSON.stringify({v:1,iv:b64u(iv),tag:b64u(cipher.getAuthTag()),data:b64u(data)})}
function openLocal(payload,identity){const env=JSON.parse(payload),decipher=crypto.createDecipheriv('aes-256-gcm',storageKey(identity),Buffer.from(env.iv,'base64url'));decipher.setAuthTag(Buffer.from(env.tag,'base64url'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(env.data,'base64url')),decipher.final()]).toString('utf8'))}

function validateRoutes(routes){if(!Array.isArray(routes)||routes.length>100)throw new Error('invalid route count');const aliases=new Set();for(const route of routes){if(!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(route.alias)||aliases.has(route.alias))throw new Error('invalid or duplicate route alias');aliases.add(route.alias);for(const target of [...(route.upstreams||[]),...(route.playbackUpstreams||[])]){const url=new URL(target);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('invalid route upstream');}}return routes;}

class RemoteConfig {
  constructor(identity){this.identity=identity;this.routeSource=new AtomicRouteSource([]);this.revision=0;this.hash=null;this.applyState='waiting';this.error='';}
  load(){if(!fs.existsSync(CURRENT_FILE))return false;const snapshot=openLocal(fs.readFileSync(CURRENT_FILE,'utf8'),this.identity);verifySnapshot(snapshot,panelIdentity(this.identity));this.routeSource.apply(validateRoutes(runtimeRoutes(snapshot.nodes)));this.revision=snapshot.revision;this.hash=snapshot.hash;this.applyState='active';return true;}
  apply(snapshot){const decision=verifySnapshot(snapshot,panelIdentity(this.identity),{currentRevision:this.revision,currentHash:this.hash});if(decision.status==='noop')return decision;const routes=validateRoutes(runtimeRoutes(snapshot.nodes));if(fs.existsSync(CURRENT_FILE))writeAtomic(PREVIOUS_FILE,fs.readFileSync(CURRENT_FILE));writeAtomic(CURRENT_FILE,sealLocal(snapshot,this.identity));this.routeSource.apply(routes);this.revision=snapshot.revision;this.hash=snapshot.hash;this.applyState='active';this.error='';return decision;}
}

async function acknowledge(identity,config,status,error='',proxyHealthy=true){const payload={protocolVersion:1,revision:config.revision,hash:config.hash,status,error:String(error||'').slice(0,240),proxyHealthy};const result=await signedRequest(identity,'POST','/api/agent/v1/ack',payload);if(!result.response.ok)throw new Error(result.data?.error||`ack failed (${result.response.status})`);}

async function pollConfig(identity,config,proxyHealthy){const pathAndQuery=`/api/agent/v1/config?after=${config.revision}&wait=0`,result=await signedRequest(identity,'GET',pathAndQuery);if(result.response.status===204)return false;if(!result.response.ok)throw new Error(result.data?.error||`config poll failed (${result.response.status})`);let snapshot;try{snapshot=openAgentSnapshot({envelope:result.data,identity});config.apply(snapshot);await acknowledge(identity,config,'applied','',proxyHealthy);return true;}catch(error){if(snapshot)try{await acknowledge(identity,{revision:snapshot.revision,hash:snapshot.hash},'rejected',error.message,proxyHealthy)}catch{}throw error;}}

function startProxy(config,identity){const metrics=new Metrics({data:{}}),key=storageKey(identity),relay=makeProxyHandler(config.routeSource,key,metrics),server=http.createServer((req,res)=>{res.on('error',()=>{});try{const out=relay(req,res);if(out&&typeof out.catch==='function')out.catch(error=>{console.error('[aegis-agent] relay error',error?.message||error);if(!res.headersSent&&!res.writableEnded){res.writeHead(502,{'cache-control':'no-store'});res.end('bad gateway')}})}catch(error){if(!res.headersSent&&!res.writableEnded){res.writeHead(502,{'cache-control':'no-store'});res.end('bad gateway')}}});server.requestTimeout=0;server.headersTimeout=15_000;server.on('clientError',(_error,socket)=>{if(!socket.destroyed)socket.destroy()});server.on('upgrade',(req,socket,head)=>{socket.on('error',()=>socket.destroy());try{handleUpgrade(req,socket,head,config.routeSource,key)}catch{socket.destroy()}});return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(PROXY_PORT,'0.0.0.0',()=>resolve(server))})}

async function checkIn(identity,config,startedAt,bootId,proxyHealthy){const payload={protocolVersion:1,agentVersion:VERSION,bootId,uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),currentRevision:config.revision,currentConfigId:config.hash,applyState:config.applyState,proxyHealthy,domain:AGENT_DOMAIN,certificateNotAfter:null,capabilities:['registry-v1','config-v1','proxy-v1']},result=await signedRequest(identity,'POST','/api/agent/v1/check-in',payload);if(!result.response.ok)throw new Error(result.data?.error||`check-in failed (${result.response.status})`);return result.data;}

async function run(){const identity=loadIdentity();if(identity.panelUrl!==PANEL_URL)throw new Error('pinned panel URL mismatch');const config=new RemoteConfig(identity);try{config.load()}catch(error){config.error=`cached config rejected: ${error.message}`;config.applyState='error';}const server=await startProxy(config,identity),startedAt=Date.now(),bootId=randomToken(16);let delay=2_000;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));for(;;){try{const status=await checkIn(identity,config,startedAt,bootId,true);if(Number(status.desiredRevision||0)>config.revision)await pollConfig(identity,config,true);delay=Math.max(5_000,Number(status.heartbeatSeconds||15)*1000)}catch(error){config.error=String(error.message||error).slice(0,160);console.error(`[aegis-agent] ${config.error}`);delay=Math.min(300_000,Math.max(2_000,delay*2))}await sleep(delay)}}

if(process.argv.includes('--enroll'))await enroll();else await run();
