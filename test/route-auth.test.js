import test from 'node:test';
import assert from 'node:assert/strict';
import { isRouteAuthKey, newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest, verifyRouteToken } from '../src/route-auth.js';

test('route authentication keys are independent 256-bit secrets', () => {
  const first=newRouteAuthKey(),second=newRouteAuthKey();
  assert.equal(isRouteAuthKey(first),true);
  assert.equal(Buffer.from(first,'base64url').length,32);
  assert.notEqual(first,second);
  assert.equal(routeTokenDigest('client-key',first),routeTokenDigest('client-key',first));
  assert.notEqual(routeTokenDigest('client-key',first),routeTokenDigest('client-key',second));
  assert.equal(verifyRouteToken({authVersion:ROUTE_AUTH_VERSION,routeAuthKey:first,keyDigest:routeTokenDigest('client-key',first)},'client-key'),true);
});

test('malformed route authentication keys are rejected', () => {
  assert.equal(isRouteAuthKey('short'),false);
  assert.throws(()=>routeTokenDigest('client-key','short'),/invalid routeAuthKey/);
});
