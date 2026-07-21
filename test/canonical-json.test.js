import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/canonical-json.js';

test('canonical JSON recursively sorts keys and fixes separators', () => {
  const value={z:1,a:{é:'utf8',b:true,a:null},list:[{y:2,x:'v'},-0]};
  assert.equal(canonicalJson(value),'{"a":{"a":null,"b":true,"é":"utf8"},"list":[{"x":"v","y":2},0],"z":1}');
  assert.equal(canonicalJson({list:[{x:'v',y:2},0],a:{a:null,b:true,é:'utf8'},z:1}),canonicalJson(value));
});

test('canonical JSON rejects values that would serialize ambiguously', () => {
  assert.throws(()=>canonicalJson({value:undefined}),/does not support undefined/);
  assert.throws(()=>canonicalJson({value:Number.NaN}),/finite numbers/);
  assert.throws(()=>canonicalJson(new Date()),/plain objects/);
  assert.throws(()=>canonicalJson({[Symbol('hidden')]:true}),/symbol keys/);
  const cyclic={};cyclic.self=cyclic;
  assert.throws(()=>canonicalJson(cyclic),/cycles/);
  const sparse=[];sparse.length=1;
  assert.throws(()=>canonicalJson(sparse),/sparse arrays/);
});
