import { Transform } from 'node:stream';

const monthKey = () => new Date().toISOString().slice(0, 7);
const dayKey = () => new Date().toISOString().slice(0, 10);

export class ThrottleTransform extends Transform {
  constructor(bytesPerSecond = 0,onBytes=null) { super(); this.rate=bytesPerSecond; this.onBytes=typeof onBytes==='function'?onBytes:null;this.next=Date.now(); this.bytes=0; this.timer=null; }
  _transform(chunk, encoding, callback) {
    this.bytes+=chunk.length;this.onBytes?.(chunk.length);
    if(!this.rate){this.push(chunk);return callback();}
    const now=Date.now(), wait=Math.max(0,this.next-now); this.next=Math.max(now,this.next)+(chunk.length/this.rate)*1000;
    // Pushing after the stream was torn down (client aborted a rate-limited stream) throws.
    this.timer=setTimeout(()=>{this.timer=null;if(this.destroyed)return callback();this.push(chunk);callback()},wait);
  }
  _destroy(error, callback) { if(this.timer){clearTimeout(this.timer);this.timer=null;} callback(error); }
}

export class Metrics {
  constructor(store) {
    this.store=store; this.active=new Map(); this.listeners=new Set(); this.currentDay='';
    store.data.metrics ||= { startedAt:new Date().toISOString(), routes:{}, daily:{} };
    this.refreshDay();
  }
  refreshDay() {
    const key=dayKey();
    if(key===this.currentDay)return key;
    this.currentDay=key;
    const daily=this.store.data.metrics.daily;
    daily[key]??=0;
    for(const old of Object.keys(daily).sort().slice(0,-31))delete daily[old];
    return key;
  }
  route(route) {
    this.refreshDay();
    const all=this.store.data.metrics.routes, id=route.id||route.alias;
    all[id] ||= { requests:0, playbackRequests:0, errors:0, bytesIn:0, bytesOut:0, month:monthKey(), monthBytes:0, lastRequest:null, lastStatus:null };
    const s=all[id]; if(s.month!==monthKey()){s.month=monthKey();s.monthBytes=0;} return s;
  }
  canServe(route) { const quota=Number(route.monthlyQuotaGB||0)*1024**3; return !quota || this.route(route).monthBytes<quota; }
  begin(route,{playback=false,bytesIn=0}={}) {
    const s=this.route(route), id=route.id||route.alias; s.requests++; if(playback)s.playbackRequests++; s.bytesIn+=Number(bytesIn)||0; s.lastRequest=new Date().toISOString(); this.active.set(id,(this.active.get(id)||0)+1);
    // This callback runs once per network chunk on unlimited media streams. Keep it to plain
    // additions: Date construction, sorting and timer checks here noticeably reduce peak relay
    // throughput. refreshDay() is driven by begin()/snapshot(), so the dashboard still rolls the
    // UTC day while a long stream remains open without putting clock work in the hot loop.
    const addBytes=bytes=>{const amount=Math.max(0,Number(bytes)||0);if(!amount)return;s.bytesOut+=amount;s.monthBytes+=amount;this.store.data.metrics.daily[this.currentDay]+=amount;};
    let done=false;const finish=(status=500,bytesOut=0,error=false)=>{if(done)return;done=true;addBytes(bytesOut);s.lastStatus=status;if(error||status>=500)s.errors++;this.active.set(id,Math.max(0,(this.active.get(id)||1)-1));this.emit()};finish.addBytes=addBytes;return finish;
  }
  snapshot(routes) {
    this.refreshDay();
    const items=routes.map(r=>{const s=this.route(r);return{id:r.id,alias:r.alias,name:r.name,enabled:r.enabled,active:this.active.get(r.id||r.alias)||0,...s,quotaBytes:Number(r.monthlyQuotaGB||0)*1024**3,speedLimitMbps:Number(r.speedLimitMbps||0)}});
    return { startedAt:this.store.data.metrics.startedAt, totalRequests:items.reduce((n,x)=>n+x.requests,0), totalBytes:items.reduce((n,x)=>n+x.bytesOut,0), active:items.reduce((n,x)=>n+x.active,0), running:routes.filter(r=>r.enabled).length, nodes:items, daily:this.store.data.metrics.daily };
  }
  // Counters for a deleted node are dead weight in memory and in every encrypted store write.
  drop(routeId){delete this.store.data.metrics.routes[routeId];this.active.delete(routeId)}
  retainOnly(routeIds){const keep=new Set(routeIds);for(const id of Object.keys(this.store.data.metrics.routes))if(!keep.has(id))this.drop(id)}
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  emit(){for(const fn of this.listeners)fn()}
}
