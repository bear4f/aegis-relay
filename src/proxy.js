import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import dnsPromises from 'node:dns/promises';
import { isPrivateIP } from './security.js';
import { isRouteAuthKey, verifyRouteToken } from './route-auth.js';
import { ThrottleTransform } from './metrics.js';
import { guardedLookup } from './lookup.js';

const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const RETRY_STATUS = new Set([502, 503, 504]);
const RELAY_REDIRECT_SEGMENT = '.aegis-relay';
const runtime = new Map();
let roundRobin = 0;

const strip = headers => Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k.toLowerCase()) && !['cookie2','x-forwarded-host'].includes(k.toLowerCase())));
const safeMethod = method => method === 'GET' || method === 'HEAD';
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const routesFrom = source => typeof source?.getRoutes==='function'?source.getRoutes():source?.data?.routes||[];

export function stripAdminCredentials(headers) {
  delete headers['x-csrf-token'];
  if (!headers.cookie) return headers;
  const cookies=String(headers.cookie).split(';').map(value=>value.trim()).filter(Boolean).filter(value=>!value.toLowerCase().startsWith('aegis_session='));
  if(cookies.length)headers.cookie=cookies.join('; ');else delete headers.cookie;
  return headers;
}

export function stripAdminSetCookies(headers) {
  const current=headers['set-cookie'];
  if(!current)return headers;
  const safe=(Array.isArray(current)?current:[current]).filter(value=>!/^\s*aegis_session=/i.test(String(value)));
  if(!safe.length)delete headers['set-cookie'];else headers['set-cookie']=safe;
  return headers;
}

export function parseUpstreamList(value) {
  const values = (Array.isArray(value) ? value : String(value || '').split(/[;\n]+/)).map(v => String(v).trim()).filter(Boolean);
  if (!values.length) throw new Error('at least one upstream is required');
  if (values.length > 8) throw new Error('a node supports at most 8 upstreams');
  return [...new Set(values)];
}

export async function validateUpstream(value, allowPrivate = false) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('upstream must be http(s) without credentials');
  if (u.search || u.hash) throw new Error('upstream must not include a query or fragment');
  const answers = await dnsPromises.lookup(u.hostname, { all: true });
  if (!answers.length) throw new Error('upstream DNS has no records');
  if (!allowPrivate && answers.some(a => isPrivateIP(a.address))) throw new Error('private, loopback and link-local upstreams are blocked');
  return u.toString().replace(/\/$/, '');
}

export async function validateUpstreamList(value, allowPrivate = false) {
  const list = parseUpstreamList(value), result = [];
  for (const item of list) result.push(await validateUpstream(item, allowPrivate));
  return result;
}

function normalizedUpstreams(route, playback = false) {
  if (playback && route.playbackUpstreams?.length) return route.playbackUpstreams;
  if (route.upstreams?.length) return route.upstreams;
  return route.upstream ? [route.upstream] : [];
}

function isPlaybackPath(pathname) {
  return /\/(?:emby\/)?(?:Videos|Audio|LiveTV)\//i.test(pathname) || /\/Items\/[^/]+\/Download/i.test(pathname);
}

function accessPrefix(route, suppliedKey = '') {
  return route.accessMode === 'alias_only' ? `/${route.alias}` : `/${route.alias}/${suppliedKey}`;
}

function routeFor(req, routes, key) {
  const parts = new URL(req.url, 'http://relay.invalid').pathname.split('/').filter(Boolean);
  const offset = parts[0] === 'r' ? 1 : 0;
  const route = routes.find(r => r.enabled && r.alias === parts[offset]);
  if (!route) return null;
  if (route.accessMode === 'alias_only') return { route, rest:`/${parts.slice(offset + 1).join('/')}`, suppliedKey:'', prefix:accessPrefix(route) };
  if (parts.length <= offset + 1 || !verifyRouteToken(route, parts[offset + 1], key)) return null;
  const suppliedKey = parts[offset + 1];
  return { route, rest:`/${parts.slice(offset + 2).join('/')}`, suppliedKey, prefix:accessPrefix(route, suppliedKey) };
}

function stateKey(route, target) { return `${route.id || route.alias}\0${target}`; }
function stateFor(route, target) {
  const k = stateKey(route, target);
  if (!runtime.has(k)) runtime.set(k, { failures:0, openUntil:0, lastError:'', lastSuccess:null });
  return runtime.get(k);
}
function markSuccess(route, target) { const s=stateFor(route,target); s.failures=0; s.openUntil=0; s.lastError=''; s.lastSuccess=new Date().toISOString(); }
function markFailure(route, target, reason) {
  // Only trip after several consecutive genuine upstream failures. A short fuse used to open the
  // circuit on transient blips and then serve 502s to healthy nodes, which read as instability.
  const s=stateFor(route,target); s.failures++; s.lastError=String(reason || 'request failed').slice(0,120);
  if (s.failures >= 4) s.openUntil=Date.now() + Math.min(120_000, 10_000 * 2 ** Math.min(s.failures - 4, 4));
}
// Writing to a response the client already dropped throws and would take the process down.
function failResponse(res, status, body) {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  try { res.writeHead(status,{'cache-control':'no-store','content-type':'text/plain; charset=utf-8'}); res.end(body); } catch {}
}
function safeUpstreamError(error) {
  const code=String(error?.code||''),message=String(error?.message||'').toLowerCase();
  if(code==='ECONNREFUSED')return'上游拒绝连接，请检查地址、端口和防火墙';
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')return'上游域名解析失败';
  if(code==='ETIMEDOUT'||message.includes('timeout'))return'上游连接超时';
  if(code==='ECONNRESET'||message.includes('socket hang up'))return'上游提前断开连接';
  if(code.includes('CERT')||message.includes('certificate')||message.includes('self-signed'))return'上游 TLS 证书验证失败';
  if(code==='EPROTO'||message.includes('wrong version number')||message.includes('ssl routines'))return'上游协议不匹配，请检查 HTTP/HTTPS';
  return'上游连接失败';
}
function orderedTargets(route, playback) {
  const all=normalizedUpstreams(route,playback), available=all.filter(t=>stateFor(route,t).openUntil<=Date.now()), pool=available.length?available:all;
  if (!pool.length) return [];
  const start=roundRobin++%pool.length; return [...pool.slice(start),...pool.slice(0,start)];
}

export function getRuntimeStatus(routes) {
  return routes.map(route => ({ id:route.id, alias:route.alias, upstreams:[...normalizedUpstreams(route),...normalizedUpstreams(route,true).filter(x=>!normalizedUpstreams(route).includes(x))].map(target=>{
    const s=stateFor(route,target); return { target:'[encrypted upstream]', failures:s.failures, circuitOpen:s.openUntil>Date.now(), retryAt:s.openUntil?new Date(s.openUntil).toISOString():null, lastSuccess:s.lastSuccess, lastError:s.lastError };
  }) }));
}

function applyClientProfile(headers, profile = {}) {
  const mapping = { userAgent:'user-agent', client:'x-emby-client', deviceName:'x-emby-device-name', deviceId:'x-emby-device-id' };
  if (profile.enabled !== true) return;
  for (const [field,header] of Object.entries(mapping)) if (profile[field]) headers[header]=profile[field];
}

function publicIndex(routes) {
  const visible=routes.filter(r=>r.enabled&&r.showOnHome);
  const cards=visible.map(r=>`<li><strong>${escapeHtml(r.name||r.alias)}</strong><code>/${escapeHtml(r.alias)}/${r.accessMode==='alias_only'?'':'••••••/'}</code><span>${r.accessMode==='alias_only'?'公开别名':'需要访问密钥'}</span></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>AegisRelay 节点</title><style>body{max-width:720px;margin:60px auto;padding:0 20px;background:#08111e;color:#e8eef8;font:16px system-ui}h1{color:#54d1b2}ul{padding:0}li{list-style:none;border:1px solid #24344b;border-radius:12px;padding:18px;margin:12px 0;background:#111d2e}strong,code,span{display:block;margin:5px 0}code{color:#54d1b2}span{color:#91a0b7;font-size:13px}</style><h1>AegisRelay</h1><p>可用 Emby 节点</p><ul>${cards||'<li>暂无公开展示的节点</li>'}</ul></html>`;
}

function joinTarget(target, rest, search) {
  const base=new URL(target), left=base.pathname.replace(/\/$/,''), right=rest.startsWith('/')?rest:`/${rest}`;
  base.pathname=`${left}${right}`.replace(/\/{2,}/g,'/'); base.search=search; return base;
}

function externalRedirectPath(location, base) {
  const basePath=base.pathname.replace(/\/$/,'');
  if(basePath&&basePath!=='/'&&(location.pathname===basePath||location.pathname.startsWith(`${basePath}/`))){
    return location.pathname.slice(basePath.length)||'/';
  }
  if(!basePath||basePath==='/')return location.pathname;
  return null;
}

function redirectSecret(route, appKey) {
  if(isRouteAuthKey(route.routeAuthKey))return Buffer.from(route.routeAuthKey,'base64url');
  if(Buffer.isBuffer(appKey)&&appKey.length===32)return appKey;
  throw new Error('redirect relay key unavailable');
}

function redirectAad(route) {
  return Buffer.from(`AegisRelay:redirect:v1:${route.id||route.alias}`,'utf8');
}

function sealRedirectTarget(route, target, appKey, playback) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',redirectSecret(route,appKey),iv);
  cipher.setAAD(redirectAad(route));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify({target:target.href,playback:playback===true}),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}

function openRedirectTarget(route, token, appKey) {
  const payload=Buffer.from(String(token||''),'base64url');
  if(payload.length<29||payload.toString('base64url')!==token)throw new Error('invalid redirect relay token');
  const decipher=crypto.createDecipheriv('aes-256-gcm',redirectSecret(route,appKey),payload.subarray(0,12));
  decipher.setAAD(redirectAad(route));decipher.setAuthTag(payload.subarray(12,28));
  const decoded=JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)),decipher.final()]).toString('utf8'));
  const target=new URL(decoded.target);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('invalid redirect relay target');
  return {target,playback:decoded.playback===true};
}

function continuationTarget(found, appKey) {
  const parts=found.rest.split('/').filter(Boolean);
  if(parts[0]!==RELAY_REDIRECT_SEGMENT)return null;
  if(parts.length!==2)throw new Error('invalid redirect relay path');
  return openRedirectTarget(found.route,parts[1],appKey);
}

function publicRelayLocation(found, target, context, appKey, playback) {
  const token=sealRedirectTarget(found.route,target,appKey,playback),path=`${found.prefix}/${RELAY_REDIRECT_SEGMENT}/${token}`;
  return context.host?`${context.proto}://${context.host}${path}`:path;
}

function publicRequestContext(req) {
  const host=String(req.headers.host||'').trim();
  const forwarded=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase();
  const proto=forwarded==='https'||forwarded==='http'?forwarded:(req.socket.encrypted?'https':'http');
  return {host,proto};
}

function cleanResponseHeaders(input) {
  const out=strip(input); delete out.server; delete out.via; delete out['x-powered-by'];
  stripAdminSetCookies(out);out['referrer-policy']='no-referrer'; out['x-content-type-options']='nosniff'; return out;
}

export function makeProxyHandler(routeSource, key, metrics = null) {
  return async (req, res) => {
    const incoming=new URL(req.url,'http://relay.invalid');
    if (req.method==='GET' && (incoming.pathname==='/' || incoming.pathname==='/index.html' || incoming.pathname==='/gateway' || incoming.pathname==='/gateway/')) {
      res.writeHead(200, { 'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
      return res.end(publicIndex(routesFrom(routeSource)));
    }
    const found=routeFor(req,routesFrom(routeSource),key);
    if (!found) { res.writeHead(404,{'cache-control':'no-store'}); return res.end('not found'); }
    let continuation;
    try { continuation=continuationTarget(found,key); }
    catch { res.writeHead(404,{'cache-control':'no-store'});return res.end('not found'); }
    const {route}=found, playback=continuation?.playback===true||isPlaybackPath(found.rest), configured=continuation?[continuation.target.href]:orderedTargets(route,playback);
    if(metrics&&!metrics.canServe(route)){res.writeHead(509,{'cache-control':'no-store','retry-after':'3600'});return res.end('monthly traffic quota exceeded');}
    const metricDone=metrics?.begin(route,{playback,bytesIn:Number(req.headers['content-length']||0)});
    if (!configured.length) { metricDone?.(502,0,true);res.writeHead(502,{'cache-control':'no-store'}); return res.end('no upstream available'); }
    // Mirror the proven Nginx gateway: advertise the public host/scheme so the upstream builds
    // correct redirects, but strip the client IP for privacy.
    const publicContext=publicRequestContext(req);
    const originalHeaders=stripAdminCredentials(strip(req.headers));
    delete originalHeaders['x-forwarded-for']; delete originalHeaders.forwarded; delete originalHeaders['x-real-ip'];
    if(publicContext.host)originalHeaders['x-forwarded-host']=publicContext.host;
    originalHeaders['x-forwarded-proto']=publicContext.proto;
    applyClientProfile(originalHeaders,route.clientProfile);
    const canRetry=safeMethod(req.method); let finished=false, clientGone=false, activeUp=null;
    // Emby clients abort constantly (seeking, stopping, backgrounding). Nginx tears the upstream
    // down with the client; without this the upstream kept streaming into a dead socket and leaked
    // sockets and memory until the process fell over.
    const releaseClient=()=>{ if(clientGone||res.writableFinished)return; clientGone=true; if(activeUp&&!activeUp.destroyed)activeUp.destroy(); };
    res.on('close',releaseClient);
    res.on('error',()=>{});
    req.on('error',()=>{});

    const routeOrigins=new Set([...normalizedUpstreams(route),...normalizedUpstreams(route,true)].map(value=>{try{return new URL(value).origin}catch{return''}}).filter(Boolean));
    const attempt=(targetValue,index)=>{
      if (finished || clientGone) return;
      const target=continuation&&index===0?continuation.target:joinTarget(targetValue,found.rest,incoming.search), base=new URL(targetValue), requestHeaders={...originalHeaders};
      requestHeaders.host=target.host;
      if (!routeOrigins.has(target.origin)) { delete requestHeaders.authorization; delete requestHeaders.cookie; delete requestHeaders['x-emby-token']; }
      const options={protocol:target.protocol,hostname:target.hostname,port:target.port,method:req.method,path:target.pathname+target.search,headers:requestHeaders,servername:target.hostname,rejectUnauthorized:route.tlsVerify!==false,lookup:guardedLookup(route.allowPrivate)};
      // Short guard for the TCP connect only; once connected, allow a long idle window so slow
      // transcode starts and paused streams are not killed (Nginx uses proxy_read_timeout 3600s).
      const up=(target.protocol==='https:'?https:http).request(options,upRes=>{
        clearTimeout(connectTimer);
        const status=upRes.statusCode||502;
        if (canRetry && RETRY_STATUS.has(status) && index+1<configured.length) { markFailure(route,targetValue,`HTTP ${status}`); upRes.resume(); return attempt(configured[index+1],index+1); }
        if(RETRY_STATUS.has(status))markFailure(route,targetValue,`HTTP ${status}`);else markSuccess(route,targetValue); const out=cleanResponseHeaders(upRes.headers);
        if (out.location) {
          try {
            const loc=new URL(out.location,target);
            if(!['http:','https:'].includes(loc.protocol)||loc.username||loc.password)delete out.location;
            else if(!continuation&&loc.origin===base.origin){
              const redirectedPath=externalRedirectPath(loc,base);
              // Keep ordinary login/navigation redirects readable. A redirect outside the configured
              // upstream base is wrapped below so the client must return through this relay.
              out.location=redirectedPath===null?publicRelayLocation(found,loc,publicContext,key,playback):(publicContext.host?`${publicContext.proto}://${publicContext.host}${found.prefix}${redirectedPath}${loc.search}${loc.hash}`:`${found.prefix}${redirectedPath}${loc.search}${loc.hash}`);
            }
            else out.location=publicRelayLocation(found,loc,publicContext,key,playback);
          }
          catch { delete out.location; }
        }
        finished=true;
        if (res.destroyed || res.headersSent) { up.destroy(); metricDone?.(status,0,false); return; }
        const speed=Number(route.speedLimitMbps||0),counter=new ThrottleTransform(speed>0?speed*1024*1024/8:0);
        let measured=false;const finishMetric=()=>{if(measured)return;measured=true;metricDone?.(status,counter.bytes,status>=500)};
        res.writeHead(status,out);
        // pipeline (unlike .pipe) tears every stream down on failure and never leaves a dangling
        // half-open response, so a broken client or upstream cannot strand sockets.
        pipeline(upRes,counter,res,()=>{ if(!up.destroyed)up.destroy(); finishMetric(); });
      });
      activeUp=up;
      const connectTimer=setTimeout(()=>up.destroy(new Error('connect timeout')),20_000);
      up.on('socket',s=>{if(s.connecting)s.once('connect',()=>clearTimeout(connectTimer));else clearTimeout(connectTimer)});
      up.setTimeout(3600_000,()=>up.destroy(new Error('upstream idle timeout')));
      up.on('error',err=>{
        clearTimeout(connectTimer);
        // A client that walked away is not an upstream fault; counting it opened circuits on
        // perfectly healthy nodes and produced sporadic 502s mid-session.
        if (clientGone) { if(!finished){finished=true;metricDone?.(499,0,false);} return; }
        const reason=safeUpstreamError(err);markFailure(route,targetValue,reason);
        if (canRetry && index+1<configured.length) return attempt(configured[index+1],index+1);
        if (!finished) { finished=true;metricDone?.(502,0,true);failResponse(res,502,`Bad Gateway\n${reason}`); }
      });
      if (canRetry) up.end(); else pipeline(req,up,()=>{});
    };
    attempt(configured[0],0);
  };
}

export function handleUpgrade(req, socket, head, routeSource, key) {
  const found=routeFor(req,routesFrom(routeSource),key); if(!found)return socket.destroy();
  const targets=orderedTargets(found.route,false); if(!targets.length)return socket.destroy();
  const target=joinTarget(targets[0],found.rest,new URL(req.url,'http://relay.invalid').search), publicContext=publicRequestContext(req), headers=stripAdminCredentials(strip(req.headers));
  delete headers['x-forwarded-for']; delete headers.forwarded; delete headers['x-real-ip']; applyClientProfile(headers,found.route.clientProfile);
  if(publicContext.host)headers['x-forwarded-host']=publicContext.host; headers['x-forwarded-proto']=publicContext.proto;
  headers.host=target.host; headers.connection='Upgrade'; headers.upgrade=req.headers.upgrade;
  const transport=target.protocol==='https:'?https:http;
  const up=transport.request({protocol:target.protocol,hostname:target.hostname,port:target.port,path:target.pathname+target.search,headers,servername:target.hostname,rejectUnauthorized:found.route.tlsVerify!==false,lookup:guardedLookup(found.route.allowPrivate)});
  // Unhandled socket errors on either leg would surface as an uncaught exception and restart the
  // whole relay, and a client that vanished used to leave the upstream socket open forever.
  let clientGone=false;
  socket.on('error',()=>socket.destroy());
  socket.on('close',()=>{clientGone=true;if(!up.destroyed)up.destroy()});
  up.on('upgrade',(r,s,h)=>{
    markSuccess(found.route,targets[0]);
    s.on('error',()=>s.destroy());
    if(clientGone||socket.destroyed)return s.destroy();
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if(h.length)socket.write(h);if(head.length)s.write(head);
    s.pipe(socket);socket.pipe(s);
  });
  up.on('error',err=>{if(!clientGone)markFailure(found.route,targets[0],err.message);socket.destroy()});up.end();
}
