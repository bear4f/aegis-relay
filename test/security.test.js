import test from 'node:test';import assert from 'node:assert/strict';
import {deriveKey,hashPassword,verifyPassword,newTotpSecret,totp,verifyTotp,isPrivateIP,cleanAlias,tokenDigest} from '../src/security.js';
test('password hashes are salted and verifiable',()=>{const a=hashPassword('a very long password!'),b=hashPassword('a very long password!');assert.notEqual(a,b);assert.equal(verifyPassword('a very long password!',a),true);assert.equal(verifyPassword('wrong password here',a),false)});
test('TOTP follows RFC 6238 SHA1 vector',()=>{assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',59000),'287082');assert.equal(verifyTotp(newTotpSecret(),'000000',0),false)});
test('private address detection covers common ranges',()=>{for(const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.2','::1','fd00::1'])assert.equal(isPrivateIP(ip),true);assert.equal(isPrivateIP('1.1.1.1'),false)});
test('aliases and keyed token digests',()=>{assert.equal(cleanAlias('media-1'),'media-1');assert.throws(()=>cleanAlias('../x'));const k=deriveKey('x'.repeat(32));assert.equal(tokenDigest('a',k),tokenDigest('a',k));assert.notEqual(tokenDigest('a',k),tokenDigest('b',k))});
