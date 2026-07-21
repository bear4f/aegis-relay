import dns from 'node:dns';
import { isPrivateIP } from './security.js';

// Nginx keeps resolved upstreams for `valid=60s`. Without an equivalent, every new connection paid a
// DNS round trip, which hurts most exactly when playback starts and many sockets open at once.
const TTL_MS = 60_000;
const MAX_ENTRIES = 512;
const cache = new Map();

function prune(now) {
  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  if (cache.size > MAX_ENTRIES) for (const key of [...cache.keys()].slice(0, cache.size - MAX_ENTRIES)) cache.delete(key);
}

export function guardedLookup(allowPrivate) {
  return (host, options, callback) => {
    const wantsAll = options?.all === true;
    const key = `${host}\0${options?.family || 0}`;
    // The blocked-address check stays on every call; only the resolution itself is reused.
    const deliver = addresses => {
      const safe = allowPrivate ? addresses : addresses.filter(item => !isPrivateIP(item.address));
      if (!safe.length) return callback(new Error('upstream resolved to a blocked address'));
      return wantsAll ? callback(null, safe) : callback(null, safe[0].address, safe[0].family);
    };
    const now = Date.now(), hit = cache.get(key);
    // Stay asynchronous on a cache hit: net.connect always sees dns.lookup call back on a later
    // tick, and handing it a synchronous callback is a reentrancy risk for no gain.
    if (hit && hit.expires > now) return process.nextTick(() => deliver(hit.addresses));
    dns.lookup(host, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      cache.set(key, { expires: now + TTL_MS, addresses });
      if (cache.size > MAX_ENTRIES) prune(now);
      deliver(addresses);
    });
  };
}

export function clearLookupCache() { cache.clear(); }
