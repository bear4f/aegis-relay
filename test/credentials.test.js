import test from 'node:test';
import assert from 'node:assert/strict';
import { clientCredentials, savedCredentials } from '../src/credentials.js';

test('protected client credentials remain available to an authenticated administrator', () => {
  const route = { alias: 'family', accessMode: 'key', accessKey: 'secret-key' };
  assert.deepEqual(savedCredentials(route), {
    available: true,
    accessKey: 'secret-key',
    clientPath: '/family/secret-key/'
  });
});

test('legacy digest-only nodes request one rotation before credentials can be viewed', () => {
  assert.deepEqual(savedCredentials({ alias: 'legacy', accessMode: 'key' }), {
    available: false,
    requiresRotation: true
  });
  assert.deepEqual(clientCredentials({ alias: 'public' }, ''), { clientPath: '/public/' });
});
