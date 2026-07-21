import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { AgentApi, agentRequestInput, consumeEnrollment, enrollmentDigest, enrollmentInstallCommand, issueEnrollment, panelResponseInput } from '../src/agent-api.js';
import { openAgentSnapshot } from '../src/agent-config.js';

const publicDer=key=>key.export({format:'der',type:'spki'}).toString('base64url');

test('enrollment tokens are short-lived digests, single use, and create selected deployments',()=>{
  const data={routes:[{id:'route-a'},{id:'route-b'}],agents:[],deployments:[],enrollmentTokens:[]},now=Date.parse('2026-07-21T08:00:00Z');
  const issued=issueEnrollment(data,{name:'Hong Kong 01',domain:'HK.Example.com',routeIds:['route-b'],now});
  assert.equal(data.enrollmentTokens[0].digest,enrollmentDigest(issued.token));
  assert.equal(JSON.stringify(data).includes(issued.token),false);
  assert.equal(issued.record.domain,'hk.example.com');
  assert.equal(new Date(issued.record.expiresAt).getTime()-now,10*60_000);
  const sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519');
  const agent=consumeEnrollment(data,issued.token,{signPublicKey:publicDer(sign.publicKey),boxPublicKey:publicDer(box.publicKey),agentVersion:'0.5.0',capabilities:['registry-v1'],machine:{hostname:'relay-hk'}},now+1);
  assert.equal(agent.name,'Hong Kong 01');
  assert.equal(agent.domain,'hk.example.com');
  assert.deepEqual(data.deployments.map(item=>item.routeId),['route-b']);
  assert.equal(issued.record.digest,undefined);
  assert.throws(()=>consumeEnrollment(data,issued.token,{signPublicKey:'x',boxPublicKey:'x'},now+2),/无效、已使用或已过期/);
});

test('install command uses the HTTPS panel origin and safely quotes names',()=>{
  const command=enrollmentInstallCommand({publicBaseUrl:'https://panel.example.com',token:'secret-token',name:"HK relay's 01",domain:'hk.example.com'});
  assert.match(command,/https:\/\/panel\.example\.com\/agent-install\.sh/);
  assert.match(command,/--token 'secret-token'/);
  assert.match(command,/HK relay'"'"'s 01/);
  assert.throws(()=>enrollmentInstallCommand({publicBaseUrl:'http://panel.example.com',token:'x',name:'HK'}),/HTTPS/);
});

test('agent and panel signature inputs are fixed LF-delimited protocol strings',()=>{
  assert.equal(agentRequestInput({method:'post',path:'/api/agent/v1/check-in',agentId:'a',timestamp:1,nonce:'n',contentHash:'h'}),'AegisRelay-Agent-Request-v1\nPOST\n/api/agent/v1/check-in\na\n1\nn\nh');
  assert.equal(panelResponseInput({status:200,requestNonce:'n',timestamp:2,contentHash:'h'}),'AegisRelay-Panel-Response-v1\n200\nn\n2\nh');
});

function request(url,body,headers={},method='POST'){const req=Readable.from([Buffer.from(body)]);req.url=url;req.method=method;req.headers=headers;req.socket={remoteAddress:'127.0.0.1'};return req;}
function response(){return{status:0,headers:{},raw:Buffer.alloc(0),writeHead(status,headers){this.status=status;this.headers=headers},end(raw){this.raw=Buffer.from(raw||'')}}}
function signedHeaders({method,path,agentId,privateKey,body,nonce}){const timestamp=Math.floor(Date.now()/1000),contentHash=crypto.createHash('sha256').update(body).digest('base64url'),signature=crypto.sign(null,Buffer.from(agentRequestInput({method,path,agentId,timestamp,nonce,contentHash})),privateKey).toString('base64url');return{'x-aegis-agent-id':agentId,'x-aegis-timestamp':String(timestamp),'x-aegis-nonce':nonce,'x-aegis-content-sha256':contentHash,'x-aegis-signature':signature}}

test('signed check-in updates an enrolled agent and rejects a replayed nonce',async()=>{
  const data={routes:[],agents:[],deployments:[],enrollmentTokens:[],controlPlane:{}},store={data,save(){},audit(){}};
  const api=new AgentApi({store,version:'0.5.0'}),issued=issueEnrollment(data,{name:'JP 01'}),sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519'),requestNonce='enrollment-request-nonce';
  const enrollBody=JSON.stringify({protocolVersion:1,requestNonce,token:issued.token,agent:{signPublicKey:publicDer(sign.publicKey),boxPublicKey:publicDer(box.publicKey),agentVersion:'0.5.0',capabilities:['registry-v1']},machine:{hostname:'jp'}}),enrollResponse=response();
  await api.handle(request('/api/agent/v1/enroll',enrollBody,{'content-type':'application/json'}),enrollResponse);
  assert.equal(enrollResponse.status,201);const enrolled=JSON.parse(enrollResponse.raw),body=Buffer.from(JSON.stringify({agentVersion:'0.5.0',currentRevision:0,applyState:'waiting',proxyHealthy:false,domain:'jp.example.com',capabilities:['registry-v1']})),timestamp=Math.floor(Date.now()/1000),nonce='0123456789abcdefghijkl',contentHash=crypto.createHash('sha256').update(body).digest('base64url'),signature=crypto.sign(null,Buffer.from(agentRequestInput({method:'POST',path:'/api/agent/v1/check-in',agentId:enrolled.agentId,timestamp,nonce,contentHash})),sign.privateKey).toString('base64url'),headers={'content-type':'application/json','x-aegis-agent-id':enrolled.agentId,'x-aegis-timestamp':String(timestamp),'x-aegis-nonce':nonce,'x-aegis-content-sha256':contentHash,'x-aegis-signature':signature};
  const first=response();await api.handle(request('/api/agent/v1/check-in',body,headers),first);assert.equal(first.status,200);assert.equal(data.agents[0].reportedDomain,'jp.example.com');assert.ok(data.agents[0].lastSeen);
  const replay=response();await api.handle(request('/api/agent/v1/check-in',body,headers),replay);assert.equal(replay.status,409);assert.match(replay.raw.toString(),/nonce/);
});

test('selected routes flow through encrypted config pull and applied ACK',async()=>{
  const route={id:'route-a',alias:'alpha',name:'Alpha',enabled:true,upstreams:['https://origin.example.com'],playbackUpstreams:[],allowPrivate:false,tlsVerify:true,showOnHome:false,clientProfile:{enabled:false},speedLimitMbps:0,monthlyQuotaGB:0,accessMode:'alias_only'},data={routes:[route],agents:[],deployments:[],enrollmentTokens:[],controlPlane:{}},store={data,save(){},audit(){}};
  const api=new AgentApi({store,version:'0.6.0'}),issued=issueEnrollment(data,{name:'HK proxy',routeIds:['route-a']}),sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519'),enrollBody=JSON.stringify({protocolVersion:1,requestNonce:'enrollment-config-nonce',token:issued.token,agent:{signPublicKey:publicDer(sign.publicKey),boxPublicKey:publicDer(box.publicKey),agentVersion:'0.6.0',capabilities:['config-v1','proxy-v1']},machine:{hostname:'hk'}}),enrollResponse=response();
  await api.handle(request('/api/agent/v1/enroll',enrollBody),enrollResponse);const enrolled=JSON.parse(enrollResponse.raw),checkBody=Buffer.from(JSON.stringify({agentVersion:'0.6.0',currentRevision:0,applyState:'waiting',proxyHealthy:true,domain:'hk.example.com',capabilities:['config-v1','proxy-v1']})),checkPath='/api/agent/v1/check-in',checkResponse=response();
  await api.handle(request(checkPath,checkBody,signedHeaders({method:'POST',path:checkPath,agentId:enrolled.agentId,privateKey:sign.privateKey,body:checkBody,nonce:'checkin-config-nonce-01'})),checkResponse);assert.equal(checkResponse.status,200);assert.equal(JSON.parse(checkResponse.raw).desiredRevision,1);
  const configPath='/api/agent/v1/config?after=0&wait=0',empty=Buffer.alloc(0),configResponse=response();await api.handle(request(configPath,empty,signedHeaders({method:'GET',path:configPath,agentId:enrolled.agentId,privateKey:sign.privateKey,body:empty,nonce:'config-request-nonce-01'}),'GET'),configResponse);assert.equal(configResponse.status,200);
  const snapshot=openAgentSnapshot({envelope:JSON.parse(configResponse.raw),identity:{agentId:enrolled.agentId,boxPrivateKey:box.privateKey.export({format:'der',type:'pkcs8'}).toString('base64url'),panelKeyId:enrolled.panelKeyId,panelSigningPublicKey:enrolled.panelSigningPublicKey}});assert.equal(snapshot.revision,1);assert.deepEqual(snapshot.nodes.map(node=>node.alias),['alpha']);
  const ackPath='/api/agent/v1/ack',ackBody=Buffer.from(JSON.stringify({revision:snapshot.revision,hash:snapshot.hash,status:'applied',proxyHealthy:true})),ackResponse=response();await api.handle(request(ackPath,ackBody,signedHeaders({method:'POST',path:ackPath,agentId:enrolled.agentId,privateKey:sign.privateKey,body:ackBody,nonce:'config-acknowledge-01'})),ackResponse);assert.equal(ackResponse.status,200);assert.equal(data.agents[0].appliedRevision,1);assert.equal(data.agents[0].applyState,'active');
});
