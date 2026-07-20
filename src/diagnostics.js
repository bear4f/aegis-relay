import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { isPrivateIP } from './security.js';

function guardedLookup(allowPrivate){return(host,opts,cb)=>dns.lookup(host,{...opts,all:true},(err,list)=>{if(err)return cb(err);const safe=allowPrivate?list:list.filter(x=>!isPrivateIP(x.address));if(!safe.length)return cb(new Error('resolved address is blocked'));cb(null,safe[0].address,safe[0].family)})}

export function probe(value,{allowPrivate=false,tlsVerify=true,timeout=8000}={}){
  return new Promise(resolve=>{const started=Date.now(),url=new URL(value),transport=url.protocol==='https:'?https:http;let settled=false;
    const finish=result=>{if(settled)return;settled=true;resolve({target:'[encrypted upstream]',latencyMs:Date.now()-started,...result})};
    const req=transport.request({protocol:url.protocol,hostname:url.hostname,port:url.port,path:(url.pathname.replace(/\/$/,'')||'')+'/System/Info/Public',method:'GET',headers:{accept:'application/json','user-agent':'AegisRelay-Diagnostics/1'},timeout,rejectUnauthorized:tlsVerify,lookup:guardedLookup(allowPrivate)},res=>{let version='';res.setEncoding('utf8');let body='';res.on('data',c=>{if(body.length<4096)body+=c});res.on('end',()=>{try{version=JSON.parse(body).Version||''}catch{}const cert=res.socket?.getPeerCertificate?.();finish({online:res.statusCode<500,status:res.statusCode,embyVersion:version,tls:url.protocol==='https:'?{authorized:res.socket.authorized===true,issuer:cert?.issuer?.O||cert?.issuer?.CN||'',validTo:cert?.valid_to||''}:null})})});
    req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',err=>finish({online:false,error:err.message}));req.end();
  });
}

export async function diagnoseRoute(route){const main=route.upstreams?.length?route.upstreams:(route.upstream?[route.upstream]:[]),playback=route.playbackUpstreams?.length?route.playbackUpstreams:main;const options={allowPrivate:route.allowPrivate,tlsVerify:route.tlsVerify!==false};return{node:{id:route.id,alias:route.alias,name:route.name},main:await Promise.all(main.map(x=>probe(x,options))),playback:playback===main?null:await Promise.all(playback.map(x=>probe(x,options))),headerPreview:route.clientProfile?.enabled?{userAgent:route.clientProfile.userAgent||'',client:route.clientProfile.client||'',deviceName:route.clientProfile.deviceName||'',deviceId:route.clientProfile.deviceId?'[configured]':''}:{mode:'pass-through'}}}
