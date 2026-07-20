import dns from 'node:dns';
import { isPrivateIP } from './security.js';

export function guardedLookup(allowPrivate) {
  return (host, options, callback) => {
    const wantsAll = options?.all === true;
    dns.lookup(host, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const safe = allowPrivate ? addresses : addresses.filter(item => !isPrivateIP(item.address));
      if (!safe.length) return callback(new Error('upstream resolved to a blocked address'));
      if (wantsAll) return callback(null, safe);
      return callback(null, safe[0].address, safe[0].family);
    });
  };
}
