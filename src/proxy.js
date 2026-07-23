import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline, Readable } from 'node:stream';
import dnsPromises from 'node:dns/promises';
import { isPrivateIP } from './security.js';
import { isRouteAuthKey, verifyRouteToken } from './route-auth.js';
import { ThrottleTransform } from './metrics.js';
import { guardedLookup } from './lookup.js';

const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const RETRY_STATUS = new Set([502, 503, 504]);
const RELAY_REDIRECT_SEGMENT = '.aegis-relay';
// Front/back-split Emby servers hand the client a stream URL on a *different* domain than the one it
// logged in through. We rewrite those absolute URLs in text/API responses to route through this
// relay under a dedicated path so the client never leaves our domain, and proxy the path back to the
// real stream domain. Only operator-declared stream hosts are ever reachable through it (SSRF guard).
const RELAY_VOD_SEGMENT = '.aegis-vod';
// Cap on how much of a "text" response we buffer to rewrite. Emby API/manifest bodies are tiny; video
// is never a rewritable content-type. Past the cap we stop buffering and stream the rest untouched so
// a mislabeled huge body can never blow up memory.
const STREAM_REWRITE_CAP = 16 * 1024 * 1024;
const runtime = new Map();
// Reuse warm upstream connections. Every seek is a fresh Range request, and opening a new TCP+TLS
// connection to a distant origin each time added seconds of buffering before the first byte.
const AGENT_OPTIONS = { keepAlive:true, keepAliveMsecs:30_000, maxSockets:256, maxFreeSockets:32, timeout:75_000, scheduling:'lifo' };
const httpAgent = new http.Agent(AGENT_OPTIONS);
const httpsAgent = new https.Agent(AGENT_OPTIONS);

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

function normalizedUpstreams(route) {
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
// Circuit state would otherwise outlive its route forever: every delete or upstream edit left an
// orphan entry in the map for the lifetime of the process.
export function dropRouteRuntime(routeId) {
  const prefix = `${routeId}\0`;
  for (const key of runtime.keys()) if (key.startsWith(prefix)) runtime.delete(key);
}
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
function orderedTargets(route) {
  // Deterministic order — always prefer the primary line. Rotating upstreams per request sent a
  // client's seeks to a different Emby server than the one holding its playback/transcode session,
  // which showed up as long buffering and dropped streams. Extra lines are failover, not balancing.
  const all=normalizedUpstreams(route);
  if (!all.length) return [];
  const available=all.filter(t=>stateFor(route,t).openUntil<=Date.now());
  return available.length?available:all;
}

export function getRuntimeStatus(routes) {
  return routes.map(route => ({ id:route.id, alias:route.alias, upstreams:normalizedUpstreams(route).map(target=>{
    const s=stateFor(route,target); return { target:'[encrypted upstream]', failures:s.failures, circuitOpen:s.openUntil>Date.now(), retryAt:s.openUntil?new Date(s.openUntil).toISOString():null, lastSuccess:s.lastSuccess, lastError:s.lastError };
  }) }));
}

// Optional client-compatibility hint for upstreams you own or are authorized to proxy. This only
// sets the declared X-Emby-* hint headers when the operator enables the profile; it deliberately
// never rewrites the MediaBrowser auth header, the tokens, or the identity carried in query params.
// Rewriting the authenticated Client/Device/Version desynchronizes the request from Emby's
// token/session binding, which is exactly what broke playback on servers running device-management
// or anti-proxy plugins — so the authenticated identity and tokens are always left untouched.
function applyClientProfile(headers, profile = {}) {
  if (!profile || profile.enabled !== true) return;
  const mapping = { userAgent:'user-agent', client:'x-emby-client', deviceName:'x-emby-device-name', deviceId:'x-emby-device-id' };
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

// Operator-declared backend stream hosts for this node (host or host:port), only when the feature is
// enabled. These are the sole domains the /.aegis-vod/ path may reach and the only ones we rewrite.
function streamRewriteDomains(route) {
  const sr=route&&route.streamRewrite;
  if(!sr||sr.enabled!==true||!Array.isArray(sr.domains))return [];
  return sr.domains.map(d=>String(d||'').trim().toLowerCase()).filter(Boolean);
}
// Resolve a /.aegis-vod/<scheme>/<host>/<rest> request back to the real stream domain. The scheme is
// the upstream transport (http|https) and the host must be one the operator declared for this node —
// anything else is rejected so the path can't be turned into an open proxy. Returns null when the
// request is not a stream-relay path.
function vodTarget(found, search) {
  const rest=found.rest||'', marker=`/${RELAY_VOD_SEGMENT}/`;
  if(!rest.startsWith(marker))return null;
  const allowed=streamRewriteDomains(found.route);
  if(!allowed.length)throw new Error('stream rewrite disabled');
  const seg=rest.slice(marker.length).split('/');
  const scheme=(seg[0]||'').toLowerCase(), token=(seg[1]||'').toLowerCase(), name=token.split(':')[0];
  if(scheme!=='http'&&scheme!=='https')throw new Error('invalid stream scheme');
  if(!token||!(allowed.includes(token)||allowed.includes(name)))throw new Error('stream host not allowed');
  const target=new URL(`${scheme}://${token}`);
  if(target.username||target.password||target.pathname!=='/'||target.hostname!==name)throw new Error('invalid stream host');
  target.pathname='/'+seg.slice(2).join('/'); target.search=search||'';
  return {target,token};
}
// A text/manifest rewriter that turns absolute stream-domain URLs into paths on this relay, or null
// when the feature is off or the public host is unknown. Scheme-qualified and boundary-guarded so a
// declared host is never matched as a suffix of a lookalike domain (e.g. vod.example inside
// vod.example.evil). The upstream scheme is preserved in the path; ws/wss map to the relay's own
// websocket scheme so live sockets stay on our domain too.
function buildStreamRewriter(route, publicContext, prefix) {
  const domains=streamRewriteDomains(route);
  if(!domains.length||!publicContext.host)return null;
  const base=`${publicContext.proto}://${publicContext.host}${prefix}/${RELAY_VOD_SEGMENT}/`;
  const wsBase=`${publicContext.proto==='https'?'wss':'ws'}://${publicContext.host}${prefix}/${RELAY_VOD_SEGMENT}/`;
  const alt=domains.map(d=>d.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const re=new RegExp('(https?|wss?):\\/\\/('+alt+')(:\\d+)?(?=[/"\'?#\\\\]|$)','gi');
  return text=>text.replace(re,(m,scheme,host,port)=>{
    const s=scheme.toLowerCase(), secure=s==='https'||s==='wss', ws=s==='ws'||s==='wss';
    return (ws?wsBase:base)+(secure?'https':'http')+'/'+host+(port||'');
  });
}
// Stream the already-buffered head, then the remainder of the source, as one readable — used only
// when a text body overran the rewrite cap and must be delivered untouched without re-buffering.
function chainStream(chunks, tail) {
  return Readable.from((async function*(){ for(const c of chunks) yield c; for await(const c of tail) yield c; })());
}
function isRewritableType(contentType) {
  const ct=String(contentType||'').toLowerCase();
  return /^text\//.test(ct) || /(json|xml|javascript|ecmascript|mpegurl|dash\+xml)/.test(ct);
}
// Decode a (small) rewritable body so its embedded URLs can be rewritten. We no longer force the
// upstream to skip compression — that would bloat every response — so the few bodies we do rewrite
// may arrive compressed and are decompressed here. Throws on an encoding we can't handle so the
// caller can fall back to passing the original bytes through untouched.
function decodeBody(buf, encoding) {
  const e=String(encoding||'').toLowerCase();
  if(!e||e==='identity')return buf;
  if(e==='gzip'||e==='x-gzip')return zlib.gunzipSync(buf);
  if(e==='deflate')return zlib.inflateSync(buf);
  if(e==='br')return zlib.brotliDecompressSync(buf);
  throw new Error('unsupported content-encoding');
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
    let continuation, vod;
    try { continuation=continuationTarget(found,key); vod=vodTarget(found,incoming.search); }
    catch { res.writeHead(404,{'cache-control':'no-store'});return res.end('not found'); }
    const {route}=found, playback=continuation?.playback===true||!!vod||isPlaybackPath(found.rest);
    const configured=continuation?[continuation.target.href]:vod?[vod.target.href]:orderedTargets(route);
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
    // Apply the optional client-compat header hint (owned/authorized upstreams only). Query string
    // is relayed verbatim — we never rewrite the authenticated identity or tokens.
    applyClientProfile(originalHeaders,route.clientProfile);
    // Prepared only when the node opts into stream-URL rewriting; null (no effect) otherwise. We do
    // NOT touch Accept-Encoding here — the media path and every non-rewritten response keep their
    // normal compression, so playback speed on a rewrite-enabled node matches one without it.
    const rewriter=buildStreamRewriter(route,publicContext,found.prefix);
    const relaySearch=incoming.search;
    const canRetry=safeMethod(req.method); let finished=false, clientGone=false, activeUp=null;
    // Emby clients abort constantly (seeking, stopping, backgrounding). Nginx tears the upstream
    // down with the client; without this the upstream kept streaming into a dead socket and leaked
    // sockets and memory until the process fell over.
    const releaseClient=()=>{ if(clientGone||res.writableFinished)return; clientGone=true; if(activeUp&&!activeUp.destroyed)activeUp.destroy(); };
    res.on('close',releaseClient);
    res.on('error',()=>{});
    req.on('error',()=>{});

    // Declared stream hosts are trusted parts of the same deployment, so keep credentials flowing to
    // them just like the configured upstreams (the /.aegis-vod/ proxy target lives on one of these).
    const routeOrigins=new Set([...normalizedUpstreams(route),...streamRewriteDomains(route).flatMap(h=>[`https://${h}`,`http://${h}`])].map(value=>{try{return new URL(value).origin}catch{return''}}).filter(Boolean));
    const attempt=(targetValue,index,freshSocket=false)=>{
      if (finished || clientGone) return;
      const directTarget=(continuation&&index===0&&continuation.target)||(vod&&index===0&&vod.target)||null;
      const target=directTarget||joinTarget(targetValue,found.rest,relaySearch), base=new URL(targetValue), requestHeaders={...originalHeaders};
      requestHeaders.host=target.host;
      if (!routeOrigins.has(target.origin)) { delete requestHeaders.authorization; delete requestHeaders.cookie; delete requestHeaders['x-emby-token']; }
      const secure=target.protocol==='https:';
      const options={protocol:target.protocol,hostname:target.hostname,port:target.port,method:req.method,path:target.pathname+target.search,headers:requestHeaders,servername:target.hostname,rejectUnauthorized:route.tlsVerify!==false,lookup:guardedLookup(route.allowPrivate),agent:freshSocket?false:(secure?httpsAgent:httpAgent)};
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
            else if(!continuation&&!vod&&loc.origin===base.origin){
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
        const speed=Number(route.speedLimitMbps||0);
        let measured=false,streamed=0;
        const finishMetric=()=>{if(measured)return;measured=true;metricDone?.(status,metricDone?.addBytes?0:streamed,status>=500)};
        // pipeline (unlike .pipe) tears every stream down on failure and never leaves a dangling
        // half-open response. Only tear the socket down on failure; a cleanly finished response
        // returns to the pool so the next Range request (a seek) skips the TCP+TLS handshake.
        const deliver=source=>{
          res.writeHead(status,out);
          const done=err=>{ if(err&&!up.destroyed)up.destroy(); finishMetric(); };
          if(speed>0){
            const counter=new ThrottleTransform(speed*1024*1024/8,bytes=>{streamed+=bytes;metricDone?.addBytes?.(bytes)});
            pipeline(source,counter,res,done);
          }else{
            // No rate limit means no transform. A Transform defaults to a 16 KiB high water mark, so
            // parking one in front of every response throttled full-speed playback to that buffer and
            // added a pause/resume cycle per chunk. Count bytes with a listener instead.
            source.on('data',chunk=>{streamed+=chunk.length;metricDone?.addBytes?.(chunk.length)});
            pipeline(source,res,done);
          }
        };
        // The stream-URL rewrite only applies to small text/manifest/API bodies. Media — any Range
        // request, a 206 Partial Content, a HEAD, or a bodyless status — is never buffered or
        // altered, so playback start, throughput and seeking stay identical to a node with no
        // rewriting. Compressed rewritable bodies are decoded (not forced off upstream-wide).
        const enc=String(out['content-encoding']||'').toLowerCase();
        const decodable=!enc||['identity','gzip','x-gzip','deflate','br'].includes(enc);
        const mediaResponse=!!req.headers.range||req.method==='HEAD'||status===206||status===204||status===304;
        if (rewriter && !mediaResponse && decodable && isRewritableType(out['content-type'])) {
          // Buffer the (small) body, rewrite embedded stream URLs, then deliver. Length changes, so
          // drop the upstream content-length and the (now removed) encoding and let it chunk.
          const chunks=[]; let size=0;
          const onData=chunk=>{
            chunks.push(chunk); size+=chunk.length;
            if(size>STREAM_REWRITE_CAP){ upRes.pause(); upRes.off('data',onData); upRes.off('end',onEnd); delete out['content-length']; deliver(chainStream(chunks,upRes)); }
          };
          const onEnd=()=>{
            let text;
            try{ text=decodeBody(Buffer.concat(chunks,size),enc).toString('utf8'); }
            catch{ deliver(Readable.from(chunks)); return; } // undecodable — pass the original bytes through untouched
            const outBuf=Buffer.from(rewriter(text),'utf8');
            delete out['content-encoding']; out['content-length']=String(outBuf.length);
            deliver(Readable.from([outBuf]));
          };
          upRes.on('data',onData); upRes.on('end',onEnd);
          upRes.on('error',()=>{ if(!up.destroyed)up.destroy(); finishMetric(); });
        } else deliver(upRes);
      });
      activeUp=up;
      const connectTimer=setTimeout(()=>up.destroy(new Error('connect timeout')),20_000);
      up.on('socket',s=>{s.setNoDelay(true);if(s.connecting)s.once('connect',()=>clearTimeout(connectTimer));else clearTimeout(connectTimer)});
      up.setTimeout(3600_000,()=>up.destroy(new Error('upstream idle timeout')));
      up.on('error',err=>{
        clearTimeout(connectTimer);
        // A client that walked away is not an upstream fault; counting it opened circuits on
        // perfectly healthy nodes and produced sporadic 502s mid-session.
        if (clientGone) { if(!finished){finished=true;metricDone?.(499,0,false);} return; }
        // A pooled connection the origin had already closed dies on reuse. Retry the same upstream
        // once on a brand-new socket before treating it as a real failure.
        const staleSocket=!freshSocket&&!finished&&canRetry&&!res.headersSent;
        if (staleSocket) return attempt(targetValue,index,true);
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
  const relaySearch=new URL(req.url,'http://relay.invalid').search;
  // A rewritten live socket (wss://…/.aegis-vod/<host>/…) tunnels straight to the declared stream
  // host; otherwise use the node's primary upstream. An unknown/blocked stream host is dropped.
  let vod; try { vod=vodTarget(found,relaySearch); } catch { return socket.destroy(); }
  const targets=vod?[vod.target.href]:orderedTargets(found.route); if(!targets.length)return socket.destroy();
  const target=vod?vod.target:joinTarget(targets[0],found.rest,relaySearch), publicContext=publicRequestContext(req), headers=stripAdminCredentials(strip(req.headers));
  delete headers['x-forwarded-for']; delete headers.forwarded; delete headers['x-real-ip']; applyClientProfile(headers,found.route.clientProfile);
  if(publicContext.host)headers['x-forwarded-host']=publicContext.host; headers['x-forwarded-proto']=publicContext.proto;
  headers.host=target.host; headers.connection='Upgrade'; headers.upgrade=req.headers.upgrade;
  const transport=target.protocol==='https:'?https:http;
  // agent:false — an upgraded socket is hijacked for the WebSocket and must never return to a pool.
  const up=transport.request({protocol:target.protocol,hostname:target.hostname,port:target.port,path:target.pathname+target.search,headers,servername:target.hostname,rejectUnauthorized:found.route.tlsVerify!==false,lookup:guardedLookup(found.route.allowPrivate),agent:false});
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
