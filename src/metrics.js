import { Transform } from 'node:stream';

const monthKey = () => new Date().toISOString().slice(0, 7);
const dayKey = () => new Date().toISOString().slice(0, 10);

export class ThrottleTransform extends Transform {
  constructor(bytesPerSecond = 0) { super(); this.rate=bytesPerSecond; this.next=Date.now(); this.bytes=0; }
  _transform(chunk, encoding, callback) {
    this.bytes+=chunk.length;
    if(!this.rate){this.push(chunk);return callback();}
    const now=Date.now(), wait=Math.max(0,this.next-now); this.next=Math.max(now,this.next)+(chunk.length/this.rate)*1000;
    setTimeout(()=>{this.push(chunk);callback()},wait);
  }
}

export class Metrics {
  constructor(store) {
    this.store=store; this.active=new Map(); this.listeners=new Set();
    store.data.metrics ||= { startedAt:new Date().toISOString(), routes:{}, daily:{} };
  }
  route(route) {
    const all=this.store.data.metrics.routes, id=route.id||route.alias;
    all[id] ||= { requests:0, playbackRequests:0, errors:0, bytesIn:0, bytesOut:0, month:monthKey(), monthBytes:0, lastRequest:null, lastStatus:null };
    const s=all[id]; if(s.month!==monthKey()){s.month=monthKey();s.monthBytes=0;} return s;
  }
  canServe(route) { const quota=Number(route.monthlyQuotaGB||0)*1024**3; return !quota || this.route(route).monthBytes<quota; }
  begin(route,{playback=false,bytesIn=0}={}) {
    const s=this.route(route), id=route.id||route.alias; s.requests++; if(playback)s.playbackRequests++; s.bytesIn+=Number(bytesIn)||0; s.lastRequest=new Date().toISOString(); this.active.set(id,(this.active.get(id)||0)+1);
    let done=false; return (status=500,bytesOut=0,error=false)=>{if(done)return;done=true;s.lastStatus=status;s.bytesOut+=bytesOut;s.monthBytes+=bytesOut;if(error||status>=500)s.errors++;this.active.set(id,Math.max(0,(this.active.get(id)||1)-1));const d=this.store.data.metrics.daily;d[dayKey()] ||= 0;d[dayKey()]+=bytesOut;for(const old of Object.keys(d).sort().slice(0,-31))delete d[old];this.emit();};
  }
  snapshot(routes) {
    const items=routes.map(r=>{const s=this.route(r);return{id:r.id,alias:r.alias,name:r.name,enabled:r.enabled,active:this.active.get(r.id||r.alias)||0,...s,quotaBytes:Number(r.monthlyQuotaGB||0)*1024**3,speedLimitMbps:Number(r.speedLimitMbps||0)}});
    return { startedAt:this.store.data.metrics.startedAt, totalRequests:items.reduce((n,x)=>n+x.requests,0), totalBytes:items.reduce((n,x)=>n+x.bytesOut,0), active:items.reduce((n,x)=>n+x.active,0), running:routes.filter(r=>r.enabled).length, nodes:items, daily:this.store.data.metrics.daily };
  }
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  emit(){for(const fn of this.listeners)fn()}
}
