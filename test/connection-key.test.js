import test from 'node:test';
import assert from 'node:assert/strict';
import { customConnectionKey } from '../src/connection-key.js';

test('custom connection keys are URL-safe or left empty for random generation', () => {
  assert.equal(customConnectionKey(''), '');
  assert.equal(customConnectionKey('  My_key-2026  '), 'My_key-2026');
  for (const value of ['short', '含有中文的密码', 'spaces are unsafe', 'a'.repeat(65)]) assert.throws(() => customConnectionKey(value));
});
