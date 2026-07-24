import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import dnsPromises from 'node:dns/promises';
import { isPrivateIP } from './security.js';
import { isRouteAuthKey, matchRouteChannel, verifyRouteToken } from './route-auth.js';
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
const runtime = new Map();
// A larger socket backpressure window avoids repeatedly stopping the zero-copy pipeline after only
// a few small chunks on high-bandwidth/high-latency routes. It is a threshold (allocated on demand),
// not a per-connection reservation, and stays deliberately bounded for small VPSes.
export const RELAY_HIGH_WATER_MARK=256*1024;
export const RELAY_SERVER_OPTIONS=Object.freeze({highWaterMark:RELAY_HIGH_WATER_MARK,noDelay:true,keepAlive:true,keepAliveInitialDelay:15_000});
// Two warm pools, so playback and control never poison each other's sockets. API/control traffic is
// short and bursty; media bodies, HLS segments and Range seeks are long. Fresh sockets are murder on
// startup and seek latency because every one repays TCP slow-start from a tiny congestion window
// ("shows a few dozen KiB and can't ramp up"), so media keeps its own keep-alive pool to stay warm.
// The invisible byte-resume net below opens a one-shot socket the moment a reused connection stalls,
// so the specific frontends/CDNs that deliver only a few KiB on a re-used socket still recover cleanly
// — pooling gives the fast warm-window path without ever trapping playback on a misbehaving origin.
const API_AGENT_OPTIONS = { keepAlive:true, keepAliveMsecs:15_000, maxSockets:512, maxFreeSockets:64, maxTotalSockets:1024, timeout:75_000, scheduling:'lifo', highWaterMark:RELAY_HIGH_WATER_MARK };
const MEDIA_AGENT_OPTIONS = { keepAlive:true, keepAliveMsecs:30_000, maxSockets:256, maxFreeSockets:48, maxTotalSockets:512, timeout:75_000, scheduling:'lifo', highWaterMark:RELAY_HIGH_WATER_MARK };
const httpAgent = new http.Agent(API_AGENT_OPTIONS);
const httpsAgent = new https.Agent(API_AGENT_OPTIONS);
const httpMediaAgent = new http.Agent(MEDIA_AGENT_OPTIONS);
const httpsMediaAgent = new https.Agent(MEDIA_AGENT_OPTIONS);
// Clean media sockets still resume the cached TLS session, avoiding a full handshake without
// reintroducing unsafe HTTP connection reuse. API traffic and every completed HTTPS media request
// feed this cache.
const TLS_SESSION_MAX=1024;
const tlsSessions=new Map();
function tlsSessionKey(target){ return `${target.hostname}\0${target.port||'443'}`; }
function rememberTlsSession(key,session){ if(!key||!session)return; tlsSessions.delete(key); tlsSessions.set(key,session); if(tlsSessions.size>TLS_SESSION_MAX)tlsSessions.delete(tlsSessions.keys().next().value); }
export function clearTlsSessions(){ tlsSessions.clear(); }
// Who is using a node — for the operator to spot a relay that has been redistributed. The real client
// IP comes from the X-Real-IP the fronting Nginx sets (the relay strips it before going upstream, so
// the upstream never sees it); the device fields come from the Emby headers / auth line / query.
const clipText=(v,n=80)=>String(v||'').replace(/[\r\n\0]/g,'').trim().slice(0,n);
const firstForwarded=v=>String(v||'').split(',')[0].trim();
function hasViewerIdentity(req,incoming){ const h=req.headers,q=incoming.searchParams; return !!(h['x-emby-authorization']||h['x-emby-token']||h.authorization||q.get('api_key')||q.get('X-Emby-Token')||q.get('X-MediaBrowser-Token')); }
function accessInfoFrom(req,incoming){
  const h=req.headers;
  const ip=firstForwarded(h['x-real-ip'])||firstForwarded(h['x-forwarded-for'])||String(req.socket?.remoteAddress||'').replace(/^::ffff:/,'');
  if(!ip)return null;
  const auth=String(h['x-emby-authorization']||h.authorization||''),q=incoming.searchParams;
  const field=re=>{const m=auth.match(re);return m?m[1]:'';};
  return { ip:clipText(ip,45),
    deviceName:clipText(h['x-emby-device-name']||field(/Device="([^"]*)"/i)||q.get('X-Emby-Device-Name')||''),
    client:clipText(h['x-emby-client']||field(/Client="([^"]*)"/i)||q.get('X-Emby-Client')||''),
    deviceId:clipText(h['x-emby-device-id']||field(/DeviceId="([^"]*)"/i)||q.get('X-Emby-Device-Id')||q.get('DeviceId')||''),
    ua:clipText(h['user-agent']||'',160) };
}
const CONNECT_TIMEOUT_MS=10_000;
const RESPONSE_HEADER_TIMEOUT_MS=60_000;
const FAILOVER_HEADER_TIMEOUT_MS=15_000;
const PLAYBACK_HEADER_TIMEOUT_MS=45_000;
// Byte-addressable media can be resumed safely. Do not leave the player frozen for the previous
// 30-second window after an origin has stopped producing bytes — but on-the-fly transcode legitimately
// pauses for several seconds while it renders ahead, so the watchdog must be slower than a transcode
// gap or it churns needless reconnects mid-play.
const MEDIA_STALL_TIMEOUT_MS=15_000;
const MEDIA_RESUME_HEADER_TIMEOUT_MS=8_000;
// Consecutive resume attempts allowed *without forward progress*. The budget is refunded whenever the
// stream advances (see deliverResumable), so a long movie tolerates unlimited isolated hiccups and
// only a genuinely dead origin exhausts it.
const MEDIA_RESUME_ATTEMPTS=3;

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

function contentRange(value) {
  const match=/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value||'').trim());
  if(!match)return null;
  const start=Number(match[1]),end=Number(match[2]),total=match[3]==='*'?null:Number(match[3]);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start||total!==null&&(!Number.isSafeInteger(total)||total<=end))return null;
  return {start,end,total};
}

// A response can be resumed invisibly only when its exact remaining byte interval is known. We keep
// the original downstream headers/status and append validated 206 bodies behind them.
function mediaResumePlan(method,status,headers) {
  if(String(method).toUpperCase()!=='GET'||![200,206].includes(status))return null;
  const length=Number(headers['content-length']);
  if(!Number.isSafeInteger(length)||length<=0||String(headers['content-encoding']||'identity').toLowerCase()!=='identity')return null;
  if(status===206){
    const range=contentRange(headers['content-range']);
    if(!range||range.end-range.start+1!==length)return null;
    return {...range,length,validator:String(headers.etag||headers['last-modified']||'')};
  }
  return {start:0,end:length-1,total:length,length,validator:String(headers.etag||headers['last-modified']||'')};
}

function compatibleResume(status,headers,plan,next) {
  const range=contentRange(headers['content-range']),length=Number(headers['content-length']);
  if(status!==206||!range||range.start!==next||range.end>plan.end||!Number.isSafeInteger(length)||length!==range.end-range.start+1)return false;
  if(plan.validator){const current=String(headers.etag||headers['last-modified']||'');if(current&&current!==plan.validator)return false;}
  return true;
}

function waitForDrain(res,source) {
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{res.off('drain',drain);res.off('close',closed);res.off('error',failed)};
    const drain=()=>{cleanup();source?.socket?.setTimeout?.(MEDIA_STALL_TIMEOUT_MS);resolve()};
    const closed=()=>{cleanup();reject(Object.assign(new Error('client closed'),{code:'ECLIENTGONE'}))};
    const failed=error=>{cleanup();reject(error)};
    // A paused/slow client is legitimate backpressure, not an upstream stall. Suspend the source
    // idle watchdog until Nginx/the client can accept more bytes.
    source?.socket?.setTimeout?.(0);
    res.once('drain',drain);res.once('close',closed);res.once('error',failed);
  });
}

async function pumpMedia(source,res,onBytes) {
  for await (const chunk of source) {
    if(res.destroyed)throw Object.assign(new Error('client closed'),{code:'ECLIENTGONE'});
    if(!chunk.length)continue;
    if(!res.write(chunk))await waitForDrain(res,source);
    onBytes(chunk.length);
  }
}

function accessPrefix(route, suppliedKey = '') {
  return route.accessMode === 'alias_only' ? `/${route.alias}` : `/${route.alias}/${suppliedKey}`;
}

function routeFor(req, routes, key) {
  const parts = new URL(req.url, 'http://relay.invalid').pathname.split('/').filter(Boolean);
  const offset = parts[0] === 'r' ? 1 : 0;
  const route = routes.find(r => r.enabled && r.alias === parts[offset]);
  if (!route) return null;
  if (route.accessMode === 'alias_only') return { route, rest:`/${parts.slice(offset + 1).join('/')}`, suppliedKey:'', prefix:accessPrefix(route), channelId:'default' };
  if (parts.length <= offset + 1) return null;
  const suppliedKey = parts[offset + 1], channel = matchRouteChannel(route, suppliedKey, key);
  if (!channel) return null;
  return { route, rest:`/${parts.slice(offset + 2).join('/')}`, suppliedKey, prefix:accessPrefix(route, suppliedKey), channelId:channel.id };
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
  const regex=new RegExp('(https?|wss?):\\/\\/('+alt+')(:\\d+)?(?=[/"\'?#\\\\]|$)','g');
  const replacer=m=>{ const s=m[1].toLowerCase(), secure=s==='https'||s==='wss', ws=s==='ws'||s==='wss';
    return (ws?wsBase:base)+(secure?'https':'http')+'/'+m[2]+(m[3]||''); };
  // Longest possible match: scheme + longest declared host + ":65535". Carry this many trailing chars
  // between chunks so a URL split across chunk boundaries is never mis-emitted.
  const keep=Math.max(...domains.map(d=>d.length))+16;
  return { regex, replacer, keep };
}
function isRewritableType(contentType) {
  const ct=String(contentType||'').toLowerCase();
  return /^text\//.test(ct) || /(json|xml|javascript|ecmascript|mpegurl|dash\+xml)/.test(ct);
}
function isManifestResponse(contentType, pathname='') {
  const ct=String(contentType||'').toLowerCase(),path=String(pathname||'').toLowerCase();
  return /(mpegurl|dash\+xml)/.test(ct)||/\.(?:m3u8|mpd)(?:$|[?#])/i.test(path);
}
// A playback URL is a byte stream unless it is unmistakably an HLS/DASH manifest. Some Emby/CDN
// stacks return a first, non-Range media response as HTTP 200 and occasionally mislabel it as
// text/plain or application/json. Sending that body through StringDecoder/RegExp corrupts bytes,
// burns CPU and throttles the stream. Keep the entire media path zero-copy by default; API responses
// such as PlaybackInfo are not classified as playback and remain eligible for URL rewriting.
export function shouldRewriteStreamBody({method='GET',status=200,headers={},playback=false,pathname=''}) {
  if(String(method).toUpperCase()==='HEAD'||headers.range||headers['content-range']||status===206||status===204||status===304)return false;
  if(!isRewritableType(headers['content-type']))return false;
  if(playback&&!isManifestResponse(headers['content-type'],pathname))return false;
  return true;
}
// A streaming stream-URL rewriter. It never buffers the whole body — it rewrites matches as bytes
// flow through and only holds back a short tail (a possible partial URL at a chunk boundary), so the
// client starts receiving the response immediately. This keeps playback start fast and can never
// stall a stream, even if a body is large or a response is misclassified as rewritable.
class StreamRewrite extends Transform {
  constructor({regex,replacer,keep}){ super(); this.regex=regex; this.replacer=replacer; this.keep=keep; this.decoder=new StringDecoder('utf8'); this.carry=''; }
  _transform(chunk,_enc,cb){
    const s=this.carry+this.decoder.write(chunk);
    if(s.length<=this.keep){ this.carry=s; return cb(); }
    const safe=s.length-this.keep; this.regex.lastIndex=0;
    let out='',lastEnd=0,m;
    while((m=this.regex.exec(s))){
      if(m.index>=safe)break;              // starts in the carry zone — might be incomplete, defer it
      out+=s.slice(lastEnd,m.index)+this.replacer(m); lastEnd=m.index+m[0].length;
    }
    const emitEnd=Math.max(lastEnd,safe);
    out+=s.slice(lastEnd,emitEnd); this.carry=s.slice(emitEnd);
    if(out)this.push(out); cb();
  }
  _flush(cb){ const s=this.carry+this.decoder.end(); this.regex.lastIndex=0; this.push(s.replace(this.regex,(...a)=>this.replacer(a))); cb(); }
}
// Streaming decompressor matched to the body's encoding, or null for identity/none. Undefined return
// means an encoding we can't decode — the caller then streams the body through untouched.
function decompressor(encoding){
  const e=String(encoding||'').toLowerCase();
  if(!e||e==='identity')return null;
  if(e==='gzip'||e==='x-gzip')return zlib.createGunzip();
  if(e==='deflate')return zlib.createInflate();
  if(e==='br')return zlib.createBrotliDecompress();
  return undefined;
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
    // Log the viewer (IP + device) once per identifiable request, before the client IP is stripped.
    if (metrics && (playback || hasViewerIdentity(req,incoming))) { const info=accessInfoFrom(req,incoming); if(info){ info.channelId=found.channelId||'default'; metrics.recordAccess(route,info); } }
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
      // A failover/stale-socket retry (freshSocket) forces a clean one-shot socket; otherwise media
      // rides its own warm pool and control traffic rides the API pool. Keeping the two pools apart
      // means a long media body can never inherit — or hand off — a poisoned API socket.
      const pool=freshSocket?null:(playback?(secure?httpsMediaAgent:httpMediaAgent):(secure?httpsAgent:httpAgent));
      const usesPool=!!pool;
      requestHeaders.connection=usesPool?'keep-alive':'close';
      const tlsKey=secure?tlsSessionKey(target):'';
      const options={protocol:target.protocol,hostname:target.hostname,port:target.port,method:req.method,path:target.pathname+target.search,headers:requestHeaders,servername:target.hostname,rejectUnauthorized:route.tlsVerify!==false,lookup:guardedLookup(route.allowPrivate),highWaterMark:RELAY_HIGH_WATER_MARK,agent:pool||false};
      // Pooled agents handle TLS resumption themselves. The one-shot recovery/failover sockets fall
      // back to the shared session cache so even a fresh connection skips the full handshake.
      if(secure&&!usesPool){ const sess=tlsSessions.get(tlsKey); if(sess)options.session=sess; }
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
        const finishMetric=(failed=false)=>{if(measured)return;measured=true;metricDone?.(status,metricDone?.addBytes?0:streamed,failed||status>=500)};
        // pipeline (unlike .pipe) tears every stream down on failure and never leaves a dangling
        // half-open response. Short API responses return to the API pool; media responses are
        // intentionally one-shot so the next segment/seek cannot inherit a poisoned connection.
        // pipe upRes through any transforms, then to the client. `stages` is [source, ...transforms];
        // nothing is ever fully buffered, so the client starts receiving bytes immediately.
        const deliver=(...stages)=>{
          res.writeHead(status,out);
          res.flushHeaders?.();
          const done=err=>{ if(err&&!up.destroyed)up.destroy(); finishMetric(); };
          const tail=stages[stages.length-1];
          if(speed>0){
            const counter=new ThrottleTransform(speed*1024*1024/8,bytes=>{streamed+=bytes;metricDone?.addBytes?.(bytes)});
            pipeline(...stages,counter,res,done);
          }else{
            // No rate limit means no throttling transform. Count bytes off the last stage (what the
            // client actually receives) with a listener instead of parking a transform in the path.
            // Attach pipeline first: adding a data listener puts a pre-buffered IncomingMessage into
            // flowing mode, so the destination must already be subscribed before accounting begins.
            pipeline(...stages,res,done);
            tail.on('data',chunk=>{streamed+=chunk.length;metricDone?.addBytes?.(chunk.length)});
          }
        };
        const openResume=(plan,next)=>new Promise((resolve,reject)=>{
          const resumeHeaders={...requestHeaders,range:`bytes=${next}-${plan.end}`,connection:'close'};
          delete resumeHeaders['if-none-match'];delete resumeHeaders['if-modified-since'];
          if(plan.validator)resumeHeaders['if-range']=plan.validator;
          const resumeOptions={...options,method:'GET',headers:resumeHeaders,agent:false};
          if(secure){const sess=tlsSessions.get(tlsKey);if(sess)resumeOptions.session=sess;}
          let settled=false,connectGuard,headerGuard;
          const fail=error=>{clearTimeout(connectGuard);clearTimeout(headerGuard);if(settled)return;settled=true;reject(error)};
          const resumeReq=(target.protocol==='https:'?https:http).request(resumeOptions,resumeRes=>{
            clearTimeout(connectGuard);clearTimeout(headerGuard);
            const resumeStatus=resumeRes.statusCode||0,resumeHeadersOut=cleanResponseHeaders(resumeRes.headers);
            if(!compatibleResume(resumeStatus,resumeHeadersOut,plan,next)){
              resumeRes.destroy();return fail(Object.assign(new Error('upstream rejected byte resume'),{code:'ERESUMEREJECTED'}));
            }
            settled=true;activeUp=resumeReq;resolve(resumeRes);
          });
          activeUp=resumeReq;
          connectGuard=setTimeout(()=>resumeReq.destroy(timeoutError('resume connect timeout')),CONNECT_TIMEOUT_MS);
          headerGuard=setTimeout(()=>resumeReq.destroy(timeoutError('resume headers timeout')),MEDIA_RESUME_HEADER_TIMEOUT_MS);
          connectGuard.unref?.();headerGuard.unref?.();
          resumeReq.on('socket',socket=>{
            socket.setNoDelay(true);socket.setKeepAlive(true,15_000);
            if(secure&&socket.connecting)socket.on('session',session=>rememberTlsSession(tlsKey,session));
            if(socket.connecting)socket.once(secure?'secureConnect':'connect',()=>clearTimeout(connectGuard));else clearTimeout(connectGuard);
          });
          resumeReq.setTimeout(MEDIA_STALL_TIMEOUT_MS,()=>resumeReq.destroy(timeoutError('resumed media stalled')));
          resumeReq.on('error',fail);resumeReq.end();
        });
        const deliverResumable=(source,plan)=>{
          res.writeHead(status,out);res.flushHeaders?.();
          // Only watchdog a byte-addressable body. During downstream backpressure pumpMedia disables
          // this timer, so a paused/slow viewer is not mistaken for a dead origin.
          up.setTimeout(MEDIA_STALL_TIMEOUT_MS);
          const run=async()=>{
            let current=source,retries=0,lastError=null,marker=streamed;
            while(!clientGone&&!res.destroyed&&streamed<plan.length){
              if(current){
                try{await pumpMedia(current,res,bytes=>{streamed+=bytes;metricDone?.addBytes?.(bytes)});lastError=null;}
                catch(error){lastError=error;}
                current=null;
              }
              if(streamed===plan.length)break;
              if(streamed>plan.length)break;
              // Any forward progress means the origin is alive, just intermittent (a slow transcode,
              // a CDN edge hiccup). Refund the retry budget so a two-hour movie with a dozen scattered
              // stalls never runs out and drops the stream — only stalls with *no* progress between
              // them count, which is the signature of an origin that has actually died.
              if(streamed>marker){retries=0;marker=streamed;}
              if(retries>=MEDIA_RESUME_ATTEMPTS)break;
              const next=plan.start+streamed;retries++;
              try{current=await openResume(plan,next);markSuccess(route,targetValue);}
              catch(error){lastError=error;}
            }
            if(clientGone||res.destroyed){finishMetric();return;}
            if(streamed===plan.length){res.end();finishMetric();return;}
            const error=lastError||Object.assign(new Error('upstream media ended before content-length'),{code:'ECONNRESET'});
            markFailure(route,targetValue,safeUpstreamError(error));finishMetric(true);
            if(!res.destroyed)res.destroy(error);
          };
          run().catch(error=>{markFailure(route,targetValue,safeUpstreamError(error));finishMetric(true);if(!res.destroyed)res.destroy(error)});
        };
        // The stream-URL rewrite only touches API bodies and explicit HLS/DASH manifests. Every other
        // playback response is passed straight through, including non-Range HTTP 200 bodies with a
        // wrong text/JSON MIME type. The rewrite itself streams and decompresses on the fly.
        const enc=out['content-encoding'];
        const rewriteBody=!!rewriter&&shouldRewriteStreamBody({method:req.method,status,headers:{...out,range:req.headers.range},playback,pathname:target.pathname});
        const gunzip=rewriteBody?decompressor(enc):null;
        if (rewriteBody && gunzip!==undefined) {
          // Length and encoding change as we rewrite/decompress, so drop them and let the response chunk.
          delete out['content-encoding']; delete out['content-length'];
          const rewrite=new StreamRewrite(rewriter);
          // pipeline (inside deliver) tears every stage down together if the decoder hits a mislabeled
          // body, so a bad response fails cleanly instead of stalling.
          deliver(...(gunzip?[upRes,gunzip,rewrite]:[upRes,rewrite]));
        } else {
          const resumePlan=playback&&speed<=0?mediaResumePlan(req.method,status,out):null;
          if(resumePlan)deliverResumable(upRes,resumePlan);else deliver(upRes);
        }
      });
      activeUp=up;
      const timeoutError=message=>Object.assign(new Error(message),{code:'ETIMEDOUT'});
      const connectTimer=setTimeout(()=>up.destroy(timeoutError('connect timeout')),CONNECT_TIMEOUT_MS);
      const responseTimeout=playback?PLAYBACK_HEADER_TIMEOUT_MS:(configured.length>1?FAILOVER_HEADER_TIMEOUT_MS:RESPONSE_HEADER_TIMEOUT_MS);
      const headerTimer=setTimeout(()=>up.destroy(timeoutError('response headers timeout')),responseTimeout);
      connectTimer.unref?.();headerTimer.unref?.();
      up.on('response',()=>{clearTimeout(connectTimer);clearTimeout(headerTimer)});
      up.on('socket',s=>{
        s.setNoDelay(true);s.setKeepAlive(true,15_000);
        if(!s.connecting)return clearTimeout(connectTimer);
        // Capture TLS session tickets from every new connection (API and media) so later unpooled
        // playback sockets to the same origin can resume instead of doing a full handshake.
        if(secure)s.on('session',sess=>rememberTlsSession(tlsKey,sess));
        // TCP connect is not enough for HTTPS: keep the guard running until the TLS handshake has
        // completed, otherwise a stalled secureConnect can hold playback for the full idle timeout.
        s.once(secure?'secureConnect':'connect',()=>clearTimeout(connectTimer));
      });
      up.setTimeout(3600_000,()=>up.destroy(new Error('upstream idle timeout')));
      up.on('error',err=>{
        clearTimeout(connectTimer);clearTimeout(headerTimer);
        // A client that walked away is not an upstream fault; counting it opened circuits on
        // perfectly healthy nodes and produced sporadic 502s mid-session.
        if (clientGone) { if(!finished){finished=true;metricDone?.(499,0,false);} return; }
        // A pooled connection the origin had already closed dies on reuse. Retry the same upstream
        // once on a brand-new socket before treating it as a real failure.
        const staleSocket=usesPool&&!finished&&canRetry&&!res.headersSent;
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
