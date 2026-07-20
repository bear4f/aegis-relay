import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedLookup } from '../src/lookup.js';

function lookup(host, options) {
  return new Promise((resolve, reject) => guardedLookup(true)(host, options, (error, address, family) => {
    if (error) reject(error); else resolve({ address, family });
  }));
}

test('guarded DNS lookup honors Node 22 all-address callbacks', async () => {
  const many = await lookup('localhost', { all: true });
  assert.ok(Array.isArray(many.address));
  assert.ok(many.address.length >= 1);
  assert.ok(many.address.every(item => typeof item.address === 'string' && [4, 6].includes(item.family)));

  const one = await lookup('localhost', { all: false });
  assert.equal(typeof one.address, 'string');
  assert.ok([4, 6].includes(one.family));
});
