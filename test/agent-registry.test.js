import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { agentEntryUrl, ensureAgentRegistry, normalizeAgentDomain, publicAgent, replaceAgentDeployments, routeEntryBaseUrl, routesForAgent } from '../src/agent-registry.js';

const routes=[
  {id:'route-a',alias:'alpha',name:'Alpha'},
  {id:'route-b',alias:'beta',name:'Beta'}
];

test('schema migration registers local agent and deploys every existing route without changing routes', () => {
  const data={routes:structuredClone(routes)},before=structuredClone(routes);
  const result=ensureAgentRegistry(data,'2026-07-21T00:00:00.000Z',{deployAllLocal:true});
  assert.equal(result.changed,true);
  assert.equal(data.agents.length,1);
  assert.equal(data.agents[0].id,'local');
  assert.deepEqual(routesForAgent(data,'local'),before);
  assert.deepEqual(data.routes,before);
});

test('agent domains are HTTPS authorities and deployments are independently selectable', () => {
  const data={routes:structuredClone(routes),agents:[{id:'local'}],deployments:[]};
  assert.equal(normalizeAgentDomain('HK.Example.com'),'hk.example.com');
  assert.equal(normalizeAgentDomain('https://jp.example.com'),'jp.example.com');
  assert.equal(normalizeAgentDomain(''),'');
  assert.throws(()=>normalizeAgentDomain('http://insecure.example.com'),/bare HTTPS host/);
  assert.throws(()=>normalizeAgentDomain('https://example.com/path'),/bare HTTPS host/);
  replaceAgentDeployments(data,'local',['route-b']);
  assert.deepEqual(routesForAgent(data,'local').map(route=>route.id),['route-b']);
});

test('an uninstalled remote agent remains visible as offline until manually deleted', () => {
  const data={routes:[],deployments:[]},agent={id:'remote-1',name:'HK',transport:'poll',lastSeen:'2026-07-21T00:00:00.000Z'};
  const view=publicAgent(agent,data,null,new Date('2026-07-21T00:10:00.000Z').getTime());
  assert.equal(view.status,'offline');
  assert.equal(view.canDelete,true);
});

test("a node's client address follows the remote agent it is deployed to, not the panel domain", () => {
  const data={
    routes:[{id:'r1',alias:'xqhk'}],
    agents:[
      {id:'local',name:'本地 Agent'},
      {id:'hk',name:'HK-SIM',proxyMode:'domain',domain:'hk.emby.edenflix.cc'},
      {id:'us',name:'US-IP',proxyMode:'ip',domain:'203.0.113.7'}
    ],
    deployments:[
      {agentId:'local',routeId:'r1',enabled:true},
      {agentId:'hk',routeId:'r1',enabled:true}
    ]
  };
  const panel='https://emby.edenflix.cc';
  // deployed to the HK domain agent → distributed on that agent's HTTPS domain, not the panel
  assert.equal(routeEntryBaseUrl(data,'r1',panel),'https://hk.emby.edenflix.cc');
  // an IP-mode agent is reached over plain HTTP on its public IP
  assert.equal(agentEntryUrl(data.agents[2]),'http://203.0.113.7');
  // the local agent and unknown hosts never override the panel fallback
  assert.equal(agentEntryUrl(data.agents[0]),'');
  assert.equal(routeEntryBaseUrl({...data,deployments:[{agentId:'local',routeId:'r1',enabled:true}]},'r1',panel),panel);
  // a disabled remote deployment does not hijack the address
  assert.equal(routeEntryBaseUrl({...data,deployments:[{agentId:'hk',routeId:'r1',enabled:false}]},'r1',panel),panel);
});

test('agents expose a sort order so the panel can reorder machines', () => {
  const data={routes:[],deployments:[]};
  assert.equal(publicAgent({id:'a',name:'HK',sortOrder:20},data).sortOrder,20);
  // machines registered before this feature default to 0 and, because the panel sorts stably,
  // keep their existing registration order until someone actually moves one
  assert.equal(publicAgent({id:'b',name:'US'},data).sortOrder,0);
  const order=[{id:'c',sortOrder:30},{id:'a',sortOrder:10},{id:'b',sortOrder:20}]
    .map(a=>publicAgent(a,data)).sort((x,y)=>x.sortOrder-y.sortOrder).map(a=>a.id);
  assert.deepEqual(order,['a','b','c']);
});

// A remote machine only learns about a config change on its next heartbeat, so the panel must (a) stop
// claiming 「配置已同步」 the moment deployments change and (b) keep that heartbeat short. Without (a)
// the card looked identical before and after de-selecting a node while the machine kept serving it —
// the change read as "点了没反应". Regression cover for both halves.
import { AgentApi } from '../src/agent-api.js';

function fakePanel(){
  const data={
    routes:structuredClone(routes).map(r=>({...r,accessMode:'alias_only',upstreams:['https://emby.example.com'],enabled:true})),
    agents:[{id:'local',name:'本地 Agent',transport:'loopback'},
            {id:'remote-1',name:'香港探针',transport:'poll',domain:'hk.example.com',state:'active',appliedRevision:0},
            {id:'gone',name:'已撤销',transport:'poll',state:'revoked'}],
    deployments:[],settings:{},audit:[],controlPlane:{}
  };
  const store={data,save(){},audit(){}};
  return {store,api:new AgentApi({store,version:'0.0.0-test'}),data};
}

test('changing an agent deployment immediately raises its desired revision', () => {
  const {store,api,data}=fakePanel();
  const remote=data.agents.find(a=>a.id==='remote-1');
  api.invalidate();
  const base=Number(remote.desiredRevision);
  assert.ok(base>=1,'a registered machine must have a desired revision');
  // the machine reports it has applied what the panel currently wants
  remote.appliedRevision=base;

  replaceAgentDeployments(store.data,'remote-1',['route-a','route-b']);
  api.invalidate();
  assert.ok(Number(remote.desiredRevision)>base,'adding nodes must bump the desired revision at once');
  assert.notEqual(Number(remote.desiredRevision),Number(remote.appliedRevision),'the card must read 等待同步, not 配置已同步');

  const added=Number(remote.desiredRevision);
  remote.appliedRevision=added;
  // the reported bug: de-selecting ONE node of several
  replaceAgentDeployments(store.data,'remote-1',['route-a']);
  api.invalidate();
  assert.deepEqual(routesForAgent(store.data,'remote-1').map(r=>r.id),['route-a']);
  assert.ok(Number(remote.desiredRevision)>added,'removing a node must bump the desired revision too');
  assert.notEqual(Number(remote.desiredRevision),Number(remote.appliedRevision));
});

test('a revoked machine is skipped and never blocks the others', () => {
  const {api,data}=fakePanel();
  api.invalidate();
  assert.equal(data.agents.find(a=>a.id==='gone').desiredRevision,undefined);
  assert.ok(Number(data.agents.find(a=>a.id==='remote-1').desiredRevision)>=1);
});

test('a machine with un-applied configuration is asked to check back sooner', () => {
  const source=fs.readFileSync(new URL('../src/agent-api.js',import.meta.url),'utf8');
  const beat=source.match(/heartbeatSeconds:[^,]+/);
  assert.ok(beat,'check-in must send a heartbeat interval');
  assert.ok(source.includes('heartbeatSeconds:pendingConfig?5:10'),'pending config gets a 5s beat, idle machines 10s');
  assert.match(source,/const pendingConfig=snapshot\.revision>Number\(agent\.appliedRevision\|\|0\)/);
  // 30s was long enough that a de-selected node looked like it had not been removed at all
  assert.doesNotMatch(source,/heartbeatSeconds:30/);
});
