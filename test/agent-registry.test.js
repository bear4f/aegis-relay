import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAgentRegistry, normalizeAgentDomain, publicAgent, replaceAgentDeployments, routesForAgent } from '../src/agent-registry.js';

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
