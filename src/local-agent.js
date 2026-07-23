import crypto from 'node:crypto';
import fs from 'node:fs';
import { compileDesiredSnapshot, ensurePanelSigningIdentity, verifySnapshot } from './snapshot.js';
import { b64u, randomToken, timingEqual } from './security.js';
import { writeAtomic } from './store.js';
import { ensureAgentRegistry, LOCAL_AGENT_ID, routeIdsForAgent, routesForAgent } from './agent-registry.js';

function freeze(value) {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneRoutes(routes) {
  return freeze(structuredClone(Array.isArray(routes)?routes:[]));
}

export class AtomicRouteSource {
  constructor(routes=[]) { this.routes=cloneRoutes(routes); }
  getRoutes() { return this.routes; }
  apply(routes) { this.routes=cloneRoutes(routes); return this.routes; }
}

function storageKey(encoded) {
  const key=Buffer.from(String(encoded||''),'base64url');
  if(key.length!==32||key.toString('base64url')!==encoded)throw new Error('invalid local agent storage key');
  return key;
}

function seal(snapshot, encodedKey) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',storageKey(encodedKey),iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(snapshot)),cipher.final()]);
  return JSON.stringify({v:1,iv:b64u(iv),tag:b64u(cipher.getAuthTag()),data:b64u(data)});
}

function open(payload, encodedKey) {
  const env=JSON.parse(payload),decipher=crypto.createDecipheriv('aes-256-gcm',storageKey(encodedKey),Buffer.from(env.iv,'base64url'));
  decipher.setAuthTag(Buffer.from(env.tag,'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(env.data,'base64url')),decipher.final()]));
}

export function runtimeRoutes(nodes) {
  return nodes.map(node=>({
    id:node.id,alias:node.alias,name:node.name,enabled:node.enabled,upstreams:node.upstreams,
    allowPrivate:node.allowPrivate,tlsVerify:node.tlsVerify,showOnHome:node.showOnHome,
    clientProfile:node.clientProfile,streamRewrite:node.streamRewrite,speedLimitMbps:node.speedLimitMbps,monthlyQuotaGB:node.monthlyQuotaGB,
    accessMode:node.access.mode,
    ...(node.access.mode==='key'?{authVersion:node.access.algorithm,routeAuthKey:node.access.routeAuthKey,keyDigest:node.access.digest}:{})
  }));
}

export class LocalAgent {
  constructor({store,cacheFile=`${store.file}.local-agent.snapshot`}) {
    const registered=Array.isArray(store.data.agents)&&store.data.agents.some(agent=>agent.id===LOCAL_AGENT_ID);
    this.store=store;this.cacheFile=cacheFile;this.previousFile=`${cacheFile}.previous`;this.routeSource=new AtomicRouteSource(registered?routesForAgent(store.data,LOCAL_AGENT_ID):store.data.routes);
    this.panelIdentity=null;this.record=null;this.lastError='';this.applyState='starting';this.lastSeen=null;
  }

  register() {
    this.panelIdentity=ensurePanelSigningIdentity(this.store);
    this.store.data.controlPlane=this.store.data.controlPlane||{};
    const hadRegistry=Array.isArray(this.store.data.agents)&&this.store.data.agents.some(agent=>agent.id===LOCAL_AGENT_ID);
    const registry=ensureAgentRegistry(this.store.data,new Date().toISOString(),{deployAllLocal:!hadRegistry});
    let record=this.store.data.controlPlane.localAgent,changed=false;
    if(!record){
      record={id:'local',name:'本地 Agent',transport:'loopback',enrolledAt:new Date().toISOString(),agentStorageKey:randomToken(32),pinnedPanelKeyId:this.panelIdentity.keyId,pinnedPanelPublicKey:this.panelIdentity.publicKey,desiredState:null,appliedRevision:0,appliedHash:null,lastAck:null};
      this.store.data.controlPlane.localAgent=record;changed=true;
    }
    if(!record.agentStorageKey){record.agentStorageKey=randomToken(32);changed=true;}
    if(registry.changed)changed=true;
    if(!timingEqual(record.pinnedPanelKeyId||'',this.panelIdentity.keyId)||!timingEqual(record.pinnedPanelPublicKey||'',this.panelIdentity.publicKey))throw new Error('local agent panel signing key mismatch');
    storageKey(record.agentStorageKey);
    this.record=record;
    if(changed)this.store.save();
    return record;
  }

  pinnedIdentity() { return {algorithm:'Ed25519',keyId:this.record.pinnedPanelKeyId,publicKey:this.record.pinnedPanelPublicKey}; }

  loadCachedSnapshot() {
    if(!fs.existsSync(this.cacheFile))return false;
    const snapshot=open(fs.readFileSync(this.cacheFile,'utf8'),this.record.agentStorageKey);
    verifySnapshot(snapshot,this.pinnedIdentity());
    this.routeSource.apply(runtimeRoutes(snapshot.nodes));
    this.record.appliedRevision=snapshot.revision;this.record.appliedHash=snapshot.hash;
    return true;
  }

  pull(nodes) {
    const compiled=compileDesiredSnapshot({nodes,previousState:this.record.desiredState,signingIdentity:this.panelIdentity});
    this.record.desiredState=compiled.state;
    return compiled.snapshot;
  }

  apply(snapshot) {
    const decision=verifySnapshot(snapshot,this.pinnedIdentity(),{currentRevision:this.record.appliedRevision||0,currentHash:this.record.appliedHash||null});
    if(decision.status==='noop')return decision;
    const routes=runtimeRoutes(snapshot.nodes);
    cloneRoutes(routes);
    if(fs.existsSync(this.cacheFile))writeAtomic(this.previousFile,fs.readFileSync(this.cacheFile));
    writeAtomic(this.cacheFile,seal(snapshot,this.record.agentStorageKey));
    this.routeSource.apply(routes);
    this.record.appliedRevision=snapshot.revision;this.record.appliedHash=snapshot.hash;
    return decision;
  }

  ack(snapshot,status,error='') {
    this.record.lastAck={revision:snapshot?.revision||0,hash:snapshot?.hash||null,status,at:new Date().toISOString(),error:String(error||'').slice(0,240)};
    this.lastSeen=this.record.lastAck.at;
    const agent=this.store.data.agents.find(item=>item.id===LOCAL_AGENT_ID);
    if(agent){agent.lastSeen=this.lastSeen;agent.applyState=status==='applied'?'active':'error';agent.desiredRevision=snapshot?.revision||0;agent.appliedRevision=status==='applied'?(snapshot?.revision||0):(this.record.appliedRevision||0);agent.proxyHealthy=status==='applied';agent.updatedAt=this.lastSeen;}
  }

  reconcile(nodes=routesForAgent(this.store.data,LOCAL_AGENT_ID)) {
    let snapshot;
    try {
      snapshot=this.pull(nodes);
      const decision=this.apply(snapshot);
      this.ack(snapshot,'applied');
      this.applyState='active';this.lastError='';
      this.store.save();
      return {ok:true,decision:decision.status,revision:snapshot.revision,hash:snapshot.hash};
    } catch(error) {
      this.ack(snapshot,'rejected',error.message);
      this.applyState='error';this.lastError=String(error.message||error).slice(0,240);
      this.store.save();
      return {ok:false,error:this.lastError,revision:this.record?.appliedRevision||0};
    }
  }

  start() {
    this.register();
    let loaded=false;
    try { loaded=this.loadCachedSnapshot(); } catch(error) { this.lastError=`cached snapshot rejected: ${error.message}`; }
    if(!loaded){this.record.appliedRevision=0;this.record.appliedHash=null;}
    return this.reconcile();
  }

  status() {
    const desired=this.record?.desiredState?.revision||0,applied=this.record?.appliedRevision||0;
    const agent=this.store.data.agents.find(item=>item.id===LOCAL_AGENT_ID)||{};
    return {id:LOCAL_AGENT_ID,name:agent.name||'本地 Agent',transport:'loopback',domain:agent.domain||'',routeIds:routeIdsForAgent(this.store.data,LOCAL_AGENT_ID),status:'online',applyState:this.applyState,proxyHealthy:true,desiredRevision:desired,appliedRevision:applied,inSync:desired===applied&&this.applyState==='active',lastSeen:this.lastSeen||this.record?.lastAck?.at||this.record?.enrolledAt||null,lastAck:this.record?.lastAck||null,error:this.lastError||null,canDelete:false};
  }
}
