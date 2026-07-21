import crypto from 'node:crypto';
import { b64u, randomToken, timingEqual } from './security.js';
import { ensurePanelSigningIdentity } from './snapshot.js';
import { normalizeAgentDomain, replaceAgentDeployments } from './agent-registry.js';

export const AGENT_PROTOCOL_VERSION=1;
export const ENROLLMENT_TTL_MS=10*60_000;
const EMPTY_SHA256=b64u(crypto.createHash('sha256').update(Buffer.alloc(0)).digest());

const sha256=value=>b64u(crypto.createHash('sha256').update(value).digest());
const nowSeconds=()=>Math.floor(Date.now()/1000);
const safeName=value=>{
  const name=String(value||'').trim();
  if(!name||name.length>80||/[\r\n\0]/.test(name))throw new Error('机器名称应为 1–80 个字符');
  return name;
};
const shellQuote=value=>`'${String(value).replaceAll("'",`'"'"'`)}'`;

function publicHttpsOrigin(value) {
  let url;
  try { url=new URL(String(value||'')); } catch { throw new Error('请先在部署向导配置 HTTPS 公网域名'); }
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('PUBLIC_BASE_URL 必须是纯 HTTPS 域名');
  return url.origin;
}

export function enrollmentDigest(token) {
  return sha256(Buffer.from(String(token),'utf8'));
}

export function issueEnrollment(data,{name,domain='',routeIds=[],now=Date.now()}={}) {
  const agentName=safeName(name),agentDomain=normalizeAgentDomain(domain),knownRoutes=new Set((data.routes||[]).map(route=>route.id));
  const selected=[...new Set((Array.isArray(routeIds)?routeIds:[]).map(String))];
  if(selected.some(id=>!knownRoutes.has(id)))throw new Error('选择了不存在的 Emby 节点');
  const token=randomToken(32),createdAt=new Date(now).toISOString(),expiresAt=new Date(now+ENROLLMENT_TTL_MS).toISOString();
  data.enrollmentTokens=Array.isArray(data.enrollmentTokens)?data.enrollmentTokens:[];
  data.enrollmentTokens=data.enrollmentTokens.filter(item=>!item.usedAt&&!item.revokedAt&&new Date(item.expiresAt).getTime()>now-60_000).slice(-49);
  const record={id:randomToken(16),digest:enrollmentDigest(token),name:agentName,domain:agentDomain,routeIds:selected,createdAt,expiresAt,usedAt:null,revokedAt:null};
  data.enrollmentTokens.push(record);
  return {record,token};
}

export function consumeEnrollment(data,token,agentInput,now=Date.now()) {
  const digest=enrollmentDigest(token),tokens=Array.isArray(data.enrollmentTokens)?data.enrollmentTokens:[];
  const record=tokens.find(item=>timingEqual(item.digest||'',digest));
  if(!record||record.usedAt||record.revokedAt||new Date(record.expiresAt).getTime()<now)throw Object.assign(new Error('注册令牌无效、已使用或已过期'),{status:401});
  const signPublicKey=validatePublicKey(agentInput.signPublicKey,'ed25519'),boxPublicKey=validatePublicKey(agentInput.boxPublicKey,'x25519');
  const at=new Date(now).toISOString(),agentId=randomToken(16);
  const agent={id:agentId,name:record.name,transport:'poll',domain:record.domain,state:'active',signPublicKey,boxPublicKey,
    agentVersion:String(agentInput.agentVersion||'unknown').slice(0,32),capabilities:cleanCapabilities(agentInput.capabilities),
    machine:cleanMachine(agentInput.machine),applyState:'waiting',proxyHealthy:false,desiredRevision:0,appliedRevision:0,
    enrolledAt:at,createdAt:at,updatedAt:at,lastSeen:null};
  data.agents=Array.isArray(data.agents)?data.agents:[];data.agents.push(agent);
  replaceAgentDeployments(data,agentId,record.routeIds||[],at);
  record.usedAt=at;record.agentId=agentId;delete record.digest;
  return agent;
}

function cleanCapabilities(value) {
  return [...new Set((Array.isArray(value)?value:[]).map(item=>String(item)).filter(item=>/^[a-z0-9-]{1,32}$/.test(item)))].slice(0,16);
}

function cleanMachine(value={}) {
  const out={};
  for(const field of ['hostname','architecture','platform']){
    const item=String(value[field]||'').trim();
    if(item&&!/[\r\n\0]/.test(item))out[field]=item.slice(0,80);
  }
  return out;
}

function validatePublicKey(value,expectedType) {
  try {
    const encoded=String(value||''),der=Buffer.from(encoded,'base64url');
    if(!encoded||der.toString('base64url')!==encoded)throw new Error();
    const key=crypto.createPublicKey({key:der,format:'der',type:'spki'});
    if(key.asymmetricKeyType!==expectedType)throw new Error();
    return b64u(key.export({format:'der',type:'spki'}));
  } catch { throw Object.assign(new Error(`无效的 ${expectedType} 公钥`),{status:400}); }
}

export function enrollmentInstallCommand({publicBaseUrl,token,name,domain}) {
  const origin=publicHttpsOrigin(publicBaseUrl);
  return `curl -fsSL ${origin}/agent-install.sh | sudo sh -s -- --panel ${shellQuote(origin)} --token ${shellQuote(token)} --name ${shellQuote(safeName(name))}${domain?` --domain ${shellQuote(normalizeAgentDomain(domain))}`:''}`;
}

function canonicalQuery(url) {
  const entries=[...url.searchParams.entries()].sort((a,b)=>Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0]))||Buffer.compare(Buffer.from(a[1]),Buffer.from(b[1])));
  const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,ch=>`%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return entries.length?`${url.pathname}?${entries.map(([key,value])=>`${encode(key)}=${encode(value)}`).join('&')}`:url.pathname;
}

export function agentRequestInput({method,path,agentId,timestamp,nonce,contentHash}) {
  return ['AegisRelay-Agent-Request-v1',String(method).toUpperCase(),path,agentId,String(timestamp),nonce,contentHash].join('\n');
}

export function panelResponseInput({status,requestNonce,timestamp,contentHash}) {
  return ['AegisRelay-Panel-Response-v1',String(status),requestNonce,String(timestamp),contentHash].join('\n');
}

async function readBody(req,limit=256*1024) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('request too large'),{status:413});chunks.push(chunk);}
  const raw=Buffer.concat(chunks);let parsed;
  try{parsed=raw.length?JSON.parse(raw.toString('utf8')):{}}catch{throw Object.assign(new Error('invalid JSON'),{status:400});}
  return {raw,parsed};
}

function importPanelPrivate(identity) { return crypto.createPrivateKey({key:Buffer.from(identity.privateKey,'base64url'),format:'der',type:'pkcs8'}); }
function baseHeaders(extra={}) { return {'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...extra}; }

export class AgentApi {
  constructor({store,version='0.0.0'}) { this.store=store;this.version=version;this.panelIdentity=ensurePanelSigningIdentity(store);this.nonces=new Map(); }

  send(res,status,payload,requestNonce='enroll') {
    const raw=Buffer.from(JSON.stringify(payload)),timestamp=nowSeconds(),contentHash=sha256(raw);
    const signature=b64u(crypto.sign(null,Buffer.from(panelResponseInput({status,requestNonce,timestamp,contentHash})),importPanelPrivate(this.panelIdentity)));
    res.writeHead(status,baseHeaders({'x-aegis-panel-key-id':this.panelIdentity.keyId,'x-aegis-timestamp':String(timestamp),'x-aegis-content-sha256':contentHash,'x-aegis-signature':signature}));res.end(raw);
  }

  reject(res,error,nonce='error') { this.send(res,error.status||400,{error:String(error.message||'request rejected').slice(0,160)},nonce); }

  verify(req,url,raw) {
    const id=String(req.headers['x-aegis-agent-id']||''),timestamp=Number(req.headers['x-aegis-timestamp']),nonce=String(req.headers['x-aegis-nonce']||''),contentHash=String(req.headers['x-aegis-content-sha256']||''),signature=String(req.headers['x-aegis-signature']||'');
    const agent=this.store.data.agents.find(item=>item.id===id&&item.id!=='local');
    if(!agent||agent.state==='revoked')throw Object.assign(new Error('unknown agent'),{status:401,nonce});
    if(!Number.isSafeInteger(timestamp)||Math.abs(nowSeconds()-timestamp)>300)throw Object.assign(new Error('request timestamp rejected'),{status:401,nonce});
    const expected=sha256(raw);if(!timingEqual(contentHash,expected))throw Object.assign(new Error('request body hash mismatch'),{status:401,nonce});
    let publicKey;try{publicKey=crypto.createPublicKey({key:Buffer.from(agent.signPublicKey,'base64url'),format:'der',type:'spki'});}catch{throw Object.assign(new Error('agent key invalid'),{status:401,nonce});}
    const input=agentRequestInput({method:req.method,path:canonicalQuery(url),agentId:id,timestamp,nonce,contentHash});
    if(!signature||!crypto.verify(null,Buffer.from(input),publicKey,Buffer.from(signature,'base64url')))throw Object.assign(new Error('request signature rejected'),{status:401,nonce});
    const at=Date.now();for(const [key,seen] of this.nonces)if(at-seen>10*60_000)this.nonces.delete(key);
    const nonceKey=`${id}:${nonce}`;if(!/^[A-Za-z0-9_-]{20,64}$/.test(nonce)||this.nonces.has(nonceKey))throw Object.assign(new Error('request nonce rejected'),{status:409,nonce});
    this.nonces.set(nonceKey,at);return {agent,nonce};
  }

  async handle(req,res) {
    const url=new URL(req.url,'http://agent.invalid');let requestNonce='error';
    try{
      if(req.method==='POST'&&url.pathname==='/api/agent/v1/enroll'){
        const {parsed}=await readBody(req),agentInput=parsed.agent||{};requestNonce=String(parsed.requestNonce||'enroll');
        if(parsed.protocolVersion!==AGENT_PROTOCOL_VERSION)throw Object.assign(new Error('unsupported protocol version'),{status:400});
        const agent=consumeEnrollment(this.store.data,parsed.token, {...agentInput,machine:parsed.machine});
        this.store.audit('agent.enrolled',req.socket.remoteAddress||'unknown',agent.id);
        return this.send(res,201,{protocolVersion:AGENT_PROTOCOL_VERSION,agentId:agent.id,panelKeyId:this.panelIdentity.keyId,panelSigningPublicKey:this.panelIdentity.publicKey,serverTime:nowSeconds(),poll:{path:'/api/agent/v1/config',maxWaitSeconds:25,heartbeatSeconds:30}},requestNonce);
      }
      if(req.method==='POST'&&url.pathname==='/api/agent/v1/check-in'){
        const {raw,parsed}=await readBody(req),verified=this.verify(req,url,raw);requestNonce=verified.nonce;
        const agent=verified.agent,at=new Date().toISOString();agent.lastSeen=at;agent.updatedAt=at;agent.agentVersion=String(parsed.agentVersion||agent.agentVersion||'unknown').slice(0,32);agent.applyState=['active','waiting','error'].includes(parsed.applyState)?parsed.applyState:'waiting';agent.proxyHealthy=parsed.proxyHealthy===true;agent.appliedRevision=Number.isSafeInteger(parsed.currentRevision)?Math.max(0,parsed.currentRevision):Number(agent.appliedRevision||0);agent.capabilities=cleanCapabilities(parsed.capabilities);agent.reportedDomain=normalizeAgentDomain(parsed.domain||'');
        this.store.save();return this.send(res,200,{protocolVersion:AGENT_PROTOCOL_VERSION,serverTime:nowSeconds(),desiredRevision:Number(agent.desiredRevision||0),heartbeatSeconds:30,agentVersion:this.version},requestNonce);
      }
      throw Object.assign(new Error('not found'),{status:404});
    }catch(error){return this.reject(res,error,error.nonce||requestNonce);}
  }
}

export const EMPTY_BODY_SHA256=EMPTY_SHA256;
