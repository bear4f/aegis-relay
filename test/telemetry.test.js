import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTelemetry, sanitizeTelemetry, telemetryFromMetrics } from '../src/telemetry.js';

test('agent telemetry is bounded and totals are recomputed from node counters',()=>{
  const telemetry=sanitizeTelemetry({totalBytes:999999,nodes:[{id:'route-a',alias:'alpha',name:'Alpha',requests:3,playbackRequests:2,bytesIn:12,bytesOut:1200,monthBytes:800,active:1,errors:-4,upstream:'must-not-pass'}],daily:{'2026-07-21':1200,'invalid':9}});
  assert.equal(telemetry.totalBytes,1200);assert.equal(telemetry.totalRequests,3);assert.equal(telemetry.errors,0);assert.deepEqual(telemetry.daily,{'2026-07-21':1200});assert.equal('upstream' in telemetry.nodes[0],false);
});

test('telemetry carries per-node viewers and distinct counts, capped and cleaned',()=>{
  const many=Array.from({length:80},(_,i)=>({ip:`10.0.0.${i}`,deviceName:'x\ny',client:'c',deviceId:`d${i}`,ua:'u',firstSeen:1,lastSeen:i,hits:i+1}));
  const telemetry=sanitizeTelemetry({nodes:[{id:'n',alias:'a',name:'N',distinctIps:80,distinctDevices:80,viewers:many}]});
  const node=telemetry.nodes[0];
  assert.equal(node.distinctIps,80);
  assert.equal(node.viewers.length,50); // capped to the report cap
  assert.equal(node.viewers[0].deviceName,'xy'); // newline stripped
  assert.equal(node.viewers[0].ip,'10.0.0.0');
});

test('control plane aggregates daily and per-machine traffic without double counting',()=>{
  const first=telemetryFromMetrics({startedAt:'2026-07-20T00:00:00Z',nodes:[{id:'local',requests:2,playbackRequests:1,bytesOut:100,monthBytes:100,active:0}],daily:{'2026-07-21':100}}),second=sanitizeTelemetry({nodes:[{id:'remote',requests:4,playbackRequests:3,bytesOut:250,monthBytes:200,active:1}],daily:{'2026-07-21':250}}),all=aggregateTelemetry([first,second]);
  assert.equal(all.totalBytes,350);assert.equal(all.monthBytes,300);assert.equal(all.totalRequests,6);assert.equal(all.playbackRequests,4);assert.equal(all.active,1);assert.equal(all.daily['2026-07-21'],350);
});
