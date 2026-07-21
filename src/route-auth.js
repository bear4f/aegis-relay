import crypto from 'node:crypto';
import { b64u, timingEqual, tokenDigest } from './security.js';

export const ROUTE_AUTH_VERSION = 'route-hmac-sha256-v1';
export const LEGACY_ROUTE_AUTH_VERSION = 'master-hmac-sha256-v1';

export function newRouteAuthKey() {
  return b64u(crypto.randomBytes(32));
}

export function isRouteAuthKey(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

export function routeTokenDigest(token, routeAuthKey) {
  if (!isRouteAuthKey(routeAuthKey)) throw new Error('invalid routeAuthKey');
  return b64u(crypto.createHmac('sha256', Buffer.from(routeAuthKey, 'base64url')).update(String(token)).digest());
}

export function verifyRouteToken(route, suppliedToken, legacyMasterKey = null) {
  if (!route?.keyDigest) return false;
  if (route.authVersion === ROUTE_AUTH_VERSION && isRouteAuthKey(route.routeAuthKey)) {
    return timingEqual(routeTokenDigest(suppliedToken, route.routeAuthKey), route.keyDigest);
  }
  if ((!route.authVersion || route.authVersion === LEGACY_ROUTE_AUTH_VERSION) && legacyMasterKey) {
    return timingEqual(tokenDigest(String(suppliedToken), legacyMasterKey), route.keyDigest);
  }
  return false;
}
