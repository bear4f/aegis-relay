import http from 'node:http';
import https from 'node:https';
import { guardedLookup } from './lookup.js';

function probeError(error) {
  const code=String(error?.code||''),message=String(error?.message||'').toLowerCase();
  if(code==='ECONNRESET'||message.includes('aborted')||message.includes('socket hang up'))return'上游响应中途断开';
  if(code==='ETIMEDOUT'||message.includes('timeout'))return'上游连接超时';
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')return'上游域名解析失败';
  if(code==='ECONNREFUSED')return'上游拒绝连接';
  if(code.includes('CERT')||message.includes('certificate')||message.includes('self-signed'))return'上游 TLS 证书验证失败';
  if(message.includes('blocked address'))return'上游解析到受保护地址，请确认“内网上游”设置';
  return'上游探测失败';
}

export function probe(value,{allowPrivate=false,tlsVerify=true,timeout=8000}={}){
  return new Promise(resolve=>{const started=Date.now(),url=new URL(value),transport=url.protocol==='https:'?https:http;let settled=false;
    const finish=result=>{if(settled)return;settled=true;resolve({target:'[encrypted upstream]',latencyMs:Date.now()-started,...result})};
    const req=transport.request({protocol:url.protocol,hostname:url.hostname,port:url.port,path:(url.pathname.replace(/\/$/,'')||'')+'/System/Info/Public',method:'GET',headers:{accept:'application/json','user-agent':'AegisRelay-Diagnostics/1'},timeout,rejectUnauthorized:tlsVerify,lookup:guardedLookup(allowPrivate)},res=>{let version='',body='';const status=res.statusCode||0;res.setEncoding('utf8');res.on('data',c=>{if(body.length<4096)body+=c});res.on('aborted',()=>finish({online:false,status,error:'上游响应中途断开'}));res.on('error',err=>finish({online:false,status,error:probeError(err)}));res.on('end',()=>{try{version=JSON.parse(body).Version||''}catch{}let cert;try{cert=res.socket?.getPeerCertificate?.()}catch{}finish({online:status<500,status,embyVersion:version,tls:url.protocol==='https:'?{authorized:res.socket?.authorized===true,issuer:cert?.issuer?.O||cert?.issuer?.CN||'',validTo:cert?.valid_to||''}:null})})});
    req.on('timeout',()=>req.destroy(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})));req.on('error',err=>finish({online:false,error:probeError(err)}));req.end();
  });
}

export async function diagnoseRoute(route){const main=route.upstreams?.length?route.upstreams:(route.upstream?[route.upstream]:[]),playback=route.playbackUpstreams?.length?route.playbackUpstreams:main;const options={allowPrivate:route.allowPrivate,tlsVerify:route.tlsVerify!==false};return{node:{id:route.id,alias:route.alias,name:route.name},main:await Promise.all(main.map(x=>probe(x,options))),playback:playback===main?null:await Promise.all(playback.map(x=>probe(x,options))),headerPreview:route.clientProfile?.enabled?{userAgent:route.clientProfile.userAgent||'',client:route.clientProfile.client||'',deviceName:route.clientProfile.deviceName||'',deviceId:route.clientProfile.deviceId?'[configured]':''}:{mode:'pass-through'}}}
