import fs from 'node:fs';
import path from 'node:path';
import { randomToken } from './security.js';
import { normalizeAgentDomain } from './agent-registry.js';

const REQUEST_FILE='host-domain-request.json';
const STATUS_FILE='host-domain-status.json';

function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function atomicJson(file,value){
  const dir=path.dirname(file),tmp=path.join(dir,`.${path.basename(file)}.${process.pid}.${randomToken(6)}.tmp`);
  fs.mkdirSync(dir,{recursive:true});
  const fd=fs.openSync(tmp,'wx',0o600);
  try{fs.writeFileSync(fd,`${JSON.stringify(value)}\n`);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  fs.renameSync(tmp,file);
}

export function baseHostname(value){
  if(!value)return'';
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&url.pathname==='/'&&!url.search&&!url.hash?url.hostname.toLowerCase():''}catch{return''}
}

export function activeLocalDomain({localProxyBaseUrl='',publicBaseUrl=''}){
  return baseHostname(localProxyBaseUrl)||baseHostname(publicBaseUrl);
}

export function domainRequestRole({panelHostname='',proxyHostname='',requestHostname=''}){
  const panel=String(panelHostname).toLowerCase(),proxy=String(proxyHostname).toLowerCase(),request=String(requestHostname).toLowerCase();
  if(!panel||!proxy||panel===proxy)return'legacy';
  if(request===panel)return'control';
  if(request===proxy)return'proxy';
  return'reject';
}

export function readDomainStatus(dataFile){
  const value=readJson(path.join(path.dirname(dataFile),STATUS_FILE));
  if(!value||typeof value!=='object')return null;
  return {
    requestId:String(value.requestId||'').slice(0,80),
    state:['pending','applying','active','failed'].includes(value.state)?value.state:'failed',
    mode:value.mode==='ip'?'ip':'domain',
    desiredDomain:String(value.desiredDomain||'').slice(0,253),
    currentDomain:String(value.currentDomain||'').slice(0,253),
    message:String(value.message||'').slice(0,500),
    updatedAt:String(value.updatedAt||'').slice(0,40)
  };
}

export function requestDomainSwitch({dataFile,domain,email,currentDomain=''}){
  const desiredDomain=normalizeAgentDomain(domain),certificateEmail=String(email||'').trim().toLowerCase();
  if(!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(desiredDomain))throw new Error('代理域名必须是未携带端口或路径的完整 DNS 域名');
  if(!certificateEmail)throw new Error('请先在部署向导保存统一证书邮箱');
  if(!/^[^\s@]+@[^\s@]+$/.test(certificateEmail)||certificateEmail.length>254)throw new Error('证书邮箱格式无效');
  const requestId=randomToken(18),requestedAt=new Date().toISOString(),dir=path.dirname(dataFile);
  const request={version:1,requestId,mode:'domain',desiredDomain,certificateEmail,requestedAt};
  const status={requestId,state:'pending',mode:'domain',desiredDomain,currentDomain,message:'等待主机申请证书并切换 Nginx',updatedAt:requestedAt};
  atomicJson(path.join(dir,STATUS_FILE),status);
  atomicJson(path.join(dir,REQUEST_FILE),request);
  return status;
}

export const DOMAIN_REQUEST_FILE=REQUEST_FILE;
export const DOMAIN_STATUS_FILE=STATUS_FILE;
