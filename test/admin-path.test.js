import test from 'node:test';
import assert from 'node:assert/strict';
import { adminRelative, isRootAdminRequest, normalizeAdminPath } from '../src/admin-path.js';

test('root domain exposes only the admin shell, assets and API namespace', () => {
  for (const path of ['/', '/index.html', '/app.js', '/style.css', '/help.css', '/api/status', '/api/routes']) assert.equal(isRootAdminRequest(path), true);
  for (const path of ['/charity/key/System/Info', '/gateway/', '/api-node/key/']) assert.equal(isRootAdminRequest(path), false);
});

test('legacy random admin paths remain compatible', () => {
  assert.equal(normalizeAdminPath('admin-secret'), '/admin-secret');
  assert.equal(normalizeAdminPath('/admin-secret/'), '/admin-secret');
  assert.equal(normalizeAdminPath(''), '/');
  assert.equal(adminRelative('/admin-secret/api/status', '/admin-secret'), '/api/status');
  assert.equal(adminRelative('/other/api/status', '/admin-secret'), null);
  assert.equal(adminRelative('/api/status', '/'), '/api/status');
});
