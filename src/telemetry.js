const MAX_COUNTER=Number.MAX_SAFE_INTEGER;

const counter=value=>{
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?Math.min(MAX_COUNTER,Math.floor(number)):0;
};

const cleanText=(value,max=80)=>String(value||'').replace(/[\r\n\0]/g,'').slice(0,max);
// Cap on how many detailed viewer rows an agent ships per node each check-in. The distinct counts are
// computed from the agent's full rolling set, so the badge stays accurate even past this cap.
const VIEWER_REPORT_CAP=50;
function cleanViewers(list){
  const out=[];
  for(const v of Array.isArray(list)?list.slice(0,VIEWER_REPORT_CAP):[]){
    const ip=cleanText(v?.ip,45);if(!ip)continue;
    out.push({ip,deviceName:cleanText(v.deviceName,80),client:cleanText(v.client,80),deviceId:cleanText(v.deviceId,80),ua:cleanText(v.ua,160),firstSeen:counter(v.firstSeen),lastSeen:counter(v.lastSeen),hits:counter(v.hits)});
  }
  return out;
}

export function sanitizeTelemetry(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const nodes=[];
  for(const item of Array.isArray(value.nodes)?value.nodes.slice(0,100):[]){
    const id=cleanText(item?.id,80);if(!id)continue;
    nodes.push({
      id,alias:cleanText(item.alias,32),name:cleanText(item.name,80),
      requests:counter(item.requests),playbackRequests:counter(item.playbackRequests),errors:counter(item.errors),
      bytesIn:counter(item.bytesIn),bytesOut:counter(item.bytesOut),monthBytes:counter(item.monthBytes),
      active:counter(item.active),month:/^\d{4}-\d{2}$/.test(String(item.month||''))?String(item.month):'',
      distinctIps:counter(item.distinctIps),distinctDevices:counter(item.distinctDevices),viewers:cleanViewers(item.viewers)
    });
  }
  const daily={};
  for(const [day,bytes] of Object.entries(value.daily&&typeof value.daily==='object'&&!Array.isArray(value.daily)?value.daily:{}).sort().slice(-31)){
    if(/^\d{4}-\d{2}-\d{2}$/.test(day))daily[day]=counter(bytes);
  }
  return {
    version:1,startedAt:cleanText(value.startedAt,40)||null,reportedAt:new Date().toISOString(),nodes,daily,
    totalRequests:nodes.reduce((sum,node)=>sum+node.requests,0),
    playbackRequests:nodes.reduce((sum,node)=>sum+node.playbackRequests,0),
    errors:nodes.reduce((sum,node)=>sum+node.errors,0),
    bytesIn:nodes.reduce((sum,node)=>sum+node.bytesIn,0),
    totalBytes:nodes.reduce((sum,node)=>sum+node.bytesOut,0),
    monthBytes:nodes.reduce((sum,node)=>sum+node.monthBytes,0),
    active:nodes.reduce((sum,node)=>sum+node.active,0)
  };
}

export function telemetryFromMetrics(snapshot) {
  return sanitizeTelemetry({version:1,startedAt:snapshot?.startedAt,nodes:snapshot?.nodes,daily:snapshot?.daily})||sanitizeTelemetry({nodes:[],daily:{}});
}

export function aggregateTelemetry(items) {
  const valid=(Array.isArray(items)?items:[]).filter(Boolean),daily={};
  for(const item of valid)for(const [day,bytes] of Object.entries(item.daily||{}))daily[day]=counter((daily[day]||0)+counter(bytes));
  for(const old of Object.keys(daily).sort().slice(0,-31))delete daily[old];
  return {
    totalRequests:valid.reduce((sum,item)=>sum+counter(item.totalRequests),0),
    playbackRequests:valid.reduce((sum,item)=>sum+counter(item.playbackRequests),0),
    errors:valid.reduce((sum,item)=>sum+counter(item.errors),0),
    bytesIn:valid.reduce((sum,item)=>sum+counter(item.bytesIn),0),
    totalBytes:valid.reduce((sum,item)=>sum+counter(item.totalBytes),0),
    monthBytes:valid.reduce((sum,item)=>sum+counter(item.monthBytes),0),
    active:valid.reduce((sum,item)=>sum+counter(item.active),0),daily
  };
}
