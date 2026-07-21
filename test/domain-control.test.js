import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeLocalDomain, domainRequestRole, DOMAIN_REQUEST_FILE, readDomainStatus, requestDomainSwitch } from '../src/domain-control.js';

test('active local domain prefers the separated data plane and validates bare HTTPS origins',()=>{
  assert.equal(activeLocalDomain({localProxyBaseUrl:'https://embyus.example.com',publicBaseUrl:'https://panel.example.com'}),'embyus.example.com');
  assert.equal(activeLocalDomain({publicBaseUrl:'https://panel.example.com'}),'panel.example.com');
  assert.equal(activeLocalDomain({localProxyBaseUrl:'http://bad.example.com',publicBaseUrl:'https://panel.example.com/path'}),'');
});

test('split-domain routing rejects old proxy names and unrelated subdomains',()=>{
  const input={panelHostname:'emby.example.com',proxyHostname:'embyus.example.com'};
  assert.equal(domainRequestRole({...input,requestHostname:'emby.example.com'}),'control');
  assert.equal(domainRequestRole({...input,requestHostname:'embyus.example.com'}),'proxy');
  assert.equal(domainRequestRole({...input,requestHostname:'old.example.com'}),'reject');
  assert.equal(domainRequestRole({...input,requestHostname:'xx.example.com'}),'reject');
  assert.equal(domainRequestRole({panelHostname:'emby.example.com',proxyHostname:'emby.example.com',requestHostname:'xx.example.com'}),'legacy');
});

test('domain switch writes a constrained atomic host request and readable pending status',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-domain-')),dataFile=path.join(dir,'aegis.enc.json');
  try{
    const status=requestDomainSwitch({dataFile,domain:'EmbyUS.Example.com',email:'Admin@Example.com',currentDomain:'old.example.com'});
    assert.equal(status.state,'pending');
    const request=JSON.parse(fs.readFileSync(path.join(dir,DOMAIN_REQUEST_FILE),'utf8'));
    assert.equal(request.desiredDomain,'embyus.example.com');
    assert.equal(request.certificateEmail,'admin@example.com');
    assert.deepEqual(readDomainStatus(dataFile),status);
    assert.throws(()=>requestDomainSwitch({dataFile,domain:'panel.example.com/x',email:'admin@example.com'}));
    assert.throws(()=>requestDomainSwitch({dataFile,domain:'panel.example.com:8443',email:'admin@example.com'}));
    assert.throws(()=>requestDomainSwitch({dataFile,domain:'bad_domain.example.com',email:'admin@example.com'}));
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
