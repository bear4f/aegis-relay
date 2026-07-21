export const LOCAL_AGENT_ID = 'local';

const iso = value => {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function normalizeAgentDomain(value) {
  const input=String(value||'').trim();
  if(!input)return '';
  let url;
  try { url=new URL(input.includes('://')?input:`https://${input}`); }
  catch { throw new Error('invalid agent domain'); }
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname)throw new Error('agent domain must be a bare HTTPS host');
  return url.host.toLowerCase();
}

export function deploymentId(agentId, routeId) {
  return `${agentId}:${routeId}`;
}

export function ensureLocalDeployment(data, routeId, at=new Date().toISOString()) {
  data.deployments=Array.isArray(data.deployments)?data.deployments:[];
  const current=data.deployments.find(item=>item.agentId===LOCAL_AGENT_ID&&item.routeId===routeId);
  if(current)return current;
  const deployment={id:deploymentId(LOCAL_AGENT_ID,routeId),agentId:LOCAL_AGENT_ID,routeId,enabled:true,createdAt:at,updatedAt:at};
  data.deployments.push(deployment);
  return deployment;
}

export function ensureAgentRegistry(data, at=new Date().toISOString(), {deployAllLocal=false}={}) {
  let changed=false;
  if(!Array.isArray(data.agents)){data.agents=[];changed=true;}
  if(!Array.isArray(data.deployments)){data.deployments=[];changed=true;}
  let local=data.agents.find(agent=>agent.id===LOCAL_AGENT_ID);
  if(!local){
    local={id:LOCAL_AGENT_ID,name:'本地 Agent',transport:'loopback',domain:'',state:'active',enrolledAt:at,createdAt:at,updatedAt:at};
    data.agents.push(local);changed=true;
  }
  if(deployAllLocal){
    for(const route of Array.isArray(data.routes)?data.routes:[]){
      if(!data.deployments.some(item=>item.agentId===LOCAL_AGENT_ID&&item.routeId===route.id)){
        ensureLocalDeployment(data,route.id,at);changed=true;
      }
    }
  }
  return {changed,local};
}

export function routesForAgent(data, agentId) {
  const selected=new Set((Array.isArray(data.deployments)?data.deployments:[]).filter(item=>item.agentId===agentId&&item.enabled!==false).map(item=>item.routeId));
  return (Array.isArray(data.routes)?data.routes:[]).filter(route=>selected.has(route.id));
}

export function routeIdsForAgent(data, agentId) {
  return routesForAgent(data,agentId).map(route=>route.id);
}

export function replaceAgentDeployments(data, agentId, routeIds, at=new Date().toISOString()) {
  const wanted=new Set(routeIds);
  data.deployments=(Array.isArray(data.deployments)?data.deployments:[]).filter(item=>item.agentId!==agentId);
  for(const route of Array.isArray(data.routes)?data.routes:[]){
    if(wanted.has(route.id))data.deployments.push({id:deploymentId(agentId,route.id),agentId,routeId:route.id,enabled:true,createdAt:at,updatedAt:at});
  }
  return routeIdsForAgent(data,agentId);
}

export function removeRouteDeployments(data, routeId) {
  data.deployments=(Array.isArray(data.deployments)?data.deployments:[]).filter(item=>item.routeId!==routeId);
}

export function remoteAgentStatus(agent, now=Date.now()) {
  const seen=iso(agent.lastSeen),age=seen?Math.max(0,now-new Date(seen).getTime()):Infinity;
  if(agent.state==='revoked')return 'revoked';
  if(age<=90_000)return 'online';
  if(age<=300_000)return 'stale';
  return 'offline';
}

export function publicAgent(agent, data, runtime=null, now=Date.now()) {
  const local=agent.id===LOCAL_AGENT_ID,status=local?(runtime?.status||'online'):remoteAgentStatus(agent,now);
  return {
    id:agent.id,name:agent.name||agent.id,transport:agent.transport||'poll',domain:agent.domain||'',status,
    routeIds:routeIdsForAgent(data,agent.id),lastSeen:runtime?.lastSeen||agent.lastSeen||agent.enrolledAt||null,
    applyState:runtime?.applyState||agent.applyState||'waiting',proxyHealthy:runtime?.proxyHealthy===true||agent.proxyHealthy===true,
    desiredRevision:Number(runtime?.desiredRevision??agent.desiredRevision??0),appliedRevision:Number(runtime?.appliedRevision??agent.appliedRevision??0),
    inSync:runtime?.inSync===true||(Number(agent.desiredRevision||0)===Number(agent.appliedRevision||0)&&agent.applyState==='active'),
    lastAck:runtime?.lastAck||agent.lastAck||null,error:runtime?.error||agent.error||'',telemetry:runtime?.telemetry||agent.telemetry||null,lastTelemetryAt:runtime?.lastTelemetryAt||agent.lastTelemetryAt||null,canDelete:!local,agentVersion:local?'':String(agent.agentVersion||'')
  };
}
