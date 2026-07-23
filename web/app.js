const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const scriptPath=new URL(document.currentScript?.src||location.href).pathname;
const base=scriptPath.endsWith('/app.js')?scriptPath.replace(/\/app\.js$/,'/api'):location.pathname.replace(/\/$/,'')+'/api';
// Theme: apply the saved (or system) preference before first paint of the app shell.
const THEME_KEY='aegis-theme';
(function(){let t;try{t=localStorage.getItem(THEME_KEY)}catch{}if(t!=='dark'&&t!=='light')t=window.matchMedia&&matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.dataset.theme=t})();
function toggleTheme(){const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem(THEME_KEY,next)}catch{}}
const state={csrf:'',routes:[],agents:[],panelVersion:'',dashboard:null,editing:null,page:'dashboard',panelIcon:''};
const titles={dashboard:'仪表盘',nodes:'节点管理',agents:'代理机器',traffic:'流量统计',diagnostics:'故障诊断',audit:'安全审计',notifications:'通知提醒',account:'个人设置',deployment:'部署向导'};
// One-click client-identity templates for authorized upstreams. Device ID stays untouched so it remains unique per install.
const UA_PRESETS=[
  {name:'透传（默认）',clear:true},
  {name:'Infuse',userAgent:'Infuse-Direct/8.1.1',client:'Infuse',deviceName:'Infuse'},
  {name:'Emby Web',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',client:'Emby Web',deviceName:'Chrome'},
  {name:'Emby for Android',userAgent:'Emby/3.4.10 (Android 14; Pixel 8)',client:'Emby for Android',deviceName:'Pixel 8'},
  {name:'Fileball',userAgent:'Fileball/1.5.0',client:'Fileball',deviceName:'Fileball'},
  {name:'SenPlayer',userAgent:'SenPlayer/1.2.0',client:'SenPlayer',deviceName:'SenPlayer'},
  {name:'VidHub',userAgent:'VidHub/1.9 (iOS 17)',client:'VidHub',deviceName:'VidHub'},
];

function showLogin(message='登录已失效，请重新登录'){
  state.csrf='';
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#setup').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#gate-msg').textContent=message;
}
async function call(path,options={}){
  options.headers={'content-type':'application/json',...(state.csrf?{'x-csrf-token':state.csrf}:{}),...(options.headers||{})};
  const response=await fetch(base+path,options),type=String(response.headers.get('content-type')||''),raw=await response.text();
  let data={};
  if(type.includes('application/json')){try{data=raw?JSON.parse(raw):{}}catch{throw Error('管理接口返回了损坏的数据，请刷新页面后重试')}}
  else if(response.status===401&&path!=='/login'){showLogin();throw Error('登录已失效，请重新登录')}
  else if([502,503,504].includes(response.status))throw Error(`管理服务连接中断（HTTP ${response.status}），容器可能正在重启，请稍后重试并检查服务日志`);
  else throw Error(response.ok?`管理接口返回了网页而不是数据（HTTP ${response.status}），请刷新页面后重试`:`请求未到达管理接口（HTTP ${response.status}），请检查 Nginx/CDN 是否允许 /api/ 路径`);
  if(response.status===401&&path!=='/login'){showLogin();throw Error('登录已失效，请重新登录')}
  if(!response.ok)throw Error(data.error||'请求失败');
  return data;
}
const value=id=>$(id).value, bool=id=>value(id)==='true', escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message,error=false){const el=$('#toast');el.textContent=message;el.classList.remove('hidden');el.classList.toggle('error',error);clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.add('hidden'),3200)}
function bytes(n=0){const units=['B','KB','MB','GB','TB'];let i=0;n=Number(n)||0;while(n>=1024&&i<units.length-1){n/=1024;i++}return`${n>=10||i===0?n.toFixed(0):n.toFixed(1)} ${units[i]}`}
function uptime(start){if(!start)return'—';let s=Math.max(0,(Date.now()-new Date(start))/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?`${d}天 ${h}时`:`${h}时 ${m}分`}
function recentDays(daily,count=14){const rows=[];for(let ago=count-1;ago>=0;ago--){const day=new Date();day.setUTCHours(0,0,0,0);day.setUTCDate(day.getUTCDate()-ago);const key=day.toISOString().slice(0,10);rows.push({key,label:`${day.getUTCMonth()+1}/${day.getUTCDate()}`,bytes:Number(daily?.[key]||0)})}return rows}
function showSecret(content,{eyebrow='NODE CREDENTIALS',title='节点连接信息',description='完整节点地址和连接密码可由管理员随时再次查看。'}={}){$('#modal-eyebrow').textContent=eyebrow;$('#modal-title').textContent=title;$('#modal-description').textContent=description;$('#secret').textContent=content;$('#modal').classList.remove('hidden')}

const DEFAULT_FAVICON='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#2f6f56"/><text x="32" y="45" font-family="Arial,Helvetica,sans-serif" font-size="38" font-weight="900" fill="#f4fbf6" text-anchor="middle">A</text></svg>');
function applyPanelIcon(icon){
  state.panelIcon=String(icon||'');
  for(const el of document.querySelectorAll('.brand-mark,.hero-orbit b')){
    if(state.panelIcon){const img=document.createElement('img');img.src=state.panelIcon;img.alt='面板图标';el.classList.add('custom');el.replaceChildren(img)}
    else{el.classList.remove('custom');el.textContent='A'}
  }
  let link=document.querySelector('link[rel="icon"]');
  if(!link){link=document.createElement('link');link.rel='icon';document.head.appendChild(link)}
  link.href=state.panelIcon||DEFAULT_FAVICON;
  const iconState=$('#icon-state');if(iconState){iconState.textContent=state.panelIcon?'自定义':'默认';iconState.className=`pill ${state.panelIcon?'on':''}`}
}

async function enterApp(){$('#auth').classList.add('hidden');$('#app').classList.remove('hidden');await refreshAll();streamDashboard()}
async function start(){
  // The icon is public branding: fetch it before login so the auth page and favicon match the panel.
  applyPanelIcon('');call('/branding').then(d=>applyPanelIcon(d.icon||'')).catch(()=>{});
  // Resume a still-valid session (survives refresh) before falling back to the login screen.
  try{const r=await fetch(base+'/session',{headers:{'content-type':'application/json'}});if(r.ok){const d=await r.json();if(d&&d.csrf){state.csrf=d.csrf;await enterApp();return}}}catch{}
  try{const status=await call('/status');$('#auth').classList.remove('hidden');$(status.initialized?'#login':'#setup').classList.remove('hidden')}catch(e){$('#gate-msg').textContent=e.message}
}
$('#setup-btn').onclick=async()=>{try{await call('/setup',{method:'POST',body:JSON.stringify({username:value('#su-user'),password:value('#su-pass'),setupToken:value('#su-token')})});$('#setup').classList.add('hidden');$('#login').classList.remove('hidden');$('#gate-msg').textContent='管理员已创建，请用密码登录；可稍后在“个人设置”开启两步验证。'}catch(e){$('#gate-msg').textContent=e.message}};
$('#login-btn').onclick=async()=>{try{const data=await call('/login',{method:'POST',body:JSON.stringify({password:value('#password'),code:value('#code')})});state.csrf=data.csrf;await enterApp()}catch(e){$('#gate-msg').textContent=e.message}};
$('#logout').onclick=async()=>{try{await call('/logout',{method:'POST',body:'{}'})}finally{location.reload()}};

async function refreshAll(){const [routes,dashboard]=await Promise.all([call('/routes'),call('/dashboard')]);state.routes=routes.routes;state.dashboard=dashboard;renderRoutes();renderDashboard(dashboard);renderTraffic(dashboard);fillDiagnosticNodes()}
function renderDashboard(data){
  const machines=Array.isArray(data.machines)?data.machines:[],online=machines.filter(machine=>machine.status==='online'&&machine.proxyHealthy).length;
  $('#m-nodes').textContent=state.routes.length;$('#m-running').textContent=`${data.running} 个运行中`;$('#m-traffic').textContent=bytes(data.totalBytes);$('#m-month-traffic').textContent=`本月 ${bytes(data.monthBytes)}`;$('#m-requests').textContent=Number(data.totalRequests||0).toLocaleString();$('#m-active').textContent=`${data.active||0} 个活动连接`;$('#m-agents').textContent=`${online} / ${machines.length}`;$('#m-agent-state').textContent=machines.length?`${machines.length-online} 台需关注`:'暂无代理机器';
  const days=recentDays(data.daily),max=Math.max(1,...days.map(day=>day.bytes)),today=days.at(-1)?.bytes||0,week=days.slice(-7).reduce((sum,day)=>sum+day.bytes,0),peak=days.reduce((best,day)=>day.bytes>best.bytes?day:best,days[0]);
  $('#traffic-chart').innerHTML=days.map(day=>{const pct=day.bytes?Math.max(3,day.bytes/max*100):0;return`<div class="traffic-day${day.bytes?'':' empty'}" title="${day.key} · ${bytes(day.bytes)}"><div class="traffic-track"><i style="height:${pct}%"></i>${day.bytes?`<b class="traffic-value" style="bottom:calc(${pct}% + 6px)">${bytes(day.bytes)}</b>`:''}</div><small>${day.label}</small></div>`}).join('');
  $('#traffic-insights').innerHTML=`<div><small>今日流量</small><strong>${bytes(today)}</strong></div><div><small>近 7 天</small><strong>${bytes(week)}</strong></div><div><small>单日峰值</small><strong>${bytes(peak?.bytes||0)}</strong><em>${peak?.label||'—'}</em></div><div><small>播放请求</small><strong>${Number(data.playbackRequests||0).toLocaleString()}</strong></div>`;
  const statusLabel={online:'在线',stale:'连接延迟',offline:'失联',revoked:'已撤销'};
  $('#dashboard-machines').innerHTML=machines.map(machine=>{const t=machine.telemetry,share=data.totalBytes&&t?Math.min(100,t.totalBytes/data.totalBytes*100):0,healthy=machine.status==='online'&&machine.proxyHealthy;return`<div class="machine-tile" data-status="${escapeHtml(machine.status)}"><div class="machine-title"><div><strong><i class="machine-dot ${healthy?'':'off'}"></i>${escapeHtml(machine.name)}</strong><small>${escapeHtml(machine.domain||machine.transport||'尚未设置域名')}</small></div><div class="tag-row"><span class="pill ${healthy?'on':'warn'}">${statusLabel[machine.status]||'未知'}</span><span class="pill ${machine.inSync?'info':'warn'}">${machine.inSync?'已同步':'待同步'}</span></div></div>${t?`<div class="machine-stats"><div><small>累计流量</small><strong>${bytes(t.totalBytes)}</strong></div><div><small>本月流量</small><strong>${bytes(t.monthBytes)}</strong></div><div><small>请求 / 播放</small><strong>${Number(t.totalRequests).toLocaleString()} / ${Number(t.playbackRequests).toLocaleString()}</strong></div><div><small>活动连接</small><strong>${t.active||0}</strong></div></div><div class="machine-share"><i style="width:${share}%"></i></div><small class="machine-report">占全网流量 ${share.toFixed(1)}% · 最近上报 ${machine.lastTelemetryAt?new Date(machine.lastTelemetryAt).toLocaleString():'—'}</small>`:'<div class="telemetry-missing">等待该 Agent 升级后上报流量</div>'}</div>`}).join('')||'<div class="empty-state"><p>还没有代理机器</p></div>';
  const nodeMetrics=new Map((data.nodes||[]).map(x=>[x.id,x]));$('#dashboard-nodes').innerHTML=state.routes.slice(0,6).map(r=>{const m=nodeMetrics.get(r.id)||{};return`<div class="mini-row"><div><strong><i class="status-dot ${r.enabled?'':'off'}"></i>${escapeHtml(r.name)}</strong><small>/${escapeHtml(r.alias)}/ · 主代理机 ${bytes(m.bytesOut)}</small></div><span class="pill">${m.active||0} 活动</span></div>`}).join('')||'<div class="empty-state"><p>还没有节点</p></div>'
}

function renderPresets(){const host=$('#profile-presets');if(!host)return;host.innerHTML=UA_PRESETS.map((p,i)=>`<button type="button" class="preset-chip" data-i="${i}">${escapeHtml(p.name)}</button>`).join('');host.querySelectorAll('.preset-chip').forEach(chip=>chip.onclick=()=>applyPreset(UA_PRESETS[+chip.dataset.i]))}
function applyPreset(p){if(p.clear){$('#profile-enabled').checked=false;for(const id of ['#profile-ua','#profile-client','#profile-device'])setValue(id,'')}else{$('#profile-enabled').checked=true;setValue('#profile-ua',p.userAgent||'');setValue('#profile-client',p.client||'');setValue('#profile-device',p.deviceName||'')}markActivePreset()}
function markActivePreset(){const ua=value('#profile-ua'),host=$('#profile-presets');if(!host)return;host.querySelectorAll('.preset-chip').forEach(chip=>{const p=UA_PRESETS[+chip.dataset.i];chip.classList.toggle('active',!p.clear&&!!ua&&p.userAgent===ua)})}
async function testConnection(route,row){const btn=row.querySelector('.test-node');btn.disabled=true;btn.classList.remove('good','warn','bad');btn.textContent='测试中…';try{const d=await call(`/diagnostics/${route.id}`);const p=(d.main||[])[0]||{},lat=Number(p.latencyMs),cls=!p.online?'bad':lat<300?'good':lat<800?'warn':'bad';btn.classList.add(cls);btn.textContent=p.online?(isFinite(lat)?lat+' ms':'在线'):'失败';toast(p.online?`${route.name} 在线 · ${isFinite(lat)?lat+' ms':'—'} · HTTP ${p.status||'—'}${p.embyVersion?` · Emby ${p.embyVersion}`:''}`:`${route.name} 连接失败${p.error?' · '+p.error:''}`,!p.online)}catch(e){btn.classList.add('bad');btn.textContent='失败';toast(e.message,true)}finally{btn.disabled=false}}
function credentialText(route,data){const origin=String(data.publicBaseUrl||location.origin).replace(/\/$/,'');const full=`${origin}${data.clientPath}`;return data.accessKey?`客户端服务器地址（复制这一整行）\n${full}\n\n地址保护码（已经包含在上面的地址中，无需单独填写）\n${data.accessKey}\n\n在 Emby 客户端添加服务器时，只需粘贴完整服务器地址。`:`客户端服务器地址（复制这一整行）\n${full}\n\n此节点没有启用连接密码，知道地址的人都可以访问。`}
function askConnectionKey(){return prompt('输入新的连接密码（8–64 位字母、数字、下划线或连字符）。留空将安全随机生成；点击取消则不更换。','')}
async function viewCredentials(route){try{const data=await call(`/routes/${route.id}/credentials`);if(!data.available){if(!confirm('这个节点由旧版本创建，当时没有保存可恢复的连接密码。是否现在更换密码？更换后旧客户端地址会立即失效。'))return;const custom=askConnectionKey();if(custom===null)return;const rotated=await call(`/routes/${route.id}/rotate-key`,{method:'POST',body:JSON.stringify({accessKey:custom})});showSecret(credentialText(route,rotated));return}showSecret(credentialText(route,data))}catch(e){toast(e.message,true)}}
const ADDR_MASK='••••••••••••••••••';
async function nodeUrl(r){if(r._url)return r._url;const d=await call(`/routes/${r.id}/credentials`);if(!d.available)throw new Error('该节点由旧版本创建，未保存可恢复的地址，请先“更换密码”。');r._url=String(d.publicBaseUrl||location.origin).replace(/\/$/,'')+d.clientPath;return r._url}
function statusPills(r){const pills=[`<span class="pill ${r.enabled?'on':'off'}">${r.enabled?'运行中':'已停用'}</span>`,`<span class="pill ${r.accessMode==='key'?'lock':'off'}">${r.accessMode==='key'?'密钥':'公开'}</span>`];if(r.clientProfile&&r.clientProfile.enabled)pills.push(`<span class="pill disguise">伪装${r.clientProfile.client?'：'+escapeHtml(r.clientProfile.client):''}</span>`);if(r.streamRewrite&&r.streamRewrite.enabled)pills.push(`<span class="pill split">分离推流</span>`);return pills.concat(r.tags.map(t=>`<span class="tag">${escapeHtml(t)}</span>`)).join('')}
const EYE_SVG='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
function routeMatches(r,q){if(!q)return true;const hay=`${r.name} ${r.alias} ${(r.tags||[]).join(' ')}`.toLowerCase();return hay.includes(q)}
let dragRouteId=null;
async function persistOrder(){
  const updates=state.routes.map((route,index)=>({route,order:(index+1)*10})).filter(item=>Number(item.route.sortOrder)!==item.order);
  if(!updates.length)return;
  try{
    for(const {route,order} of updates){await call(`/routes/${route.id}`,{method:'PATCH',body:JSON.stringify({sortOrder:order})});route.sortOrder=order}
    toast('排序已保存');
  }catch(error){toast(error.message,true);await refreshAll()}
}
function bindRowDrag(row,route){
  const handle=row.querySelector('.drag-handle');
  if(!handle||!handle.getAttribute('draggable'))return;
  handle.addEventListener('dragstart',event=>{dragRouteId=route.id;row.classList.add('dragging');event.dataTransfer.effectAllowed='move';try{event.dataTransfer.setData('text/plain',route.id)}catch{}});
  handle.addEventListener('dragend',()=>{dragRouteId=null;row.classList.remove('dragging');$$('.drop-above,.drop-below').forEach(el=>el.classList.remove('drop-above','drop-below'))});
  row.addEventListener('dragover',event=>{
    if(!dragRouteId||dragRouteId===route.id)return;
    event.preventDefault();event.dataTransfer.dropEffect='move';
    const box=row.getBoundingClientRect(),after=event.clientY>box.top+box.height/2;
    row.classList.toggle('drop-below',after);row.classList.toggle('drop-above',!after);
  });
  row.addEventListener('dragleave',()=>row.classList.remove('drop-above','drop-below'));
  row.addEventListener('drop',event=>{
    if(!dragRouteId||dragRouteId===route.id)return;
    event.preventDefault();
    const box=row.getBoundingClientRect(),after=event.clientY>box.top+box.height/2;
    const from=state.routes.findIndex(item=>item.id===dragRouteId);
    if(from<0)return;
    const [moved]=state.routes.splice(from,1);
    let to=state.routes.findIndex(item=>item.id===route.id);
    if(to<0)to=state.routes.length-1;
    state.routes.splice(after?to+1:to,0,moved);
    dragRouteId=null;
    renderRoutes();
    persistOrder();
  });
}
function renderRoutes(){
  const q=(($('#node-search')||{}).value||'').trim().toLowerCase();
  const visible=state.routes.filter(r=>routeMatches(r,q));
  const body=$('#node-rows'),empty=$('#node-empty'),count=$('#node-count');
  if(count)count.innerHTML=state.routes.length?`共 <b>${state.routes.length}</b> 个节点${q?` · 匹配 <b>${visible.length}</b>`:''}`:'';
  body.innerHTML=visible.map(r=>`<tr data-id="${r.id}">
    <td><div class="cell-name"><span class="drag-handle" title="${q?'搜索时无法拖动排序':'拖动调整顺序'}" ${q?'':'draggable="true"'}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg></span><button class="star ${r.favorite?'on':''}" title="置顶">${r.favorite?'★':'☆'}</button><div style="min-width:0"><strong>${escapeHtml(r.name)}</strong><span class="node-path">/${escapeHtml(r.alias)}/${r.accessMode==='key'?'••••••/':''}</span></div></div></td>
    <td><div class="cell-addr"><code class="addr-text">${ADDR_MASK}</code><button class="icon-btn addr-reveal" title="显示 / 隐藏完整地址">${EYE_SVG}</button><button class="btn ghost addr-copy">复制</button></div></td>
    <td><div class="cell-pills">${statusPills(r)}</div></td>
    <td class="cell-lines"><small class="muted">${r.upstreams.length} 上游${r.streamRewrite&&r.streamRewrite.enabled?' · 分离推流':''}<br>${r.speedLimitMbps?`${r.speedLimitMbps} Mbps`:'不限速'}</small></td>
    <td><div class="row-actions"><button class="btn ghost test-node">测试</button><button class="btn ghost edit-node">编辑</button><button class="btn ghost toggle-node">${r.enabled?'停用':'启用'}</button><button class="btn ghost rotate-node" ${r.accessMode==='alias_only'?'disabled':''}>密码</button>${r.reminderDays?'<button class="btn ghost reminder-node">已保号</button>':''}<button class="btn ghost danger delete-node">删除</button></div></td>
  </tr>`).join('');
  empty.innerHTML=state.routes.length?(visible.length?'':'<article class="panel empty-state"><h3>没有匹配的节点</h3><p>试着清空搜索条件。</p></article>'):'<article class="panel empty-state"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/></svg><h3>创建第一个 Emby 节点</h3><p>只需填写名称、短路径和上游地址。</p></article>';
  body.querySelectorAll('tr').forEach(row=>{const r=state.routes.find(x=>x.id===row.dataset.id);if(!r)return;
    bindRowDrag(row,r);row.querySelector('.test-node').onclick=()=>testConnection(r,row);
    row.querySelector('.addr-copy').onclick=async()=>{try{await navigator.clipboard.writeText(await nodeUrl(r));toast('客户端地址已复制')}catch(e){toast(e.message,true)}};
    row.querySelector('.addr-reveal').onclick=async()=>{const el=row.querySelector('.addr-text'),wrap=row.querySelector('.cell-addr');if(el.dataset.shown){el.textContent=ADDR_MASK;el.dataset.shown='';wrap.classList.remove('shown')}else{el.textContent='加载中…';try{el.textContent=await nodeUrl(r);el.dataset.shown='1';wrap.classList.add('shown')}catch(e){el.textContent=ADDR_MASK;toast(e.message,true)}}};
    row.querySelector('.toggle-node').onclick=()=>patchRoute(r,{enabled:!r.enabled});
    row.querySelector('.star').onclick=()=>patchRoute(r,{favorite:!r.favorite});
    row.querySelector('.edit-node').onclick=()=>openDrawer(r);
    row.querySelector('.rotate-node').onclick=async()=>{if(!confirm('更换连接密码后，所有使用旧地址的客户端会立即失效。确认继续吗？'))return;const custom=askConnectionKey();if(custom===null)return;try{const x=await call(`/routes/${r.id}/rotate-key`,{method:'POST',body:JSON.stringify({accessKey:custom})});r._url=null;showSecret(credentialText(r,x))}catch(e){toast(e.message,true)}};
    const reminder=row.querySelector('.reminder-node');if(reminder)reminder.onclick=async()=>{await call(`/routes/${r.id}/reminder-complete`,{method:'POST',body:'{}'});toast('维护提醒周期已重新开始');await refreshAll()};
    row.querySelector('.delete-node').onclick=async()=>{if(confirm(`确认删除“${r.name}”？`)){await call(`/routes/${r.id}`,{method:'DELETE'});toast('节点已删除');await refreshAll()}};
  });
}
async function patchRoute(route,data){try{await call(`/routes/${route.id}`,{method:'PATCH',body:JSON.stringify(data)});await refreshAll()}catch(e){toast(e.message,true)}}

function renderTraffic(data){const metrics=new Map(data.nodes.map(x=>[x.id,x]));$('#traffic-table').innerHTML=state.routes.map(r=>{const m=metrics.get(r.id)||{},quota=m.quotaBytes||0,ratio=quota?Math.min(100,(m.monthBytes||0)/quota*100):0,rcls=ratio>85?'danger':ratio>50?'warn':'';return`<tr><td><strong>${escapeHtml(r.name)}</strong><br><small class="muted">/${escapeHtml(r.alias)}/</small></td><td>${Number(m.requests||0).toLocaleString()}</td><td>${Number(m.playbackRequests||0).toLocaleString()}</td><td>${bytes(m.bytesOut)}</td><td>${bytes(m.monthBytes)} / ${quota?bytes(quota):'不限额'}<div class="progress"><i class="${rcls}" style="width:${ratio}%"></i></div></td><td>${m.speedLimitMbps?`${m.speedLimitMbps} Mbps`:'不限速'}</td><td>${m.errors||0}</td></tr>`}).join('')}

function fillDiagnosticNodes(){const select=$('#diag-node'),current=select.value;select.innerHTML=state.routes.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');if(state.routes.some(r=>r.id===current))select.value=current}
async function loadRuntime(){const d=await call('/diagnostics');$('#diag-runtime').innerHTML=d.nodes.flatMap(n=>n.upstreams.map((u,i)=>`<span class="pill ${u.circuitOpen||u.lastError?'warn':'on'}">${escapeHtml(n.alias)} · 线路 ${i+1} · ${u.circuitOpen?'熔断':u.lastError?escapeHtml(u.lastError):'就绪'}</span>`)).join('')}
$('#run-diagnostic').onclick=async()=>{const id=value('#diag-node');if(!id)return toast('请先创建节点',true);$('#diagnostic-result').innerHTML='<article class="panel empty-state"><h3>正在探测回源…</h3></article>';try{const d=await call(`/diagnostics/${id}`);const section=(title,list)=>`<article class="panel diag-card"><span class="eyebrow">${title}</span><h3>${escapeHtml(d.node.name)}</h3>${(list||[]).map(x=>{const lat=Number(x.latencyMs),lcls=!x.online?'bad':lat<300?'good':lat<800?'warn':'bad';return`<div class="diag-line"><span>连接状态</span><b class="${x.online?'good':'bad'}">${x.online?'在线':'失败'}</b></div><div class="diag-line"><span>HTTP 状态</span><b>${x.status||'—'}</b></div><div class="diag-line"><span>响应延迟</span><b class="${lcls}">${isFinite(lat)?lat+' ms':x.latencyMs}</b></div><div class="diag-line"><span>Emby 版本</span><b>${escapeHtml(x.embyVersion||'—')}</b></div>${x.tls?`<div class="diag-line"><span>TLS</span><b class="${x.tls.authorized?'good':'warn'}">${x.tls.authorized?'有效':'未验证'}</b></div><div class="diag-line"><span>证书到期</span><b>${escapeHtml(x.tls.validTo||'—')}</b></div>`:''}${x.error?`<div class="diag-line"><span>错误</span><b class="bad">${escapeHtml(x.error)}</b></div>`:''}`}).join('')}</article>`;$('#diagnostic-result').innerHTML=section('主回源',d.main)+(d.stream?section('推流域名',d.stream):'')+`<article class="panel diag-card"><span class="eyebrow">HEADER PREVIEW</span><h3>请求头策略</h3>${Object.entries(d.headerPreview).map(([k,v])=>`<div class="diag-line"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}</article>`;await loadRuntime()}catch(e){toast(e.message,true)}};

async function loadAudit(){const d=await call('/audit');$('#audit-list').innerHTML=d.audit.map(x=>`<div class="event"><time>${new Date(x.at).toLocaleString()}</time><strong>${escapeHtml(x.action)}</strong><div><span>${escapeHtml(x.ip)}</span><br>${escapeHtml(x.detail)}</div></div>`).join('')||'<div class="empty-state"><p>暂无审计事件</p></div>'}
async function loadAgents(){
  const d=await call('/agents');state.agents=d.agents||[];state.panelVersion=d.panelVersion||"";
  const labels={online:'在线',stale:'连接延迟',offline:'失联',revoked:'已撤销'};
  $('#agent-grid').innerHTML=state.agents.map(a=>{const change=a.domainChange,working=change&&['pending','applying'].includes(change.state),failed=change?.state==='failed',local=a.transport==='loopback',isIp=a.proxyMode==='ip',inputDomain=working||failed?(change.mode==='ip'?'':change.desiredDomain):(isIp?'':a.domain),targetLabel=change?(change.mode==='ip'?'IP 反代':change.desiredDomain||''):'',status=change?`<div class="node-test show"><span class="${failed?'bad':working?'warn':'good'}">●</span>&nbsp;${escapeHtml(change.message||'')}${targetLabel&&targetLabel!==a.domain?` · 目标 ${escapeHtml(targetLabel)}`:''}</div>`:'';return`<article class="node-card agent-card" data-id="${escapeHtml(a.id)}" data-status="${escapeHtml(a.status)}"><div class="node-card-head"><div><h3>${escapeHtml(a.name)}</h3><span class="node-path">${escapeHtml(a.transport==='loopback'?'本机环回':'安全轮询')}</span></div><span class="pill ${a.inSync?'on':'warn'}">${a.inSync?'配置已同步':'等待同步'}</span>${a.agentVersion&&state.panelVersion&&a.agentVersion!==state.panelVersion?`<span class="pill warn" title="该机器仍在运行旧版本代理程序">待升级 ${escapeHtml(a.agentVersion)}</span>`:''}</div><div class="tag-row"><span class="pill ${a.status==='online'?'on':'warn'}">${labels[a.status]||'失联'}</span>${local?'':`<span class="pill ${isIp?'':'info'}">${isIp?'IP 反代':'HTTPS 域名'}</span>`}<span class="pill ${working?'warn':a.applyState==='active'?'info':'warn'}">${working?(change.mode==='ip'?'正在切换 IP 反代':'正在配置域名'):a.applyState==='active'?'代理运行中':'已注册 · 等待配置'}</span></div><div class="node-meta"><div><small>当前生效域名</small><strong>${isIp?('IP 反代'+(a.domain?' · '+escapeHtml(a.domain):'')):escapeHtml(a.domain||'尚未设置')}</strong></div><div><small>已选节点</small><strong>${a.routeIds.length} 个</strong></div><div><small>配置版本</small><strong>revision ${a.appliedRevision} / ${a.desiredRevision}</strong></div><div><small>最近回执</small><strong>${a.lastSeen?new Date(a.lastSeen).toLocaleString():'尚未连接'}</strong></div></div><div class="agent-editor"><label>代理域名<input class="agent-domain" value="${escapeHtml(inputDomain||'')}" placeholder="${local?'emby.example.com':'留空＝用本机 IP 反代'}" ${working?'disabled':''}><small>${local?'保存后自动配置 Nginx、申请证书并停用旧代理域名，必须与面板域名不同。':'填写域名自动申请证书走 HTTPS；留空则以本机公网 IP 明文 HTTP 反代。'}</small></label><details class="agent-routes"><summary>部署节点<span class="routes-count">已选 ${a.routeIds.length} / ${state.routes.length}</span></summary>${state.routes.length?`<div class="route-tools"><button type="button" class="route-bulk route-all">全选</button><button type="button" class="route-bulk route-none">全不选</button>${state.routes.length>8?'<input class="agent-route-search" placeholder="搜索节点">':''}</div>`:''}<div class="agent-route-list">${state.routes.map(r=>`<label class="${a.routeIds.includes(r.id)?'checked':''}" data-search="${escapeHtml((r.name+' '+r.alias).toLowerCase())}"><input type="checkbox" data-route-id="${r.id}" ${a.routeIds.includes(r.id)?'checked':''}><span><b>${escapeHtml(r.name)}</b><small>/${escapeHtml(r.alias)}/</small></span></label>`).join('')||'<small>请先创建 Emby 节点</small>'}</div></details><div class="node-actions"><button class="btn primary save-agent" ${working?'disabled':''}>${a.automaticDomainSwitch?'保存并切换域名':'保存机器配置'}</button>${a.canDelete?'<button class="btn ghost danger delete-agent">从面板删除</button>':''}</div></div>${status||a.error?status||`<div class="node-test show"><span class="bad">●</span>&nbsp;${escapeHtml(a.error)}</div>`:''}${a.agentVersion&&state.panelVersion&&a.agentVersion!==state.panelVersion?`<div class="node-test show"><span class="warn">●</span>&nbsp;代理程序 ${escapeHtml(a.agentVersion)} 落后于面板 ${escapeHtml(state.panelVersion)}，在该机器执行：<code>sudo aegis-relay-agent update</code></div>`:''}</article>`}).join('')||'<article class="panel empty-state"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M12 7v4M6.7 16.8l3.8-4M17.3 16.8l-3.8-4"/></svg><h3>添加第一台代理机器</h3><p>生成一次性安装指令，机器注册后会自动出现。</p><button class="btn primary open-agent">添加机器</button></article>';
  $('#agent-grid').querySelectorAll('.agent-card').forEach(card=>{const agent=state.agents.find(item=>item.id===card.dataset.id);const search=card.querySelector('.agent-route-search');if(search)search.oninput=()=>{const q=search.value.trim().toLowerCase();card.querySelectorAll('.agent-route-list label').forEach(l=>{l.style.display=!q||(l.dataset.search||'').includes(q)?'':'none'})};const counter=card.querySelector('.routes-count'),syncRoutes=()=>{card.querySelectorAll('[data-route-id]').forEach(b=>b.closest('label').classList.toggle('checked',b.checked));if(counter)counter.textContent=`已选 ${card.querySelectorAll('[data-route-id]:checked').length} / ${state.routes.length}`};card.querySelectorAll('[data-route-id]').forEach(box=>box.addEventListener('change',syncRoutes));const allBtn=card.querySelector('.route-all'),noneBtn=card.querySelector('.route-none');if(allBtn)allBtn.onclick=()=>{card.querySelectorAll('[data-route-id]').forEach(b=>b.checked=true);syncRoutes()};if(noneBtn)noneBtn.onclick=()=>{card.querySelectorAll('[data-route-id]').forEach(b=>b.checked=false);syncRoutes()};card.querySelector('.save-agent').onclick=async()=>{try{const routeIds=[...card.querySelectorAll('[data-route-id]:checked')].map(input=>input.dataset.routeId),domain=card.querySelector('.agent-domain').value.trim(),currentInput=agent.proxyMode==='ip'?'':(agent.domain||''),modeChanged=domain!==currentInput;await call(`/agents/${agent.id}`,{method:'PATCH',body:JSON.stringify({domain,routeIds})});toast(!modeChanged?'代理机器配置已保存':(domain?'域名切换已提交，正在申请证书':'已提交：切换为 IP 反代（HTTP）'));await refreshAll();await loadAgents();if(modeChanged)watchDomainSwitch()}catch(e){toast(e.message,true)}};const remove=card.querySelector('.delete-agent');if(remove)remove.onclick=async()=>{if(!confirm(`确认从面板删除“${agent.name}”？请先在对应机器执行卸载。`))return;try{await call(`/agents/${agent.id}`,{method:'DELETE'});toast('代理机器已从面板删除');await loadAgents()}catch(e){toast(e.message,true)}}});
  $$('.open-agent').forEach(button=>button.onclick=openAgentModal);
}
let domainWatchTimer=null;
function watchDomainSwitch(){clearTimeout(domainWatchTimer);domainWatchTimer=setTimeout(async()=>{try{await loadAgents();const working=state.agents.some(a=>a.domainChange&&['pending','applying'].includes(a.domainChange.state));if(working){watchDomainSwitch();return}const failed=state.agents.find(a=>a.domainChange?.state==='failed');if(failed){toast(failed.domainChange.message||'切换失败',true);return}await refreshAll()}catch{watchDomainSwitch()}},4000)}
async function loadDeployment(){const d=await call('/deployment');$('#deployment-status').innerHTML=`<article class="deploy-card"><small>管理面板域名</small><strong>${escapeHtml(d.publicBaseUrl||'尚未设置')}</strong></article><article class="deploy-card"><small>本地代理域名</small><strong>${escapeHtml(d.localProxyBaseUrl||'尚未设置')}</strong></article><article class="deploy-card"><small>域名隔离</small><strong>${d.splitDomains?'已分离':'等待在代理机器中切换'}</strong></article>`;setValue('#certificate-email',d.certificateEmail||'');$('#certificate-email-state').textContent=d.certificateEmail?'已配置':'未配置';$('#certificate-email-state').className=`pill ${d.certificateEmail?'on':'warn'}`;return d}
async function loadNotifications(){const d=await call('/notifications');$('#telegram-state').textContent=d.telegram.configured?'已配置':'未配置';$('#telegram-enabled').checked=d.telegram.enabled;setValue('#telegram-chat','');setValue('#telegram-token','')}


function qrSvg(qr){
  const quiet=4,scale=5,dim=(qr.size+quiet*2)*scale;
  let path='';
  qr.rows.forEach((row,y)=>{[...row].forEach((bit,x)=>{if(bit==='1')path+=`M${(x+quiet)*scale} ${(y+quiet)*scale}h${scale}v${scale}h-${scale}z`})});
  return `<svg viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img" aria-label="两步验证二维码"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
function showTotpStage(stage){for(const id of ['#totp-off','#totp-setup','#totp-on'])$(id).classList.toggle('hidden',id!=='#'+stage)}
async function loadAccount(){
  const d=await call('/account');
  $('#account-user').textContent=d.username||'admin';
  $('#totp-state').textContent=d.totpEnabled?'已开启':'未开启';
  $('#totp-state').className=`pill ${d.totpEnabled?'on':'warn'}`;
  $('#totp-hint').textContent=d.totpEnabled?`登录时需要输入动态验证码。剩余恢复码 ${d.recoveryRemaining} 个。`:'开启后，登录时除密码外还需要输入动态验证码。';
  showTotpStage(d.totpEnabled?'totp-on':'totp-off');
  for(const id of ['#pw-current','#pw-new','#pw-confirm','#totp-password','#totp-code','#totp-off-password','#totp-off-code'])setValue(id,'');
}
$('#save-password').onclick=async()=>{
  if(value('#pw-new').length<14)return toast('新密码至少 14 位',true);
  if(value('#pw-new')!==value('#pw-confirm'))return toast('两次输入的新密码不一致',true);
  try{await call('/account/password',{method:'POST',body:JSON.stringify({currentPassword:value('#pw-current'),newPassword:value('#pw-new')})});toast('密码已更新');await loadAccount()}catch(e){toast(e.message,true)}
};
$('#totp-begin').onclick=async()=>{
  try{
    const d=await call('/account/totp/begin',{method:'POST',body:JSON.stringify({password:value('#totp-password')})});
    $('#totp-qr').innerHTML=qrSvg(d.qr);$('#totp-secret').textContent=d.secret;
    showTotpStage('totp-setup');setTimeout(()=>$('#totp-code').focus(),0);
  }catch(e){toast(e.message,true)}
};
$('#totp-cancel').onclick=()=>showTotpStage('totp-off');
$('#totp-confirm').onclick=async()=>{
  try{
    const d=await call('/account/totp/enable',{method:'POST',body:JSON.stringify({code:value('#totp-code')})});
    await loadAccount();
    showSecret(`恢复码（每行一个，只显示这一次）\n${d.recovery.join('\n')}`,{eyebrow:'2FA RECOVERY',title:'两步验证已开启',description:'请立即离线保存这些恢复码；丢失验证器时可用它们登录。'});
  }catch(e){toast(e.message,true)}
};
$('#totp-disable').onclick=async()=>{
  if(!confirm('关闭两步验证后，登录将只需要密码。确认继续吗？'))return;
  try{await call('/account/totp/disable',{method:'POST',body:JSON.stringify({password:value('#totp-off-password'),code:value('#totp-off-code')})});toast('两步验证已关闭');await loadAccount()}catch(e){toast(e.message,true)}
};
async function savePanelIcon(payload){const d=await call('/account/icon',{method:'PUT',body:JSON.stringify(payload)});applyPanelIcon(d.icon||'');return d}
$('#icon-upload').onclick=()=>$('#icon-file').click();
$('#icon-file').onchange=()=>{
  const file=$('#icon-file').files[0];
  if(!file)return;
  if(file.size>256*1024){toast('图标不能超过 256KB',true);$('#icon-file').value='';return}
  const reader=new FileReader();
  reader.onerror=()=>{toast('读取文件失败',true);$('#icon-file').value=''};
  reader.onload=async()=>{try{await savePanelIcon({icon:reader.result});toast('面板图标已更新')}catch(e){toast(e.message,true)}finally{$('#icon-file').value=''}};
  reader.readAsDataURL(file);
};
$('#icon-apply-url').onclick=async()=>{
  const url=value('#icon-url').trim();
  if(!url)return toast('请输入图片地址',true);
  const btn=$('#icon-apply-url');btn.disabled=true;btn.textContent='拉取中…';
  try{await savePanelIcon({url});setValue('#icon-url','');toast('面板图标已更新')}catch(e){toast(e.message,true)}finally{btn.disabled=false;btn.textContent='拉取并使用'}
};
$('#icon-reset').onclick=async()=>{try{await savePanelIcon({icon:''});toast('已恢复默认图标')}catch(e){toast(e.message,true)}};
async function switchPage(page){state.page=page;$$('.page').forEach(x=>x.classList.add('hidden'));$(`#${page}-page`).classList.remove('hidden');$$('[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page));$('#page-title').textContent=titles[page];$('#breadcrumb').textContent=`控制台 / ${titles[page]}`;const canAdd=page==='dashboard'||page==='nodes'||page==='agents';$('#global-add').style.display=canAdd?'':'none';$('#global-add').innerHTML=page==='agents'?'<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>添加机器':'<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新增节点';$('#global-add').onclick=page==='agents'?openAgentModal:()=>openDrawer();closeMenu();if(page==='audit')await loadAudit();if(page==='agents')await loadAgents();if(page==='deployment')await loadDeployment();if(page==='notifications')await loadNotifications();if(page==='account')await loadAccount();if(page==='diagnostics')await loadRuntime()}
function closeMenu(){$('#mobile-menu').classList.add('hidden')}
$('#theme-toggle').onclick=toggleTheme;
$('#nav-toggle').onclick=()=>$('#mobile-menu').classList.toggle('hidden');
$('#mobile-menu').onclick=e=>{if(e.target.id==='mobile-menu')closeMenu()};
$('#nav-logout').onclick=()=>$('#logout').onclick();
$$('[data-page]').forEach(b=>b.onclick=()=>switchPage(b.dataset.page));$$('[data-jump]').forEach(b=>b.onclick=()=>switchPage(b.dataset.jump));

function setValue(id,v){$(id).value=v??''}function resetDrawer(){state.editing=null;$('#form-title').textContent='新增 Emby 节点';for(const id of ['#name','#alias','#access-key','#tags','#notes','#upstreams','#speed-limit','#monthly-quota','#reminder-days','#profile-ua','#profile-client','#profile-device','#profile-device-id'])setValue(id,'');for(const id of ['#private','#show-home','#favorite'])setValue(id,'false');setValue('#access-mode','key');setValue('#tls','true');$('#access-mode').disabled=false;$('#access-key').disabled=false;$('#profile-enabled').checked=false;setValue('#stream-rewrite-domains','');$('#stream-rewrite-enabled').checked=false;$('#save-node').textContent='创建节点';renderPresets();markActivePreset()}
function openDrawer(route=null){resetDrawer();if(route){state.editing=route.id;$('#form-title').textContent=`编辑 · ${route.name}`;setValue('#name',route.name);setValue('#alias',route.alias);setValue('#tags',route.tags.join(', '));setValue('#notes',route.notes);setValue('#upstreams',route.upstreams.join('\n'));setValue('#access-mode',route.accessMode);$('#access-mode').disabled=false;$('#access-key').disabled=false;$('#access-key').placeholder=route.accessMode==='key'?'如需更换密码请用列表中的“密码”按钮':'留空则安全随机生成';setValue('#private',String(route.allowPrivate));setValue('#tls',String(route.tlsVerify));setValue('#show-home',String(route.showOnHome));setValue('#favorite',String(route.favorite));setValue('#speed-limit',route.speedLimitMbps);setValue('#monthly-quota',route.monthlyQuotaGB);setValue('#reminder-days',route.reminderDays);$('#profile-enabled').checked=route.clientProfile.enabled===true;setValue('#profile-ua',route.clientProfile.userAgent);setValue('#profile-client',route.clientProfile.client);setValue('#profile-device',route.clientProfile.deviceName);setValue('#profile-device-id',route.clientProfile.deviceId);const sr=route.streamRewrite||{};$('#stream-rewrite-enabled').checked=sr.enabled===true;setValue('#stream-rewrite-domains',(sr.domains||[]).join('\n'));$('#save-node').textContent='保存修改'}markActivePreset();$('#drawer-backdrop').classList.remove('hidden');$('#node-drawer').classList.remove('hidden')}
function closeDrawer(){$('#drawer-backdrop').classList.add('hidden');$('#node-drawer').classList.add('hidden')}
function formData(){return{name:value('#name'),alias:value('#alias'),accessKey:value('#access-key'),tags:value('#tags'),notes:value('#notes'),upstreams:value('#upstreams'),accessMode:value('#access-mode'),allowPrivate:bool('#private'),tlsVerify:bool('#tls'),showOnHome:bool('#show-home'),favorite:bool('#favorite'),speedLimitMbps:Number(value('#speed-limit')||0),monthlyQuotaGB:Number(value('#monthly-quota')||0),reminderDays:Number(value('#reminder-days')||0),clientProfile:{enabled:$('#profile-enabled').checked,userAgent:value('#profile-ua'),client:value('#profile-client'),deviceName:value('#profile-device'),deviceId:value('#profile-device-id')},streamRewrite:{enabled:$('#stream-rewrite-enabled').checked,domains:value('#stream-rewrite-domains')}}}
$('#access-mode').onchange=()=>{$('#access-key').disabled=value('#access-mode')==='alias_only';if($('#access-key').disabled)setValue('#access-key','')};
$('#save-node').onclick=async()=>{try{const data=formData();if(state.editing){const before=state.routes.find(x=>x.id===state.editing),changed=before&&before.accessMode!==data.accessMode;if(changed&&!confirm(data.accessMode==='key'?'开启连接密码后，客户端地址会变成带密码的新地址，所有现有客户端都需要重新填写。确认继续吗？':'关闭连接密码后，只要知道短路径的人都能访问这个节点，且客户端地址会变短。确认继续吗？'))return;if(!changed){delete data.accessMode;delete data.accessKey}const updated=await call(`/routes/${state.editing}`,{method:'PATCH',body:JSON.stringify(data)});const target=state.routes.find(x=>x.id===state.editing);if(target)target._url=null;if(changed&&updated.clientPath){closeDrawer();await refreshAll();showSecret(credentialText(updated.route,updated),{title:'客户端地址已更新',description:'连接密码设置已更改，请把下面的新地址同步到所有客户端。'});return}toast('节点已更新')}else{const x=await call('/routes',{method:'POST',body:JSON.stringify(data)});showSecret(credentialText(x.route,x))}closeDrawer();await refreshAll()}catch(e){toast(e.message,true)}};
$('#profile-ua').oninput=markActivePreset;$('#close-drawer').onclick=closeDrawer;$('#cancel-edit').onclick=closeDrawer;$('#drawer-backdrop').onclick=closeDrawer;$$('.add-node').forEach(b=>b.onclick=()=>openDrawer());$('#global-add').onclick=()=>openDrawer();

async function openAgentModal(){try{setValue('#agent-name','');setValue('#agent-domain-new','');$('#agent-command-wrap').classList.add('hidden');$('#agent-enroll-form').classList.remove('hidden');const routesHost=$('#agent-enroll-routes');routesHost.innerHTML=state.routes.map(route=>`<label><input type="checkbox" data-enroll-route="${route.id}"><span><b>${escapeHtml(route.name)}</b><small>/${escapeHtml(route.alias)}/</small></span></label>`).join('')||'<small>暂时不部署节点，注册后仍可选择。</small>';routesHost.onchange=e=>{const box=e.target.closest('[data-enroll-route]');if(box)box.closest('label').classList.toggle('checked',box.checked)};$('#agent-modal').classList.remove('hidden');setTimeout(()=>$('#agent-name').focus(),0)}catch(e){toast(e.message,true)}}
function closeAgentModal(){$('#agent-modal').classList.add('hidden');$('#agent-command').textContent=''}
$('#add-agent').onclick=openAgentModal;$('#close-agent-modal').onclick=closeAgentModal;
$('#create-enrollment').onclick=async()=>{const button=$('#create-enrollment');try{button.disabled=true;button.textContent='正在生成…';const routeIds=[...$$('[data-enroll-route]:checked')].map(input=>input.dataset.enrollRoute),result=await call('/agents/enrollment',{method:'POST',body:JSON.stringify({name:value('#agent-name'),domain:value('#agent-domain-new'),routeIds})});$('#agent-command').textContent=result.command;$('#agent-command-expiry').textContent=`有效期至 ${new Date(result.expiresAt).toLocaleTimeString()}`;$('#agent-enroll-form').classList.add('hidden');$('#agent-command-wrap').classList.remove('hidden')}catch(e){toast(e.message,true)}finally{button.disabled=false;button.textContent='生成一键安装指令'}};
$('#copy-agent-command').onclick=async()=>{await navigator.clipboard.writeText($('#agent-command').textContent);toast('安装指令已复制')};

$('#node-search').oninput=()=>renderRoutes();
$('#export-btn').onclick=async()=>{try{const d=await call('/export'),blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`aegis-relay-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);toast('配置已导出；连接密码不会包含在文件中')}catch(e){toast(e.message,true)}};
$('#import-btn').onclick=()=>$('#import-modal').classList.remove('hidden');$('#close-import').onclick=()=>$('#import-modal').classList.add('hidden');$('#do-import').onclick=async()=>{try{const parsed=JSON.parse(value('#import-json')),d=await call('/import',{method:'POST',body:JSON.stringify(parsed)});$('#import-modal').classList.add('hidden');const secrets=d.credentials.map(x=>`${x.alias}\n${x.clientPath}${x.accessKey?`\n${x.accessKey}`:''}`).join('\n\n');if(secrets)showSecret(`新生成的节点凭据\n\n${secrets}`,{eyebrow:'IMPORT CREDENTIALS',title:'导入节点连接信息',description:'这些节点地址和连接密码可由管理员随时再次查看。'});toast(`已导入 ${d.imported} 个节点`);await refreshAll()}catch(e){toast(e.message,true)}};
$('#close-modal').onclick=()=>$('#modal').classList.add('hidden');$('#copy-secret').onclick=async()=>{await navigator.clipboard.writeText($('#secret').textContent);toast('已复制到剪贴板')};
$('#save-notifications').onclick=async()=>{try{await call('/notifications',{method:'PUT',body:JSON.stringify({telegram:{enabled:$('#telegram-enabled').checked,botToken:value('#telegram-token'),chatId:value('#telegram-chat')}})});toast('通知设置已保存');await loadNotifications()}catch(e){toast(e.message,true)}};$('#test-notifications').onclick=async()=>{try{await call('/notifications/test',{method:'POST',body:'{}'});toast('测试消息已发送')}catch(e){toast(e.message,true)}};
$('#save-certificate-email').onclick=async()=>{try{await call('/deployment',{method:'PUT',body:JSON.stringify({certificateEmail:value('#certificate-email')})});toast('统一证书邮箱已保存');await loadDeployment()}catch(e){toast(e.message,true)}};

async function streamDashboard(){if(!state.csrf)return;try{const response=await fetch(base+'/events',{headers:{'x-csrf-token':state.csrf}});if(response.status===401){showLogin();return}if(!response.ok||!String(response.headers.get('content-type')||'').includes('text/event-stream'))throw Error('event stream unavailable');const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const chunks=buffer.split('\n\n');buffer=chunks.pop();for(const chunk of chunks){const line=chunk.split('\n').find(x=>x.startsWith('data: '));if(line){state.dashboard=JSON.parse(line.slice(6));renderDashboard(state.dashboard);renderTraffic(state.dashboard)}}}}catch{if(!state.csrf)return;$('#live-state').innerHTML='<i></i>重连中';setTimeout(streamDashboard,5000)}}
start();
