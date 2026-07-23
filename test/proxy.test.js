import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {getRuntimeStatus,makeProxyHandler,RELAY_HIGH_WATER_MARK,RELAY_SERVER_OPTIONS,shouldRewriteStreamBody,stripAdminCredentials,stripAdminSetCookies,validateUpstream,validateUpstreamList} from '../src/proxy.js';import {deriveKey,tokenDigest} from '../src/security.js';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';
import { AtomicRouteSource } from '../src/local-agent.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port))),close=s=>new Promise(r=>{s.closeAllConnections?.();s.close(r)});
const listenAny=s=>new Promise(r=>s.listen(0,()=>r(s.address().port)));
const request=(port,path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,method,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}))});req.on('error',reject);if(body)req.write(body);req.end()});
test('relay servers use the shared bounded high-throughput socket window',()=>{assert.equal(RELAY_HIGH_WATER_MARK,256*1024);assert.equal(RELAY_SERVER_OPTIONS.highWaterMark,RELAY_HIGH_WATER_MARK);assert.equal(RELAY_SERVER_OPTIONS.noDelay,true);assert.equal(RELAY_SERVER_OPTIONS.keepAlive,true)});
test('media bodies use a clean upstream connection instead of reusing the preceding API socket',async()=>{
  const sockets=[];const upstream=http.createServer((q,s)=>{sockets.push({url:q.url,port:q.socket.remotePort,connection:q.headers.connection});s.end(q.url.includes('/Videos/')?'media':'api')}),up=await listen(upstream),key=deriveKey('q'.repeat(32));
  const store={data:{routes:[{id:'clean-media',alias:'clean-media',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  assert.equal(await(await fetch(`http://127.0.0.1:${port}/clean-media/System/Info`)).text(),'api');
  assert.equal(await(await fetch(`http://127.0.0.1:${port}/clean-media/Videos/1/stream.mp4`,{headers:{range:'bytes=0-'}})).text(),'media');
  assert.equal(sockets.length,2);assert.notEqual(sockets[0].port,sockets[1].port);assert.equal(sockets[1].connection,'close');
  await close(relay);await close(upstream);
});
test('an unlimited media response forwards its first small chunk before the origin finishes',async()=>{
  const first=Buffer.alloc(4096,0x11),rest=Buffer.alloc(256*1024,0x22);let release;
  const upstream=http.createServer((_q,s)=>{s.writeHead(206,{'content-type':'video/mp4','content-range':`bytes 0-${first.length+rest.length-1}/${first.length+rest.length}`});s.write(first);release=()=>s.end(rest)}),up=await listen(upstream),key=deriveKey('w'.repeat(32));
  const store={data:{routes:[{id:'first-byte',alias:'first-byte',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  const result=await new Promise((resolve,reject)=>{const chunks=[];let sawFirst=false;const q=http.get({hostname:'127.0.0.1',port,path:'/first-byte/Videos/1/stream.mp4',headers:{range:'bytes=0-'}},r=>{r.on('data',chunk=>{chunks.push(chunk);if(!sawFirst){sawFirst=true;assert.equal(chunk.subarray(0,first.length).equals(first),true);setTimeout(release,10)}});r.on('end',()=>resolve(Buffer.concat(chunks)))});q.on('error',reject)});
  assert.equal(result.length,first.length+rest.length);assert.equal(result.subarray(0,first.length).equals(first),true);assert.equal(result.subarray(first.length).equals(rest),true);
  await close(relay);await close(upstream);
});
test('proxy accepts short root alias and legacy /r capability paths',async()=>{const seen=[];const upstream=http.createServer((req,res)=>{seen.push(req.url);res.end('ok')});const upPort=await listen(upstream),key=deriveKey('p'.repeat(32));const store={data:{routes:[{id:'a',alias:'home',enabled:true,upstreams:[`http://127.0.0.1:${upPort}`],accessMode:'key',allowPrivate:true,tlsVerify:true,keyDigest:tokenDigest('capability',key)}]}};const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);for(const path of ['/home/capability/emby/Items?x=1','/r/home/capability/System/Info']){const good=await fetch(`http://127.0.0.1:${port}${path}`);assert.equal(good.status,200);assert.equal(await good.text(),'ok')}assert.deepEqual(seen,['/emby/Items?x=1','/System/Info']);assert.equal((await fetch(`http://127.0.0.1:${port}/home/wrong/`)).status,404);await close(relay);await close(upstream)});
test('proxy validates migrated nodes without the application master key',async()=>{
  const upstream=http.createServer((req,res)=>res.end('decoupled'));
  let relay;
  try{
    const upPort=await listen(upstream),routeAuthKey=newRouteAuthKey();
    const route={id:'decoupled',alias:'charity',enabled:true,upstreams:[`http://127.0.0.1:${upPort}`],accessMode:'key',allowPrivate:true,tlsVerify:true,authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('existing-client-key',routeAuthKey)};
    const store={data:{routes:[route]}},unrelatedMaster=deriveKey('unrelated'.padEnd(32,'x'));
    relay=http.createServer(makeProxyHandler(store,unrelatedMaster));
    const port=await listen(relay),response=await fetch(`http://127.0.0.1:${port}/charity/existing-client-key/System/Info`);
    assert.equal(response.status,200);
    assert.equal(await response.text(),'decoupled');
  }finally{
    if(relay)await close(relay);
    await close(upstream);
  }
});
test('atomic local-agent apply keeps in-flight playback on the old revision',async()=>{
  let releaseOld,oldStartedResolve,relay;
  const oldStarted=new Promise(r=>oldStartedResolve=r);
  const old=http.createServer((q,s)=>{oldStartedResolve();new Promise(r=>releaseOld=r).then(()=>s.end('old-revision'))});
  const next=http.createServer((q,s)=>s.end('new-revision'));
  try{
    const oldPort=await listen(old),nextPort=await listen(next),key=deriveKey('atomic'.padEnd(32,'x')),base={id:'atomic',alias:'atomic',enabled:true,accessMode:'alias_only',allowPrivate:true};
    const source=new AtomicRouteSource([{...base,upstreams:[`http://127.0.0.1:${oldPort}`]}]);
    relay=http.createServer(makeProxyHandler(source,key));
    const port=await listen(relay),inFlight=fetch(`http://127.0.0.1:${port}/atomic/Videos/1/stream`);
    await Promise.race([oldStarted,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('old revision stream did not start')),5000);timer.unref()})]);
    source.apply([{...base,upstreams:[`http://127.0.0.1:${nextPort}`]}]);
    assert.equal(await(await fetch(`http://127.0.0.1:${port}/atomic/Videos/2/stream`)).text(),'new-revision');
    releaseOld();
    assert.equal(await(await inFlight).text(),'old-revision');
  }finally{
    releaseOld?.();
    if(relay)await close(relay);
    await close(old);
    await close(next);
  }
});
test('private upstreams are denied unless explicitly allowed',async()=>{await assert.rejects(()=>validateUpstream('http://127.0.0.1:8096',false));assert.equal(await validateUpstream('http://127.0.0.1:8096',true),'http://127.0.0.1:8096')});
test('upstream lists support newline and semicolon separators',async()=>{const list=await validateUpstreamList('http://127.0.0.1:1;\nhttp://127.0.0.1:2',true);assert.deepEqual(list,['http://127.0.0.1:1','http://127.0.0.1:2'])});
test('upstream redirects stay behind the relay and preserve playback ranges',async()=>{
  let relay,cdnRequest;
  const cdn=http.createServer((q,s)=>{cdnRequest={url:q.url,headers:q.headers};s.writeHead(206,{'content-type':'video/mp4','content-range':'bytes 0-3/10'});s.end('data')});
  const origin=http.createServer((q,s)=>{s.writeHead(302,{location:`http://127.0.0.1:${cdn.address().port}/file.mp4?sig=private`});s.end()});
  try{
    const cp=await listen(cdn),op=await listen(origin),key=deriveKey('z'.repeat(32));
    assert.equal(cp,cdn.address().port);
    const route={id:'redirect',alias:'media',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${op}`],allowPrivate:true},store={data:{routes:[route]}};
    relay=http.createServer(makeProxyHandler(store,key));
    const port=await listen(relay),first=await request(port,'/media/Videos/1/stream',{headers:{host:'relay.example','x-forwarded-proto':'https'}});
    assert.equal(first.status,302);
    assert.match(first.headers.location,/^https:\/\/relay\.example\/media\/\.aegis-relay\/[A-Za-z0-9_-]+$/);
    assert.equal(first.headers.location.includes(String(cp)),false);
    const continuation=new URL(first.headers.location).pathname;
    const streamed=await request(port,continuation,{headers:{host:'relay.example',range:'bytes=0-3',authorization:'secret',cookie:'session=secret','x-emby-token':'secret'}});
    assert.equal(streamed.status,206);assert.equal(streamed.body.toString(),'data');
    assert.equal(cdnRequest.url,'/file.mp4?sig=private');assert.equal(cdnRequest.headers.range,'bytes=0-3');
    assert.equal(cdnRequest.headers.authorization,undefined);assert.equal(cdnRequest.headers.cookie,undefined);assert.equal(cdnRequest.headers['x-emby-token'],undefined);
    const tampered=`${continuation.slice(0,-1)}${continuation.endsWith('A')?'B':'A'}`;
    assert.equal((await request(port,tampered)).status,404);
  }finally{
    if(relay)await close(relay);
    await close(origin);await close(cdn);
  }
});
test('authorized compatibility profile rewrites only declared client headers',async()=>{let got;const upstream=http.createServer((q,s)=>{got=q.headers;s.end('ok')}),up=await listen(upstream),key=deriveKey('h'.repeat(32));const store={data:{routes:[{id:'headers',alias:'headers',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,clientProfile:{enabled:true,userAgent:'Authorized UA',client:'Authorized Client',deviceName:'Relay Device'}}]}};const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);await fetch(`http://127.0.0.1:${port}/headers/System/Info`);assert.equal(got['user-agent'],'Authorized UA');assert.equal(got['x-emby-client'],'Authorized Client');assert.equal(got['x-emby-device-name'],'Relay Device');await close(relay);await close(upstream)});
test('safe requests fail over from repeated 503 responses and open the circuit',async()=>{let failures=0;const bad=http.createServer((q,s)=>{failures++;s.writeHead(503);s.end('down')}),good=http.createServer((q,s)=>s.end('healthy')),bp=await listen(bad),gp=await listen(good),key=deriveKey('f'.repeat(32));const store={data:{routes:[{id:'failover',alias:'failover',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${bp}`,`http://127.0.0.1:${gp}`],allowPrivate:true}]}};const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);for(let i=0;i<6;i++)assert.equal(await(await fetch(`http://127.0.0.1:${port}/failover/System/Info`)).text(),'healthy');assert.ok(failures>=1);await close(relay);await close(bad);await close(good)});
test('toolbox-style base paths are not duplicated after login redirects',async()=>{
  let upPort,relay;
  const seen=[],gateway=http.createServer((q,s)=>{seen.push(q.url);const base='/tool-key/http/origin.example:8096';if(q.method==='POST'){s.writeHead(302,{location:`http://127.0.0.1:${upPort}${base}/web/index.html`});return s.end()}s.end('ready')});
  try{
    const gp=await listen(gateway);upPort=gp;
    const key=deriveKey('g'.repeat(32)),route={id:'toolbox',alias:'magpie',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${gp}/tool-key/http/origin.example:8096`],allowPrivate:true},store={data:{routes:[route]}};
    relay=http.createServer(makeProxyHandler(store,key));
    const port=await listen(relay),login=await fetch(`http://127.0.0.1:${port}/magpie/Users/AuthenticateByName`,{method:'POST',body:'{}',headers:{'content-type':'application/json'},redirect:'manual'});
    assert.equal(login.status,302);
    assert.equal(login.headers.get('location'),`http://127.0.0.1:${port}/magpie/web/index.html`);
    assert.equal(await(await fetch(`http://127.0.0.1:${port}/magpie/web/index.html`)).text(),'ready');
    assert.deepEqual(seen,['/tool-key/http/origin.example:8096/Users/AuthenticateByName','/tool-key/http/origin.example:8096/web/index.html']);
  }finally{
    if(relay)await close(relay);
    await close(gateway);
  }
});
test('playback keeps public HTTPS metadata and byte ranges through toolbox base paths',async()=>{let got;const gateway=http.createServer((q,s)=>{if(q.url.includes('/Items/1/PlaybackInfo')){s.setHeader('content-type','application/json');return s.end('{"MediaSources":[{"SupportsDirectPlay":true}]}')}got={url:q.url,headers:q.headers};s.writeHead(206,{'content-type':'video/mp4','accept-ranges':'bytes','content-range':'bytes 0-3/10','etag':'"media-v1"'});s.end('data')}),gp=await listen(gateway),key=deriveKey('v'.repeat(32)),route={id:'play',alias:'cinema',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${gp}/tool-key/https/origin.example`],allowPrivate:true},store={data:{routes:[route]}},relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);const info=await request(port,'/cinema/Items/1/PlaybackInfo',{method:'POST',headers:{host:'emby.example.com','x-forwarded-proto':'https','content-type':'application/json'},body:'{}'});assert.equal(info.status,200);const stream=await request(port,'/cinema/Videos/1/stream.mp4',{headers:{host:'emby.example.com','x-forwarded-proto':'https',range:'bytes=0-3','if-range':'"media-v1"'}});assert.equal(stream.status,206);assert.equal(stream.headers['content-range'],'bytes 0-3/10');assert.equal(stream.body.toString(),'data');assert.equal(got.url,'/tool-key/https/origin.example/Videos/1/stream.mp4');assert.equal(got.headers.range,'bytes=0-3');assert.equal(got.headers['if-range'],'"media-v1"');assert.equal(got.headers['x-forwarded-host'],'emby.example.com');assert.equal(got.headers['x-forwarded-proto'],'https');await close(relay);await close(gateway)});
test('toolbox target changes are wrapped and requested through AegisRelay',async()=>{
  let gatewayPort,relay;const base='/tool-key/http/origin.example:8096',cdn='/tool-key/https/cdn.example/file.mp4',seen=[];
  const gateway=http.createServer((q,s)=>{seen.push(q.url);if(q.url===cdn){s.writeHead(206,{'content-type':'video/mp4'});return s.end('proxied-media')}s.writeHead(302,{location:`http://127.0.0.1:${gatewayPort}${cdn}`});s.end()});
  try{
    const gp=await listen(gateway);gatewayPort=gp;
    const key=deriveKey('j'.repeat(32)),route={id:'nested-redirect',alias:'movie',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${gp}${base}`],allowPrivate:true},store={data:{routes:[route]}};
    relay=http.createServer(makeProxyHandler(store,key));const port=await listen(relay);
    const first=await request(port,'/movie/Videos/1/stream',{headers:{host:'movie.example','x-forwarded-proto':'https'}});
    assert.equal(first.status,302);assert.match(first.headers.location,/^https:\/\/movie\.example\/movie\/\.aegis-relay\//);
    assert.equal(first.headers.location.includes(cdn),false);
    const second=await request(port,new URL(first.headers.location).pathname,{headers:{host:'movie.example',range:'bytes=0-'}});
    assert.equal(second.status,206);assert.equal(second.body.toString(),'proxied-media');
    assert.deepEqual(seen,[`${base}/Videos/1/stream`,cdn]);
  }finally{if(relay)await close(relay);await close(gateway)}
});
test('a final upstream 502 remains visible in runtime diagnostics',async()=>{const bad=http.createServer((q,s)=>{s.writeHead(502);s.end('bad')}),bp=await listen(bad),key=deriveKey('b'.repeat(32)),route={id:'bad',alias:'bad',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${bp}`],allowPrivate:true},store={data:{routes:[route]}},relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);assert.equal((await fetch(`http://127.0.0.1:${port}/bad/System/Info`)).status,502);assert.equal(getRuntimeStatus([route])[0].upstreams[0].lastError,'HTTP 502');await close(relay);await close(bad)});
test('domain upstreams work with Node all-address connection attempts',async()=>{const upstream=http.createServer((q,s)=>s.end('domain-ok')),up=await listenAny(upstream),key=deriveKey('d'.repeat(32)),route={id:'domain',alias:'domain',enabled:true,accessMode:'alias_only',upstreams:[`http://localhost:${up}`],allowPrivate:true},store={data:{routes:[route]}},relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);assert.equal(await(await fetch(`http://127.0.0.1:${port}/domain/System/Info`)).text(),'domain-ok');await close(relay);await close(upstream)});
test('admin cookie and CSRF token are stripped before proxying',()=>{const headers={cookie:'emby_session=media; aegis_session=admin-secret; theme=dark','x-csrf-token':'csrf-secret'};assert.deepEqual(stripAdminCredentials(headers),{cookie:'emby_session=media; theme=dark'})});
test('upstreams cannot overwrite the root-scoped admin cookie',()=>{const headers={'set-cookie':['emby_session=media; Path=/','aegis_session=attacker; Path=/']};assert.deepEqual(stripAdminSetCookies(headers),{'set-cookie':['emby_session=media; Path=/']})});

test('compatibility profile sets hint headers but never rewrites the authenticated identity or query',async()=>{
  // The compat profile is only a hint for upstreams you own/are authorized to proxy. It must leave
  // the MediaBrowser auth header, tokens, and query identity byte-for-byte intact — rewriting them
  // desyncs the request from Emby's token/session binding and breaks playback on anti-proxy servers.
  const seen=[];const upstream=http.createServer((q,s)=>{seen.push({url:q.url,headers:q.headers});s.end('ok')}),up=await listen(upstream),key=deriveKey('e'.repeat(32));
  const store={data:{routes:[{id:'emu',alias:'emu',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,clientProfile:{enabled:true,userAgent:'Compat UA',client:'Compat Client',deviceName:'Compat Device'}}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  await request(port,'/emu/Videos/1/stream?X-Emby-Client=Popcorn&DeviceId=real-abc&api_key=keepme',{headers:{'x-emby-authorization':'MediaBrowser Client="Popcorn", Device="iPhone14", DeviceId="real-abc", Version="9.9", Token="secret-token"'}});
  const a=seen[0];
  // declared compat hint headers are applied
  assert.equal(a.headers['user-agent'],'Compat UA');
  assert.equal(a.headers['x-emby-client'],'Compat Client');
  assert.equal(a.headers['x-emby-device-name'],'Compat Device');
  // authenticated identity, token, and query are passed through unchanged
  assert.equal(a.headers['x-emby-authorization'],'MediaBrowser Client="Popcorn", Device="iPhone14", DeviceId="real-abc", Version="9.9", Token="secret-token"');
  assert.match(a.url,/X-Emby-Client=Popcorn/);
  assert.match(a.url,/DeviceId=real-abc/);
  assert.match(a.url,/api_key=keepme/);
  await close(relay);await close(upstream);
});

test('front/back split: stream URLs in text bodies are rewritten and proxied back, unknown hosts blocked',async()=>{
  let streamUrl=null,host='';
  // One origin plays both roles: /Items returns an API body pointing at the (split) stream domain,
  // everything else is the stream itself. The declared stream domain is this same host:port.
  const upstream=http.createServer((q,s)=>{
    if(q.url.startsWith('/Items')){s.setHeader('content-type','application/json');return s.end(JSON.stringify({MediaSources:[{DirectStreamUrl:`http://${host}/videos/9/stream.mp4?api_key=abc`}]}))}
    streamUrl=q.url;s.setHeader('content-type','video/mp4');s.end('stream-bytes');
  });
  const up=await listen(upstream);host=`127.0.0.1:${up}`;const key=deriveKey('s'.repeat(32));
  const store={data:{routes:[{id:'split',alias:'emu',enabled:true,accessMode:'alias_only',upstreams:[`http://${host}`],allowPrivate:true,streamRewrite:{enabled:true,domains:[host]}}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  // 1. the stream URL in the JSON body is rewritten to a path on this relay's own domain
  const info=await request(port,'/emu/Items/1/PlaybackInfo',{headers:{host:'relay.test','x-forwarded-proto':'https'}});
  const streamPath=`/emu/.aegis-vod/http/${host}/videos/9/stream.mp4?api_key=abc`;
  assert.ok(info.body.toString().includes(`https://relay.test${streamPath}`),info.body.toString());
  // 2. requesting the rewritten path proxies back to the real stream domain, query intact
  const media=await request(port,streamPath,{headers:{host:'relay.test'}});
  assert.equal(media.status,200);
  assert.equal(media.body.toString(),'stream-bytes');
  assert.equal(streamUrl,'/videos/9/stream.mp4?api_key=abc');
  // 3. a host the operator never declared cannot be reached through the path (SSRF guard)
  assert.equal((await request(port,'/emu/.aegis-vod/http/169.254.169.254/latest/meta-data',{headers:{host:'relay.test'}})).status,404);
  // 4. only http/https transports are accepted
  assert.equal((await request(port,`/emu/.aegis-vod/ftp/${host}/x`,{headers:{host:'relay.test'}})).status,404);
  await close(relay);await close(upstream);
});

test('stream-domain rewrite is scheme-qualified and boundary-guarded against lookalike hosts',async()=>{
  const upstream=http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({a:'https://vod.example.net/x',b:'https://vod.example.net.evil.com/y',c:'wss://vod.example.net/live'}))}),up=await listen(upstream),key=deriveKey('t'.repeat(32));
  const store={data:{routes:[{id:'b',alias:'emu',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,streamRewrite:{enabled:true,domains:['vod.example.net']}}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  const t=(await request(port,'/emu/System/Info',{headers:{host:'relay.test','x-forwarded-proto':'https'}})).body.toString();
  assert.ok(t.includes('https://relay.test/emu/.aegis-vod/https/vod.example.net/x'),t);
  assert.ok(t.includes('wss://relay.test/emu/.aegis-vod/https/vod.example.net/live'),t);
  assert.ok(t.includes('https://vod.example.net.evil.com/y'),t); // lookalike suffix is left untouched
  await close(relay);await close(upstream);
});

test('rewrite never touches the media path: Range/206 responses stream through unbuffered and unaltered',async()=>{
  // A Range request is media — even on a rewrite-enabled node it must pass through byte-for-byte with
  // its 206 status and headers, never buffered, so seeking/throughput are unaffected.
  const upstream=http.createServer((q,s)=>{s.writeHead(206,{'content-type':'video/mp4','accept-ranges':'bytes','content-range':'bytes 0-4/1000','content-length':'5'});s.end('ABCDE')}),up=await listen(upstream),key=deriveKey('r'.repeat(32));
  const store={data:{routes:[{id:'m',alias:'emu',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,streamRewrite:{enabled:true,domains:[`127.0.0.1:${up}`]}}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  const r=await request(port,'/emu/Videos/1/stream.mp4',{headers:{host:'relay.test',range:'bytes=0-4'}});
  assert.equal(r.status,206);
  assert.equal(r.headers['content-range'],'bytes 0-4/1000');
  assert.equal(r.headers['content-length'],'5');
  assert.equal(r.body.toString(),'ABCDE');
  await close(relay);await close(upstream);
});

test('streaming rewrite reassembles a stream URL split across chunk boundaries',async()=>{
  // The rewrite streams (never buffers); a URL straddling two data chunks must still be rewritten
  // whole, and nothing before it should be withheld longer than the short carry.
  const upstream=http.createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.write('{"a":"https://vod.exa');setImmediate(()=>s.end('mple.net/movie.mp4","b":"keep"}'))}),up=await listen(upstream),key=deriveKey('c'.repeat(32));
  const store={data:{routes:[{id:'c',alias:'emu',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,streamRewrite:{enabled:true,domains:['vod.example.net']}}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  const t=(await request(port,'/emu/Items/1',{headers:{host:'relay.test','x-forwarded-proto':'https'}})).body.toString();
  assert.equal(t,'{"a":"https://relay.test/emu/.aegis-vod/https/vod.example.net/movie.mp4","b":"keep"}');
  await close(relay);await close(upstream);
});

test('rewrite classification keeps 200 playback bytes zero-copy even when the origin labels them as text or JSON',()=>{
  for(const contentType of ['text/plain','application/json'])assert.equal(shouldRewriteStreamBody({method:'GET',status:200,headers:{'content-type':contentType},playback:true,pathname:'/Videos/1/stream.mp4'}),false);
  assert.equal(shouldRewriteStreamBody({method:'GET',status:200,headers:{'content-type':'application/json'},playback:false,pathname:'/Items/1/PlaybackInfo'}),true);
  assert.equal(shouldRewriteStreamBody({method:'GET',status:200,headers:{'content-type':'application/vnd.apple.mpegurl'},playback:true,pathname:'/master.m3u8'}),true);
  assert.equal(shouldRewriteStreamBody({method:'GET',status:206,headers:{'content-type':'application/vnd.apple.mpegurl','content-range':'bytes 0-99/200'},playback:true,pathname:'/master.m3u8'}),false);
});

test('a non-Range 200 media response with a wrong JSON MIME type remains byte-for-byte intact',async()=>{
  const bytes=Buffer.concat([Buffer.from([0,255,254,253]),Buffer.alloc(256*1024,0xa5)]);
  const upstream=http.createServer((_q,s)=>{s.writeHead(200,{'content-type':'application/json','content-length':String(bytes.length)});s.end(bytes)}),up=await listen(upstream),key=deriveKey('y'.repeat(32));
  const store={data:{routes:[{id:'wrong-mime',alias:'emu',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,streamRewrite:{enabled:true,domains:[`127.0.0.1:${up}`]}}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  const response=await request(port,'/emu/Videos/1/stream.mp4',{headers:{host:'relay.test'}});
  assert.equal(response.status,200);assert.equal(response.headers['content-length'],String(bytes.length));assert.deepEqual(response.body,bytes);
  await close(relay);await close(upstream);
});

test('rewrite decodes a gzip-compressed API body before rewriting stream URLs',async()=>{
  const zlib=await import('node:zlib');
  const upstream=http.createServer((q,s)=>{const body=zlib.gzipSync(JSON.stringify({url:'https://vod.example.net/a.mp4'}));s.writeHead(200,{'content-type':'application/json','content-encoding':'gzip','content-length':String(body.length)});s.end(body)}),up=await listen(upstream),key=deriveKey('z'.repeat(32));
  const store={data:{routes:[{id:'g',alias:'emu',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,streamRewrite:{enabled:true,domains:['vod.example.net']}}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  const r=await request(port,'/emu/Items/1',{headers:{host:'relay.test','x-forwarded-proto':'https'}});
  assert.equal(r.headers['content-encoding'],undefined); // re-served decoded
  assert.ok(r.body.toString().includes('https://relay.test/emu/.aegis-vod/https/vod.example.net/a.mp4'),r.body.toString());
  await close(relay);await close(upstream);
});
