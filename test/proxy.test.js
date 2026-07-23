import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {getRuntimeStatus,makeProxyHandler,stripAdminCredentials,stripAdminSetCookies,validateUpstream,validateUpstreamList} from '../src/proxy.js';import {deriveKey,tokenDigest} from '../src/security.js';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';
import { AtomicRouteSource } from '../src/local-agent.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port))),close=s=>new Promise(r=>{s.closeAllConnections?.();s.close(r)});
const listenAny=s=>new Promise(r=>s.listen(0,()=>r(s.address().port)));
const request=(port,path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,method,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}))});req.on('error',reject);if(body)req.write(body);req.end()});
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
test('playback paths use the separate playback upstream',async()=>{const main=http.createServer((q,s)=>s.end('main')),play=http.createServer((q,s)=>s.end('play')),mp=await listen(main),pp=await listen(play),key=deriveKey('q'.repeat(32));const store={data:{routes:[{id:'split',alias:'split',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${mp}`],playbackUpstreams:[`http://127.0.0.1:${pp}`],allowPrivate:true}]}};const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);assert.equal(await (await fetch(`http://127.0.0.1:${port}/split/Items`)).text(),'main');assert.equal(await (await fetch(`http://127.0.0.1:${port}/split/Videos/123/stream`)).text(),'play');await close(relay);await close(main);await close(play)});
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

test('emulation forces one consistent client and a stable single device across every signal',async()=>{
  const seen=[];const upstream=http.createServer((q,s)=>{seen.push({url:q.url,headers:q.headers});s.end('ok')}),up=await listen(upstream),key=deriveKey('e'.repeat(32));
  const store={data:{routes:[{id:'emu',alias:'emu',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,clientProfile:{enabled:true,userAgent:'SenPlayer/1.2.0',client:'SenPlayer',deviceName:'SenPlayer'}}]}};
  const relay=http.createServer(makeProxyHandler(store,key)),port=await listen(relay);
  await request(port,'/emu/Videos/1/stream?X-Emby-Client=Fileball&DeviceId=real-abc&api_key=keepme',{headers:{'x-emby-authorization':'MediaBrowser Client="Fileball", Device="iPhone14", DeviceId="real-abc", Version="9.9", Token="secret-token"','x-emby-client':'Fileball','x-emby-device-id':'real-abc'}});
  await request(port,'/emu/Videos/2/stream?DeviceId=other-xyz&api_key=keepme',{headers:{authorization:'MediaBrowser Client="Infuse", Device="iPad", DeviceId="other-xyz", Version="8.1", Token="tok2"','x-emby-device-id':'other-xyz'}});
  const a=seen[0],b=seen[1],id=a.headers['x-emby-device-id'];
  assert.equal(a.headers['user-agent'],'SenPlayer/1.2.0');
  assert.equal(a.headers['x-emby-client'],'SenPlayer');
  assert.equal(a.headers['x-emby-device-name'],'SenPlayer');
  assert.equal(a.headers['x-emby-client-version'],'1.2.0');
  assert.match(id,/^[0-9a-f]{32}$/);
  // the auth header's identity is rewritten but the real Token is preserved
  assert.match(a.headers['x-emby-authorization'],/Client="SenPlayer"/);
  assert.match(a.headers['x-emby-authorization'],/Device="SenPlayer"/);
  assert.match(a.headers['x-emby-authorization'],new RegExp('DeviceId="'+id+'"'));
  assert.match(a.headers['x-emby-authorization'],/Version="1.2.0"/);
  assert.match(a.headers['x-emby-authorization'],/Token="secret-token"/);
  // identity query params rewritten, api_key kept
  assert.match(a.url,/X-Emby-Client=SenPlayer/);
  assert.match(a.url,new RegExp('DeviceId='+id));
  assert.match(a.url,/api_key=keepme/);
  // a different real client still maps to the SAME device id, and its token is preserved
  assert.equal(b.headers['x-emby-device-id'],id);
  assert.match(b.headers['authorization'],/Client="SenPlayer"/);
  assert.match(b.headers['authorization'],/Token="tok2"/);
  await close(relay);await close(upstream);
});
