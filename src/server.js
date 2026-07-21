import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanAlias, deriveKey, hashPassword, newTotpSecret, randomToken, RateLimiter, tokenDigest, verifyPassword, verifyTotp, timingEqual } from './security.js';
import { Store } from './store.js';
import { getRuntimeStatus, handleUpgrade, makeProxyHandler, validateUpstreamList } from './proxy.js';
import { Metrics } from './metrics.js';
import { diagnoseRoute } from './diagnostics.js';
import { Notifier } from './notifier.js';
import { clientCredentials, savedCredentials } from './credentials.js';
import { adminRelative, isRootAdminRequest, normalizeAdminPath } from './admin-path.js';
import { customConnectionKey } from './connection-key.js';
import { isRouteAuthKey, newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from './route-auth.js';
import { LocalAgent } from './local-agent.js';
import { ensureLocalDeployment, LOCAL_AGENT_ID, normalizeAgentDomain, publicAgent, removeRouteDeployments, replaceAgentDeployments } from './agent-registry.js';
import { AgentApi, enrollmentInstallCommand, issueEnrollment, normalizeCertificateEmail } from './agent-api.js';
import { aggregateTelemetry, sanitizeTelemetry, telemetryFromMetrics } from './telemetry.js';
import { activeLocalDomain, baseHostname, domainRequestRole, readDomainStatus, requestDomainSwitch } from './domain-control.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
const cfg = {
  adminHost: process.env.ADMIN_HOST || '127.0.0.1', adminPort: +(process.env.ADMIN_PORT || 9080),
  proxyHost: process.env.PROXY_HOST || '0.0.0.0', proxyPort: +(process.env.PROXY_PORT || 8080),
  adminPath: normalizeAdminPath(process.env.ADMIN_PATH ?? '_aegis'),
  dataFile: process.env.DATA_FILE || path.join(ROOT, 'data', 'aegis.enc.json'),
  setupToken: process.env.SETUP_TOKEN || '', secureCookies: process.env.SECURE_COOKIES !== 'false', publicBaseUrl:process.env.PUBLIC_BASE_URL||'', localProxyBaseUrl:process.env.LOCAL_PROXY_BASE_URL||'', certificateEmail:process.env.CERTIFICATE_EMAIL||''
};
const key = deriveKey(process.env.APP_MASTER_KEY); const store = new Store(cfg.dataFile, key);
if(!store.data.settings.certificateEmail&&cfg.certificateEmail){store.data.settings.certificateEmail=normalizeCertificateEmail(cfg.certificateEmail);store.save();}
const configuredLocalDomain=activeLocalDomain(cfg);
const localRecord=store.data.agents.find(agent=>agent.id===LOCAL_AGENT_ID);
if(localRecord&&configuredLocalDomain&&localRecord.domain!==configuredLocalDomain){localRecord.domain=configuredLocalDomain;localRecord.updatedAt=new Date().toISOString();store.save();}
const localAgent = new LocalAgent({store}); localAgent.start();
const agentApi = new AgentApi({store,version:APP_VERSION});
const metrics = new Metrics(store);
const notifier = new Notifier(store,metrics);
const sessions = store.data.sessions && typeof store.data.sessions === 'object' && !Array.isArray(store.data.sessions) ? store.data.sessions : {};
store.data.sessions = sessions;
function pruneSessions(){const now=Date.now();for(const [sid,session] of Object.entries(sessions))if(!session||Number(session.expires)<now)delete sessions[sid];for(const [sid] of Object.entries(sessions).sort((a,b)=>Number(b[1].expires)-Number(a[1].expires)).slice(16))delete sessions[sid]}
pruneSessions();
const loginLimiter = new RateLimiter(6, 5 * 60_000);
const ui = fs.readFileSync(path.join(ROOT, 'web', 'index.html'),'utf8').replace('APP_JS',`app.js?v=${APP_VERSION}`).replace('STYLE_CSS',`style.css?v=${APP_VERSION}`).replace('HELP_CSS',`help.css?v=${APP_VERSION}`).replaceAll('APP_VERSION',APP_VERSION);
const appjs = fs.readFileSync(path.join(ROOT,'web','app.js'));
const stylesheet = fs.readFileSync(path.join(ROOT,'web','style.css'));
const helpStylesheet = fs.readFileSync(path.join(ROOT,'web','help.css'));
const agentInstaller = fs.readFileSync(path.join(ROOT,'scripts','agent-install.sh'));
const agentUpgrader = fs.readFileSync(path.join(ROOT,'scripts','agent-upgrade.sh'));

function headers(extra = {}) { return { 'cache-control':'no-store', 'content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'permissions-policy':'camera=(), microphone=(), geolocation=()', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff', 'x-frame-options':'DENY', ...extra }; }
function json(res, status, body, extra = {}) { res.writeHead(status, headers({ 'content-type':'application/json; charset=utf-8', ...extra })); res.end(JSON.stringify(body)); }
function ip(req) { return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, ''); }
async function body(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('application/json required'), { status: 415 });
  let size = 0, chunks = []; for await (const c of req) { size += c.length; if (size > 32 * 1024) throw Object.assign(new Error('request too large'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
function cookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(v=>v.length===2)); }
function auth(req) { const sid = cookies(req).aegis_session, s = Object.prototype.hasOwnProperty.call(sessions,sid)?sessions[sid]:null; if (!s || s.expires < Date.now()) { if(sid&&s){delete sessions[sid];store.save()} return null; } s.expires = Date.now() + 30 * 60_000; return { sid, ...s }; }
function requireAuth(req) { const s = auth(req); if (!s) throw Object.assign(new Error('登录已失效，请重新登录'), { status: 401 }); if (!timingEqual(req.headers['x-csrf-token'] || '', s.csrf)) throw Object.assign(new Error('安全校验已失效，请重新登录'), { status: 403 }); return s; }
function routeUpstreams(r) { return r.upstreams?.length?r.upstreams:(r.upstream?[r.upstream]:[]); }
function cleanProfile(value = {}) {
  const out={enabled:value.enabled===true};
  for(const field of ['userAgent','client','deviceName','deviceId']){
    const v=String(value[field]||'').trim(); if(/[\r\n]/.test(v)||v.length>160)throw new Error(`invalid client profile field: ${field}`); if(v)out[field]=v;
  }
  return out;
}
function cleanTags(value){return[...new Set((Array.isArray(value)?value:String(value||'').split(',')).map(x=>String(x).trim()).filter(Boolean).slice(0,8).map(x=>x.slice(0,24)))]}
function numeric(value,min,max){const n=Number(value||0);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):0}
function connectionKey(value){return customConnectionKey(value)||randomToken(24)}
function routeAuthFields(accessKey) {
  if (!accessKey) return { keyDigest:null, accessKey:null };
  const routeAuthKey=newRouteAuthKey();
  return { authVersion:ROUTE_AUTH_VERSION, routeAuthKey, keyDigest:routeTokenDigest(accessKey,routeAuthKey), accessKey };
}
function publicRoute(r) { return { id:r.id, alias:r.alias, name:r.name, enabled:r.enabled, upstreams:routeUpstreams(r), playbackUpstreams:r.playbackUpstreams||[], allowPrivate:r.allowPrivate, tlsVerify:r.tlsVerify, accessMode:r.accessMode||'key', authMigrationRequired:r.authMigrationRequired===true, showOnHome:r.showOnHome===true, clientProfile:r.clientProfile||{enabled:false},tags:r.tags||[],notes:r.notes||'',favorite:r.favorite===true,sortOrder:Number(r.sortOrder||0),speedLimitMbps:Number(r.speedLimitMbps||0),monthlyQuotaGB:Number(r.monthlyQuotaGB||0),reminderDays:Number(r.reminderDays||0),reminderLastAt:r.reminderLastAt||null,createdAt:r.createdAt,updatedAt:r.updatedAt }; }
function localDomainStatus(){const status=readDomainStatus(cfg.dataFile);if(!status)return null;if(status.state==='active'&&status.currentDomain&&status.currentDomain!==configuredLocalDomain)return{...status,state:'applying',message:'Nginx 已切换，面板服务正在重新载入配置'};return status}
function agentView(agent){const view=publicAgent(agent,store.data,agent.id===LOCAL_AGENT_ID?localAgent.status():null);return agent.id===LOCAL_AGENT_ID?{...view,domain:configuredLocalDomain||view.domain||'',domainChange:localDomainStatus(),automaticDomainSwitch:true}:{...view,domainChange:agent.domainStatus||null,automaticDomainSwitch:true}}
function clientBaseUrl(){return cfg.localProxyBaseUrl||cfg.publicBaseUrl}
function credentialsFor(route,accessKey){return{...clientCredentials(route,accessKey),publicBaseUrl:clientBaseUrl()}}
function checkedAlias(value){const alias=cleanAlias(value);if(['r','api','gateway','app','index','index.html','favicon.ico'].includes(alias))throw new Error('alias is reserved');return alias;}
function dashboardSnapshot(){
  const localSnapshot=metrics.snapshot(localAgent.routeSource.getRoutes()),localTelemetry=telemetryFromMetrics(localSnapshot),localRecord=store.data.agents.find(agent=>agent.id===LOCAL_AGENT_ID)||{id:LOCAL_AGENT_ID,name:'主代理机器'},localView=agentView(localRecord);
  const localDomain=configuredLocalDomain;
  const machines=[{...localView,name:localRecord.name||'主代理机器',domain:localView.domain||localDomain,telemetry:localTelemetry,lastTelemetryAt:new Date().toISOString()}];
  for(const agent of store.data.agents.filter(item=>item.id!==LOCAL_AGENT_ID)){const view=publicAgent(agent,store.data);machines.push({...view,telemetry:sanitizeTelemetry(agent.telemetry),lastTelemetryAt:agent.lastTelemetryAt||null})}
  const combined=aggregateTelemetry(machines.map(machine=>machine.telemetry));
  return {...localSnapshot,totalRequests:combined.totalRequests,totalBytes:combined.totalBytes,monthBytes:combined.monthBytes,playbackRequests:combined.playbackRequests,errors:combined.errors,active:combined.active,daily:combined.daily,machines,onlineMachines:machines.filter(machine=>machine.status==='online'&&machine.proxyHealthy).length};
}

async function api(req, res, rel, cookiePath = cfg.adminPath) {
  if (req.method === 'GET' && rel === '/status') return json(res, 200, { initialized:!!store.data.admin, adminPath:cfg.adminPath, version:APP_VERSION });
  if (req.method === 'POST' && rel === '/setup') {
    if (store.data.admin) return json(res, 409, { error:'already initialized' });
    const b = await body(req); if (!cfg.setupToken || !timingEqual(b.setupToken || '', cfg.setupToken)) { store.audit('setup.denied', ip(req)); return json(res, 403, { error:'invalid setup token' }); }
    const secret = newTotpSecret(), recovery = Array.from({length:8},()=>randomToken(9));
    store.data.admin = { username:String(b.username || 'admin').slice(0,64), passwordHash:hashPassword(b.password), totpSecret:secret, recoveryDigests:recovery.map(v=>tokenDigest(v,key)), createdAt:new Date().toISOString() };
    store.audit('admin.initialized', ip(req));
    const label = encodeURIComponent(`AegisRelay:${store.data.admin.username}`); return json(res, 201, { totpUri:`otpauth://totp/${label}?secret=${secret}&issuer=AegisRelay&digits=6&period=30`, secret, recovery });
  }
  if (req.method === 'POST' && rel === '/login') {
    if (!store.data.admin || !loginLimiter.take(ip(req))) { store.audit('login.denied', ip(req)); return json(res, 429, { error:'try again later' }); }
    const b = await body(req), a = store.data.admin; let second = verifyTotp(a.totpSecret, b.code);
    if (!second && b.recovery) { const d=tokenDigest(String(b.recovery),key), idx=a.recoveryDigests.findIndex(x=>timingEqual(x,d)); if(idx>=0){a.recoveryDigests.splice(idx,1);store.save();second=true;} }
    if (!verifyPassword(b.password || '', a.passwordHash) || !second) { store.audit('login.failed', ip(req)); return json(res, 401, { error:'invalid credentials' }); }
    const sid=randomToken(), csrf=randomToken(24); sessions[sid]={csrf,expires:Date.now()+30*60_000};pruneSessions();store.audit('login.success',ip(req));
    const cookie=`aegis_session=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=604800${cfg.secureCookies?'; Secure':''}`; return json(res,200,{csrf},{'set-cookie':cookie});
  }
  if (req.method === 'POST' && rel === '/logout') { const s=requireAuth(req);delete sessions[s.sid];store.audit('logout',ip(req));return json(res,200,{ok:true},{'set-cookie':`aegis_session=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0`}); }
  // Resume an existing session after a page refresh: hands the CSRF token back to a browser that still
  // holds the HttpOnly, SameSite=Strict session cookie. No CSRF token is required to read it, and the
  // strict cookie plus same-origin policy keep it unreadable to other sites.
  if (req.method === 'GET' && rel === '/session') { const s=auth(req); if(!s) return json(res,401,{error:'登录已失效，请重新登录'}); return json(res,200,{csrf:s.csrf,username:store.data.admin?.username||''}); }
  requireAuth(req);
  if (req.method === 'GET' && rel === '/routes') return json(res,200,{routes:store.data.routes.map(publicRoute).sort((a,b)=>Number(b.favorite)-Number(a.favorite)||a.sortOrder-b.sortOrder||a.name.localeCompare(b.name))});
  if (req.method === 'GET' && rel === '/agents') return json(res,200,{agents:store.data.agents.map(agentView)});
  if (req.method === 'POST' && rel === '/agents/enrollment') {const b=await body(req),issued=issueEnrollment(store.data,{name:b.name,domain:b.domain,routeIds:b.routeIds});let command;try{command=enrollmentInstallCommand({publicBaseUrl:cfg.publicBaseUrl,token:issued.token,name:issued.record.name,domain:issued.record.domain,email:store.data.settings.certificateEmail});}catch(error){store.data.enrollmentTokens=store.data.enrollmentTokens.filter(item=>item!==issued.record);throw error;}store.audit('agent.enrollment_created',ip(req),issued.record.id);return json(res,201,{expiresAt:issued.record.expiresAt,command,uninstallCommand:'sudo aegis-relay-agent uninstall'});}
  if (req.method === 'GET' && rel === '/dashboard') return json(res,200,dashboardSnapshot());
  if (req.method === 'GET' && rel === '/deployment') return json(res,200,{adminPath:cookiePath,secureCookies:cfg.secureCookies,publicBaseUrl:cfg.publicBaseUrl,localProxyBaseUrl:clientBaseUrl(),splitDomains:!!cfg.localProxyBaseUrl&&baseHostname(cfg.localProxyBaseUrl)!==baseHostname(cfg.publicBaseUrl),httpsReady:cfg.secureCookies&&cfg.publicBaseUrl.startsWith('https://'),certificateEmail:store.data.settings.certificateEmail||'',domainChange:localDomainStatus()});
  if (req.method === 'PUT' && rel === '/deployment') {const b=await body(req);store.data.settings.certificateEmail=normalizeCertificateEmail(b.certificateEmail);store.audit('deployment.certificate_email_updated',ip(req));return json(res,200,{ok:true,certificateEmail:store.data.settings.certificateEmail});}
  if (req.method === 'GET' && rel === '/notifications') return json(res,200,notifier.view());
  if (req.method === 'PUT' && rel === '/notifications') {const b=await body(req),result=notifier.configure(b);store.audit('notifications.updated',ip(req));return json(res,200,result);}
  if (req.method === 'POST' && rel === '/notifications/test') {await notifier.test();store.audit('notifications.tested',ip(req));return json(res,200,{ok:true});}
  if (req.method === 'GET' && rel === '/events') {res.writeHead(200,headers({'content-type':'text/event-stream','connection':'keep-alive'}));const send=()=>res.write(`event: dashboard\ndata: ${JSON.stringify(dashboardSnapshot())}\n\n`);send();const off=metrics.subscribe(send),timer=setInterval(send,15000);req.on('close',()=>{off();clearInterval(timer)});return;}
  if (req.method === 'GET' && rel === '/export') return json(res,200,{version:1,exportedAt:new Date().toISOString(),routes:store.data.routes.map(r=>{const x=publicRoute(r);delete x.id;delete x.createdAt;delete x.updatedAt;return x})});
  if (req.method === 'POST' && rel === '/import') {const b=await body(req),items=Array.isArray(b.routes)?b.routes.slice(0,50):[];const credentials=[],errors=[];for(const item of items){try{const alias=checkedAlias(item.alias);if(store.data.routes.some(r=>r.alias===alias))throw new Error('alias already exists');const allowPrivate=item.allowPrivate===true,upstreams=await validateUpstreamList(item.upstreams||item.upstream,allowPrivate),playbackUpstreams=String(item.playbackUpstreams||'').trim()?await validateUpstreamList(item.playbackUpstreams,allowPrivate):[],accessMode=item.accessMode==='alias_only'?'alias_only':'key',accessKey=accessMode==='key'?randomToken(24):'',now=new Date().toISOString();const r={id:randomToken(12),alias,name:String(item.name||alias).slice(0,80),upstreams,playbackUpstreams,allowPrivate,tlsVerify:item.tlsVerify!==false,enabled:item.enabled!==false,accessMode,showOnHome:item.showOnHome===true,clientProfile:cleanProfile(item.clientProfile),tags:cleanTags(item.tags),notes:String(item.notes||'').slice(0,500),favorite:item.favorite===true,sortOrder:numeric(item.sortOrder,-10000,10000),speedLimitMbps:numeric(item.speedLimitMbps,0,100000),monthlyQuotaGB:numeric(item.monthlyQuotaGB,0,1000000),reminderDays:numeric(item.reminderDays,0,365),...routeAuthFields(accessKey),createdAt:now,updatedAt:now};store.data.routes.push(r);ensureLocalDeployment(store.data,r.id,now);credentials.push({alias,...credentialsFor(r,accessKey)})}catch(e){errors.push({alias:String(item?.alias||''),error:e.message})}}store.audit('routes.imported',ip(req),`${credentials.length} imported`);(localAgent.reconcile(),agentApi.invalidate());return json(res,200,{imported:credentials.length,credentials,errors});}
  if (req.method === 'GET' && rel === '/diagnostics') return json(res,200,{nodes:getRuntimeStatus(localAgent.routeSource.getRoutes())});
  if (req.method === 'GET' && rel === '/audit') return json(res,200,{audit:store.data.audit.slice(0,100)});
  if (req.method === 'POST' && rel === '/routes') {
    const b=await body(req), alias=checkedAlias(b.alias); if(store.data.routes.some(r=>r.alias===alias)) return json(res,409,{error:'alias already exists'});
    const allowPrivate=b.allowPrivate===true, upstreams=await validateUpstreamList(b.upstreams||b.upstream,allowPrivate);
    const playbackUpstreams=String(b.playbackUpstreams||'').trim()?await validateUpstreamList(b.playbackUpstreams,allowPrivate):[];
    const accessMode=b.accessMode==='alias_only'?'alias_only':'key', accessKey=accessMode==='key'?connectionKey(b.accessKey):'', now=new Date().toISOString();
    const r={id:randomToken(12),alias,name:String(b.name||alias).slice(0,80),upstreams,playbackUpstreams,allowPrivate,tlsVerify:b.tlsVerify!==false,enabled:true,accessMode,showOnHome:b.showOnHome===true,clientProfile:cleanProfile(b.clientProfile),tags:cleanTags(b.tags),notes:String(b.notes||'').slice(0,500),favorite:b.favorite===true,sortOrder:numeric(b.sortOrder,-10000,10000),speedLimitMbps:numeric(b.speedLimitMbps,0,100000),monthlyQuotaGB:numeric(b.monthlyQuotaGB,0,1000000),reminderDays:numeric(b.reminderDays,0,365),...routeAuthFields(accessKey),createdAt:now,updatedAt:now};
    store.data.routes.push(r);ensureLocalDeployment(store.data,r.id,now);store.audit('route.created',ip(req),alias);(localAgent.reconcile(),agentApi.invalidate());return json(res,201,{route:publicRoute(r),...credentialsFor(r,accessKey)});
  }
  const agentMatch=rel.match(/^\/agents\/([^/]+)$/);if(agentMatch){const agent=store.data.agents.find(item=>item.id===agentMatch[1]);if(!agent)return json(res,404,{error:'agent not found'});
    if(req.method==='PATCH'){const b=await body(req),now=new Date().toISOString(),localDomainRequested=agent.id===LOCAL_AGENT_ID&&b.domain!==undefined;if(b.name!==undefined){const name=String(b.name||'').trim();if(!name||name.length>80)return json(res,400,{error:'invalid agent name'});agent.name=name;}if(b.domain!==undefined){const domain=normalizeAgentDomain(b.domain);if(agent.id===LOCAL_AGENT_ID){if(!cfg.publicBaseUrl.startsWith('https://'))return json(res,409,{error:'请先在部署向导完成面板 HTTPS 配置'});if(domain===baseHostname(cfg.publicBaseUrl))return json(res,409,{error:'代理域名不能与面板域名相同'});const existing=localDomainStatus();if(existing&&['pending','applying'].includes(existing.state)&&existing.desiredDomain!==domain)return json(res,409,{error:`正在切换到 ${existing.desiredDomain}，完成后再提交新域名`});if(domain!==configuredLocalDomain&&!(existing&&['pending','applying'].includes(existing.state)))requestDomainSwitch({dataFile:cfg.dataFile,domain,email:store.data.settings.certificateEmail,currentDomain:configuredLocalDomain});else if(domain===configuredLocalDomain)agent.domain=domain;}else{if(domain&&domain!==agent.domain){if(!store.data.settings.certificateEmail)return json(res,409,{error:'请先在部署向导保存统一证书邮箱'});agent.desiredDomain=domain;agent.domainStatus={requestId:'',state:'pending',desiredDomain:domain,currentDomain:agent.domain||'',message:'等待机器申请证书并切换 Nginx',updatedAt:new Date().toISOString()};}else if(!domain){delete agent.desiredDomain;delete agent.domainStatus;agent.domain='';}}}if(b.routeIds!==undefined){if(!Array.isArray(b.routeIds))return json(res,400,{error:'routeIds must be an array'});const routeIds=[...new Set(b.routeIds.map(String))];if(routeIds.some(id=>!store.data.routes.some(route=>route.id===id)))return json(res,400,{error:'unknown route id'});replaceAgentDeployments(store.data,agent.id,routeIds,now);}agent.updatedAt=now;if(agent.id===LOCAL_AGENT_ID)localAgent.reconcile();agentApi.invalidate();store.audit(localDomainRequested?'agent.local_domain_requested':'agent.updated',ip(req),agent.id);return json(res,200,{agent:agentView(agent)});}
    if(req.method==='DELETE'){if(agent.id===LOCAL_AGENT_ID)return json(res,409,{error:'the local agent cannot be deleted'});store.data.agents=store.data.agents.filter(item=>item!==agent);store.data.deployments=store.data.deployments.filter(item=>item.agentId!==agent.id);store.audit('agent.deleted',ip(req),agent.id);agentApi.invalidate();return json(res,200,{ok:true});}
  }
  const m=rel.match(/^\/routes\/([^/]+)$/); if(m){const r=store.data.routes.find(x=>x.id===m[1]);if(!r)return json(res,404,{error:'not found'});
    if(req.method==='PATCH'){const b=await body(req);if(b.name!==undefined)r.name=String(b.name).slice(0,80);if(b.enabled!==undefined)r.enabled=b.enabled===true;if(b.tlsVerify!==undefined)r.tlsVerify=b.tlsVerify===true;if(b.showOnHome!==undefined)r.showOnHome=b.showOnHome===true;if(b.clientProfile!==undefined)r.clientProfile=cleanProfile(b.clientProfile);if(b.tags!==undefined)r.tags=cleanTags(b.tags);if(b.notes!==undefined)r.notes=String(b.notes).slice(0,500);if(b.favorite!==undefined)r.favorite=b.favorite===true;if(b.sortOrder!==undefined)r.sortOrder=numeric(b.sortOrder,-10000,10000);if(b.speedLimitMbps!==undefined)r.speedLimitMbps=numeric(b.speedLimitMbps,0,100000);if(b.monthlyQuotaGB!==undefined)r.monthlyQuotaGB=numeric(b.monthlyQuotaGB,0,1000000);if(b.reminderDays!==undefined)r.reminderDays=numeric(b.reminderDays,0,365);
      if(b.alias!==undefined){const a=checkedAlias(b.alias);if(store.data.routes.some(x=>x!==r&&x.alias===a))return json(res,409,{error:'alias already exists'});r.alias=a;}
      if(b.upstreams!==undefined||b.upstream!==undefined||b.playbackUpstreams!==undefined||b.allowPrivate!==undefined){r.allowPrivate=b.allowPrivate===undefined?r.allowPrivate:b.allowPrivate===true;r.upstreams=await validateUpstreamList(b.upstreams||b.upstream||routeUpstreams(r),r.allowPrivate);r.playbackUpstreams=String(b.playbackUpstreams??(r.playbackUpstreams||[])).trim()?await validateUpstreamList(b.playbackUpstreams??r.playbackUpstreams,r.allowPrivate):[];delete r.upstream;}r.updatedAt=new Date().toISOString();store.audit('route.updated',ip(req),r.alias);(localAgent.reconcile(),agentApi.invalidate());return json(res,200,{route:publicRoute(r)});}
    if(req.method==='DELETE'){store.data.routes=store.data.routes.filter(x=>x!==r);removeRouteDeployments(store.data,r.id);store.audit('route.deleted',ip(req),r.alias);(localAgent.reconcile(),agentApi.invalidate());return json(res,200,{ok:true});}
  }
  const credentials=rel.match(/^\/routes\/([^/]+)\/credentials$/);if(credentials&&req.method==='GET'){const r=store.data.routes.find(x=>x.id===credentials[1]);if(!r)return json(res,404,{error:'not found'});store.audit('route.credentials_viewed',ip(req),r.alias);return json(res,200,{...savedCredentials(r),publicBaseUrl:clientBaseUrl()});}
  const rot=rel.match(/^\/routes\/([^/]+)\/rotate-key$/);if(rot&&req.method==='POST'){const r=store.data.routes.find(x=>x.id===rot[1]);if(!r)return json(res,404,{error:'not found'});if(r.accessMode==='alias_only')return json(res,409,{error:'this node does not use an access key'});const b=await body(req),accessKey=connectionKey(b.accessKey),routeAuthKey=r.authVersion===ROUTE_AUTH_VERSION&&isRouteAuthKey(r.routeAuthKey)?r.routeAuthKey:newRouteAuthKey();r.authVersion=ROUTE_AUTH_VERSION;r.routeAuthKey=routeAuthKey;r.keyDigest=routeTokenDigest(accessKey,routeAuthKey);r.accessKey=accessKey;delete r.authMigrationRequired;r.updatedAt=new Date().toISOString();store.audit('route.key_rotated',ip(req),r.alias);(localAgent.reconcile(),agentApi.invalidate());return json(res,200,credentialsFor(r,accessKey));}
  const reminder=rel.match(/^\/routes\/([^/]+)\/reminder-complete$/);if(reminder&&req.method==='POST'){const r=store.data.routes.find(x=>x.id===reminder[1]);if(!r)return json(res,404,{error:'not found'});r.reminderLastAt=new Date().toISOString();r.reminderNotifiedAt=null;store.audit('route.reminder_completed',ip(req),r.alias);return json(res,200,{ok:true,at:r.reminderLastAt});}
  const diag=rel.match(/^\/diagnostics\/([^/]+)$/);if(diag&&(req.method==='GET'||req.method==='POST')){const r=store.data.routes.find(x=>x.id===diag[1]);if(!r)return json(res,404,{error:'not found'});const result=await diagnoseRoute(r);store.audit('route.diagnosed',ip(req),r.alias);return json(res,200,result);}
  return json(res,404,{error:'not found'});
}

async function serveAdmin(req,res,prefix){try{const u=new URL(req.url,'http://admin.invalid');if(prefix!=='/'&&u.pathname===prefix&&req.method==='GET'){res.writeHead(308,headers({location:`${prefix}/`}));return res.end()}const rel=adminRelative(u.pathname,prefix);if(rel===null)return json(res,404,{error:'not found'});if(rel.startsWith('/api/'))return await api(req,res,rel.slice(4),prefix);if(req.method!=='GET')return json(res,405,{error:'method not allowed'});if(rel==='/app.js'){res.writeHead(200,headers({'content-type':'text/javascript; charset=utf-8'}));return res.end(appjs)}if(rel==='/style.css'){res.writeHead(200,headers({'content-type':'text/css; charset=utf-8'}));return res.end(stylesheet)}if(rel==='/help.css'){res.writeHead(200,headers({'content-type':'text/css; charset=utf-8'}));return res.end(helpStylesheet)}if(rel!=='/'&&rel!=='/index.html')return json(res,404,{error:'not found'});res.writeHead(200,headers({'content-type':'text/html; charset=utf-8'}));res.end(ui);}catch(e){json(res,e.status||400,{error:String(e.message||'request rejected').slice(0,160)});}}
const admin=http.createServer((req,res)=>serveAdmin(req,res,cfg.adminPath));
admin.requestTimeout=35_000;admin.headersTimeout=10_000;admin.listen(cfg.adminPort,cfg.adminHost,()=>console.log(`AegisRelay admin listening on http://${cfg.adminHost}:${cfg.adminPort}${cfg.adminPath}`));
const relay=makeProxyHandler(localAgent.routeSource,key,metrics);
const panelHostname=baseHostname(cfg.publicBaseUrl),proxyHostname=baseHostname(cfg.localProxyBaseUrl)||panelHostname,splitDomains=!!panelHostname&&!!proxyHostname&&panelHostname!==proxyHostname;
function requestHostname(req){try{return new URL(`http://${String(req.headers.host||'')}`).hostname.toLowerCase()}catch{return''}}
// A single bad request must never take the relay down mid-playback; nginx keeps serving, so do we.
function relayFailed(res,err){console.error('[aegis] relay error',err&&err.stack||err);if(res.headersSent||res.destroyed||res.writableEnded)return;try{res.writeHead(502,{'cache-control':'no-store'});res.end('bad gateway')}catch{}}
const proxy=http.createServer((req,res)=>{
  res.on('error',()=>{});
  let pathname; try{pathname=new URL(req.url,'http://relay.invalid').pathname}catch{return relayFailed(res,new Error('invalid request target'))}
  try{const role=domainRequestRole({panelHostname,proxyHostname,requestHostname:requestHostname(req)});if(role==='reject')return json(res,421,{error:'misdirected request'});if(role==='proxy'){const out=relay(req,res);if(out&&typeof out.catch==='function')out.catch(err=>relayFailed(res,err));return}if(pathname==='/agent-install.sh'&&req.method==='GET'){res.writeHead(200,headers({'content-type':'text/x-shellscript; charset=utf-8'}));return res.end(agentInstaller)}if(pathname==='/agent-upgrade.sh'&&req.method==='GET'){res.writeHead(200,headers({'content-type':'text/x-shellscript; charset=utf-8'}));return res.end(agentUpgrader)}const out=pathname.startsWith('/api/agent/v1/')?agentApi.handle(req,res):(isRootAdminRequest(pathname)?serveAdmin(req,res,'/'):(role==='control'?json(res,404,{error:'not found'}):relay(req,res)));if(out&&typeof out.catch==='function')out.catch(err=>relayFailed(res,err))}
  catch(err){relayFailed(res,err)}
});
proxy.requestTimeout=0;proxy.headersTimeout=15_000;
proxy.on('connection',socket=>socket.setNoDelay(true));
proxy.on('clientError',(err,socket)=>{if(!socket.destroyed)socket.destroy()});
proxy.on('upgrade',(req,socket,head)=>{socket.on('error',()=>socket.destroy());try{if(splitDomains&&requestHostname(req)!==proxyHostname)return socket.destroy();handleUpgrade(req,socket,head,localAgent.routeSource,key)}catch(err){console.error('[aegis] upgrade error',err&&err.stack||err);socket.destroy()}});
proxy.listen(cfg.proxyPort,cfg.proxyHost,()=>console.log(`AegisRelay proxy listening on ${cfg.proxyHost}:${cfg.proxyPort}`));
process.on('uncaughtException',err=>console.error('[aegis] uncaught exception',err&&err.stack||err));
process.on('unhandledRejection',err=>console.error('[aegis] unhandled rejection',err&&err.stack||err));
const flushTimer=setInterval(()=>store.save(),60_000);flushTimer.unref();
const reminderTimer=setInterval(()=>notifier.tick(store.data.routes),60*60_000);reminderTimer.unref();
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{clearInterval(flushTimer);clearInterval(reminderTimer);store.save();admin.close();proxy.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10_000).unref();});
