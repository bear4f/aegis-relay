import test from 'node:test';
import assert from 'node:assert/strict';
import { isRouteAuthKey, matchRouteChannel, newRouteAuthKey, ROUTE_AUTH_VERSION, routeChannels, routeTokenDigest, verifyRouteToken } from '../src/route-auth.js';

test('multiple distribution channels each unlock the node and are attributed to their own key', () => {
  const primary=newRouteAuthKey(), userKey=newRouteAuthKey();
  const route={ authVersion:ROUTE_AUTH_VERSION, routeAuthKey:primary, keyDigest:routeTokenDigest('owner-key',primary),
    channels:[{ id:'ch-xm', label:'小明', authVersion:ROUTE_AUTH_VERSION, routeAuthKey:userKey, keyDigest:routeTokenDigest('xiaoming-key',userKey) }] };
  // both the default (owner) key and the extra channel key are accepted
  assert.equal(verifyRouteToken(route,'owner-key'),true);
  assert.equal(verifyRouteToken(route,'xiaoming-key'),true);
  assert.equal(verifyRouteToken(route,'wrong-key'),false);
  // and each is attributed to the right channel id
  assert.equal(matchRouteChannel(route,'owner-key').id,'default');
  assert.equal(matchRouteChannel(route,'xiaoming-key').id,'ch-xm');
  assert.equal(matchRouteChannel(route,'nope'),null);
  // legacy single-key node still surfaces as one default channel
  assert.equal(routeChannels({keyDigest:routeTokenDigest('k',primary),routeAuthKey:primary,authVersion:ROUTE_AUTH_VERSION})[0].id,'default');
});

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
