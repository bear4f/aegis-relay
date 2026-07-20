import https from 'node:https';

function postTelegram(token,chatId,text){
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true});
    const req=https.request({hostname:'api.telegram.org',path:`/bot${token}/sendMessage`,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},timeout:10_000},res=>{
      res.resume();
      res.on('end',()=>res.statusCode<300?resolve():reject(new Error(`Telegram HTTP ${res.statusCode}`)));
    });
    req.on('timeout',()=>req.destroy(new Error('Telegram timeout')));
    req.on('error',reject);
    req.end(body);
  });
}

export class Notifier{
  constructor(store,metrics){this.store=store;this.metrics=metrics;store.data.notifications||={telegram:{enabled:false,botToken:'',chatId:''}}}
  view(){const t=this.store.data.notifications.telegram||{};return{telegram:{enabled:t.enabled===true,configured:!!(t.botToken&&t.chatId),chatId:t.chatId?`${String(t.chatId).slice(0,3)}••••${String(t.chatId).slice(-2)}`:''}}}
  configure(value={}){const t=value.telegram||{},current=this.store.data.notifications.telegram||{};if(t.botToken!==undefined&&t.botToken!==''){if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(String(t.botToken)))throw new Error('invalid Telegram bot token');current.botToken=String(t.botToken)}if(t.chatId!==undefined&&t.chatId!=='')current.chatId=String(t.chatId).trim().slice(0,80);current.enabled=t.enabled===true;if(current.enabled&&(!current.botToken||!current.chatId))throw new Error('Telegram token and chat ID are required');this.store.data.notifications.telegram=current;this.store.save();return this.view()}
  async test(){const t=this.store.data.notifications.telegram;if(!t?.botToken||!t?.chatId)throw new Error('Telegram is not configured');await postTelegram(t.botToken,t.chatId,'AegisRelay 通知测试成功。');return{ok:true}}
  async tick(routes){const t=this.store.data.notifications.telegram;if(!t?.enabled||!t.botToken||!t.chatId)return;const now=Date.now();for(const r of routes){const days=Number(r.reminderDays||0);if(!days)continue;const base=new Date(r.reminderLastAt||r.createdAt||now).getTime(),due=base+days*86400000;if(now<due)continue;if(r.reminderNotifiedAt&&now-new Date(r.reminderNotifiedAt).getTime()<86400000)continue;try{await postTelegram(t.botToken,t.chatId,`AegisRelay 保号提醒：${r.name||r.alias} 已达到 ${days} 天维护周期。`);r.reminderNotifiedAt=new Date().toISOString();this.store.save()}catch{}}
  }
}
