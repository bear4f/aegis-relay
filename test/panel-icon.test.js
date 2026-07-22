import test from 'node:test';import assert from 'node:assert/strict';
import { fetchPanelIcon, MAX_ICON_BYTES, normalizePanelIcon } from '../src/panel-icon.js';

const PNG=Buffer.from('89504e470d0a1a0a','hex');
const pngUri=bytes=>`data:image/png;base64,${bytes.toString('base64')}`;

test('empty icon values normalize to the reset state',()=>{assert.equal(normalizePanelIcon(''),'');assert.equal(normalizePanelIcon(null),'');assert.equal(normalizePanelIcon('   '),'')});
test('valid image data URIs are kept and vendor icon types collapse to one canonical MIME',()=>{
  assert.equal(normalizePanelIcon(pngUri(PNG)),pngUri(PNG));
  assert.equal(normalizePanelIcon(`data:image/vnd.microsoft.icon;base64,${PNG.toString('base64')}`),`data:image/x-icon;base64,${PNG.toString('base64')}`);
});
test('non-image and malformed payloads are rejected',()=>{
  assert.throws(()=>normalizePanelIcon('https://example.com/a.png'),/base64/);
  assert.throws(()=>normalizePanelIcon(`data:text/html;base64,${PNG.toString('base64')}`),/仅支持/);
  assert.throws(()=>normalizePanelIcon('data:image/png;base64,'),/base64/);
  assert.throws(()=>normalizePanelIcon('data:image/png;base64,!!!!'),/base64/);
});
test('icons above the size limit are rejected',()=>{
  assert.throws(()=>normalizePanelIcon(pngUri(Buffer.alloc(MAX_ICON_BYTES+1))),/256KB/);
  assert.equal(typeof normalizePanelIcon(pngUri(Buffer.alloc(1024))),'string');
});
test('remote icon fetch refuses non-http targets before any network activity',async()=>{
  await assert.rejects(fetchPanelIcon('ftp://example.com/a.png'),/http/);
  await assert.rejects(fetchPanelIcon('file:///etc/passwd'),/http/);
  await assert.rejects(fetchPanelIcon('not a url'),/无效/);
  await assert.rejects(fetchPanelIcon('https://user:pass@example.com/a.png'),/账号/);
});
test('remote icon fetch refuses literal private, loopback and link-local addresses',async()=>{
  for(const target of ['http://127.0.0.1/a.png','http://10.0.0.8/a.png','http://192.168.1.1/a.png','http://169.254.169.254/latest/meta-data','http://[::1]/a.png','http://0.0.0.0/a.png'])
    await assert.rejects(fetchPanelIcon(target),/内网地址/);
});
