const API='';
let _ctxPromise=null;
// Only 3 of ~60 fetch() calls in this file used fetchTimeout before this ---
// every other one could hang forever on a dead connection, the same failure
// mode that froze the Telegram status and task list for a week. Patching
// window.fetch once here gives every call in the app a 15s timeout by
// default, without touching each call site individually.
(function(){
  const _rawFetch=window.fetch.bind(window);
  window.fetch=function(input,init={}){
    if(init.signal)return _rawFetch(input,init); // caller already manages its own abort
    const ctrl=new AbortController();
    const t=setTimeout(()=>ctrl.abort(),15000);
    return _rawFetch(input,{...init,signal:ctrl.signal}).finally(()=>clearTimeout(t));
  };
})();
function fetchTimeout(url,opts={},ms=10000){
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),ms);
  return fetch(url,{...opts,signal:ctrl.signal}).finally(()=>clearTimeout(t));
}
function getContext(force){
  if(!_ctxPromise||force)_ctxPromise=fetchTimeout(API+'/api/context').then(r=>{if(!r.ok)throw new Error('ctx '+r.status);return r.json();}).catch(err=>{_ctxPromise=null;throw err;});
  return _ctxPromise;
}
/* ── net balance: one source of truth (same numbers as the finance tab) ── */
function fmtNet(n,d=0){return `${n<0?'−':'+'}R${Math.abs(n).toFixed(d)}`;}
async function getMonthNet(fallback){
  try{
    const r=await fetchTimeout(API+'/api/finance',{cache:'no-store'});
    if(!r.ok)throw new Error('fin '+r.status);
    const{totals}=await r.json();
    const inc=totals.find(t=>t.type==='income')?.total||0,exp=totals.find(t=>t.type==='expense')?.total||0;
    return inc-exp;
  }catch{return typeof fallback==='number'?fallback:null;}
}
function setBriefMoney(n){
  const row=document.getElementById('dbMoneyRow'),val=document.getElementById('dbMoneyVal');
  if(!row||!val)return;
  if(typeof n!=='number'){row.style.display='none';return;}
  val.textContent=`${fmtNet(n)} net`;row.style.display='flex';
  const b=document.getElementById('dailyBrief');if(b)b.style.display='block';
}
async function refreshBriefMoney(){
  let fb=null;try{fb=(await getContext(true)).financeNet;}catch{}
  setBriefMoney(await getMonthNet(fb));
}
// ── Bulk select state ──────────────────────────────────────────────────────────
let _selectMode = false;
const _selectedIds = new Set();

function enterSelectMode(firstId) {
  _selectMode = true;
  document.body.classList.add('select-mode');
  _selectedIds.clear();
  if (firstId != null) _selectedIds.add(firstId);
  _updateBulkBar();
}

function exitSelectMode() {
  _selectMode = false;
  document.body.classList.remove('select-mode');
  _selectedIds.clear();
  document.querySelectorAll('.task.selected').forEach(el => el.classList.remove('selected'));
  _updateBulkBar();
}

function _updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  const count = document.getElementById('bulkCount');
  if (!bar) return;
  const n = _selectedIds.size;
  bar.classList.toggle('show', _selectMode);
  if (count) count.textContent = `${n} selected`;
}

document.getElementById('bulkCancelBtn')?.addEventListener('click', exitSelectMode);

document.getElementById('bulkDoneBtn')?.addEventListener('click', async () => {
  const ids = [..._selectedIds];
  if (!ids.length) return;
  exitSelectMode();
  try {
    await fetch(API+'/api/tasks/bulk-done', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ ids }),
    });
    toast(`✓ ${ids.length} task${ids.length===1?'':'s'} done`);
    loadTasks();
  } catch { toast('bulk complete failed — try again'); }
});

document.getElementById('bulkDeleteBtn')?.addEventListener('click', () => {
  const ids = [..._selectedIds];
  if (!ids.length) return;
  exitSelectMode();
  let undone = false;
  // Hide cards immediately
  ids.forEach(id => {
    const el = openList.querySelector(`[data-id="${id}"]`);
    if (el) { el.style.transition='opacity .18s'; el.style.opacity='0'; }
  });
  const del = setTimeout(async () => {
    if (undone) { ids.forEach(id => { const el=openList.querySelector(`[data-id="${id}"]`); if(el)el.style.opacity=''; }); return; }
    try {
      await fetch(API+'/api/tasks/bulk-delete', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ ids }),
      });
      loadTasks();
    } catch { toast('bulk delete failed — try again'); loadTasks(); }
  }, 4000);
  toast(`deleted ${ids.length} task${ids.length===1?'':'s'}`, () => { undone=true; clearTimeout(del); ids.forEach(id=>{const el=openList.querySelector(`[data-id="${id}"]`);if(el)el.style.opacity='';})});
});

let finType='expense';
let deferredInstallPrompt = null;

const installBanner = document.getElementById('installBanner');
const installAppBtn = document.getElementById('installAppBtn');
const installBannerText = document.getElementById('installBannerText');
const notificationBanner = document.getElementById('notificationBanner');
const notificationBannerText = document.getElementById('notificationBannerText');
const notificationBannerBtn = document.getElementById('notificationBannerBtn');

function showInstallBanner(){
  if(!installBanner) return;
  const isStandalone=window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if(isStandalone){
    installBanner.style.display='none';
    return;
  }
  const ua=navigator.userAgent||'';
  const isApple=/iPhone|iPad|iPod/i.test(ua);
  const isAndroid=/Android/i.test(ua);
  if(isApple){
    if(installBannerText)installBannerText.textContent='install Core PA: Share → Add to Home Screen';
    if(installAppBtn)installAppBtn.textContent='how →';
  }else if(isAndroid&&!deferredInstallPrompt){
    if(installBannerText)installBannerText.textContent='install Core PA: browser menu → Add to Home screen';
    if(installAppBtn)installAppBtn.textContent='how →';
  }else{
    if(installBannerText)installBannerText.textContent='add Core PA to your home screen';
    if(installAppBtn)installAppBtn.textContent='install →';
  }
  installBanner.style.display='flex';
}

async function promptInstallApp(){
  if(!deferredInstallPrompt){
    const isApple=/iPhone|iPad|iPod/i.test(navigator.userAgent||'');
    notify({msg:isApple?'tap Share → Add to Home Screen':'open your browser menu → Add to Home screen'});
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBanner.style.display='none';
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  showInstallBanner();
});

if(installAppBtn){
  installAppBtn.addEventListener('click', promptInstallApp);
}

function showNotificationBanner(){
  if(!notificationBanner||!('Notification' in window)||Notification.permission==='granted'){
    if(notificationBanner)notificationBanner.style.display='none';
    return;
  }
  if(Notification.permission==='denied'){
    if(notificationBannerText)notificationBannerText.textContent='notifications are blocked — allow them in browser settings';
    if(notificationBannerBtn)notificationBannerBtn.textContent='settings →';
  }else{
    if(notificationBannerText)notificationBannerText.textContent='allow notifications so Core can reach you';
    if(notificationBannerBtn)notificationBannerBtn.textContent='allow →';
  }
  notificationBanner.style.display='flex';
}
notificationBannerBtn?.addEventListener('click',async()=>{
  if(Notification.permission==='denied'){
    showPushSettingsHelp();
    openPhoneNotificationSettings();
    return;
  }
  await enablePushOnThisDevice();
  if(Notification.permission==='granted')notificationBanner.style.display='none';
});

const _fetch=window.fetch.bind(window);
window.fetch=async(url,opts={})=>{
  // iOS Safari — especially in standalone/Home-Screen mode — doesn't reliably
  // default to sending same-origin cookies on fetch() the way desktop Chrome
  // does. Without this, /api/auth/me and every other API call come back
  // unauthenticated on iPhone even though the pa_session cookie is set.
  const res=await _fetch(url,{credentials:'include',...opts});
  // Monkey-patch res.json so that non-OK responses throw a clean error
  // instead of trying to parse an HTML error page as JSON.
  if(!res.ok){
    const orig=res.json.bind(res);
    res.json=async()=>{
      let body;
      try{body=await orig();}catch{throw new Error(`API error ${res.status}`);}
      if(body&&body.error) throw new Error(body.error);
      throw new Error(`API error ${res.status}`);
    };
  }
  return res;
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function timeAgo(iso){
  const s=(Date.now()-new Date(iso))/1000;
  if(s<3600)return`${Math.max(1,Math.floor(s/60))}m ago`;
  if(s<86400)return`${Math.floor(s/3600)}h ago`;
  return`${Math.floor(s/86400)}d ago`;
}
function fmtRemind(iso){return new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
function autoGrow(el){el.style.height='auto';el.style.height=el.scrollHeight+'px'}
function haptic(ms=10){try{navigator.vibrate?.(ms);}catch{}}
let _tt,_undoFn=null;
function toast(msg,onUndo){
  const t=document.getElementById('toast');
  _undoFn=onUndo||null;
  t.innerHTML=onUndo?`${esc(msg)}<span class="toast-undo">undo</span>`:esc(msg);
  t.classList.add('show');
  const readMs=Math.max(2200,Math.min(6000,msg.length*45));
  clearTimeout(_tt);_tt=setTimeout(()=>{t.classList.remove('show');_undoFn=null;},onUndo?4500:readMs);
}
document.getElementById('toast').addEventListener('click',e=>{
  if(e.target.classList.contains('toast-undo')&&_undoFn){const fn=_undoFn;_undoFn=null;clearTimeout(_tt);document.getElementById('toast').classList.remove('show');fn();}
});

/* ── Custom notifications ────────────────────────────────────────────────
   In-app rich cards always show. If the user has granted OS notification
   permission AND the tab is hidden/backgrounded, we also fire a native
   Notification so reminders land even when Core PA isn't the active tab.
   (True background push while the app/browser is fully closed needs a
   server push subscription — sw.js is already registered, so that's a
   clean follow-up, not a blank slate.)
─────────────────────────────────────────────────────────────────────────── */
const notifyStack=document.getElementById('notifyStack');
const NOTIFY_ICON_SVG=`<svg viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="22" cy="22" rx="16" ry="6.6" transform="rotate(25 22 22)" stroke="#9a9aa4" stroke-width="1.6" fill="none"/>
  <ellipse cx="22" cy="22" rx="16" ry="6.6" transform="rotate(-25 22 22)" stroke="var(--pink)" stroke-width="1.6" fill="none"/>
  <circle cx="22" cy="22" r="8" fill="url(#notifySphereGrad)"/>
  <defs><radialGradient id="notifySphereGrad" cx="38%" cy="32%" r="65%">
    <stop offset="0%" stop-color="#fff"/><stop offset="45%" stop-color="#c7c7cf"/><stop offset="100%" stop-color="#3a3a40"/>
  </radialGradient></defs>
</svg>`;

let _appReady=false;
const _notifyQueue=[];
let _notifyTimer=null;
const NOTIFY_STAGGER_MS=900;
function notify(opts={}){
  _notifyQueue.push(opts);
  _pumpNotifyQueue();
  return {remove:()=>{const i=_notifyQueue.indexOf(opts);if(i>-1)_notifyQueue.splice(i,1);}};
}
function _pumpNotifyQueue(){
  if(_notifyTimer||!_appReady||!_notifyQueue.length)return;
  _renderNotify(_notifyQueue.shift());
  _notifyTimer=setTimeout(()=>{_notifyTimer=null;_pumpNotifyQueue();},NOTIFY_STAGGER_MS);
}
function _flushPendingNotifies(){
  _pumpNotifyQueue();
}
function _renderNotify({title,msg,actions=[],ttl=6000,compact=false}={}){
  const card=document.createElement('div');
  card.className=compact?'notify-card compact':'notify-card';
  card.innerHTML=`
    <div class="notify-icon">${NOTIFY_ICON_SVG}</div>
    <div class="notify-body">
      <div class="notify-title">${esc(title||'Core PA')}</div>
      ${msg?`<div class="notify-msg${compact?' shimmer-text':''}">${esc(msg)}</div>`:''}
      ${actions.length?`<div class="notify-actions">${actions.map((a,i)=>`<button class="notify-btn ${a.primary?'primary':'ghost'}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>`:''}
    </div>
    <button class="notify-close" aria-label="dismiss">×</button>`;
  const remove=()=>{card.classList.add('leaving');setTimeout(()=>card.remove(),280)};
  let dismissTimer=ttl?setTimeout(remove,ttl):null;
  card.addEventListener('mouseenter',()=>clearTimeout(dismissTimer));
  card.addEventListener('mouseleave',()=>{if(ttl)dismissTimer=setTimeout(remove,ttl)});
  card.querySelector('.notify-close').addEventListener('click',e=>{e.stopPropagation();clearTimeout(dismissTimer);remove();});
  actions.forEach((a,i)=>{
    card.querySelector(`.notify-btn[data-i="${i}"]`)?.addEventListener('click',e=>{
      e.stopPropagation();clearTimeout(dismissTimer);a.onClick?.();remove();
    });
  });
  notifyStack.appendChild(card);
  return {remove};
}

let _notifPermRequested = localStorage.getItem('core-pa-notif-asked')==='1';
async function ensureNotifyPermission(){
  if(!('Notification' in window))return;
  if(Notification.permission==='default' && !_notifPermRequested){
    _notifPermRequested=true;localStorage.setItem('core-pa-notif-asked','1');
    try{await Notification.requestPermission();}catch{}
  }
}
function fireNative(title,body){
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  if(document.visibilityState==='visible')return; // in-app card already covers this
  try{
    const n=new Notification(title,{body,icon:'icon-192.png?v=5',badge:'favicon-32.png?v=5',tag:'core-pa-reminder'});
    n.onclick=()=>{window.focus();n.close();};
  }catch{}
}

/* ── Reminder polling ────────────────────────────────────────────────────── */
let _tasksCache=[];
const _remindedIds=new Set();
function checkReminders(){
  const now=Date.now();
  for(const t of _tasksCache){
    if(t.status!=='open'||!t.remind_at)continue;
    if(_remindedIds.has(t.id))continue;
    if(new Date(t.remind_at).getTime()<=now){
      _remindedIds.add(t.id);
      notify({
        title:'⏰ reminder',
        msg:t.title,
        compact:true,
        actions:[
          {label:'mark done',primary:true,onClick:()=>{
            const el=[...openList.children].find(c=>c.dataset.id==t.id);
            el?.querySelector('.check')?.click();
          }},
          {label:'dismiss'}
        ]
      });
      fireNative('Core PA — reminder',t.title);
    }
  }
}
setInterval(checkReminders,20000);

/* ── App-wide alarms (start_at / due_at) ─────────────────────────────────────
   Separate from the passive reminder toast above — these are real alarms:
   full-screen, looping sound, requires a dismiss/snooze. Fire regardless of
   which tab is open or whether focus mode is active for that task. */
const alarmOverlay=document.getElementById('alarmOverlay');
const _firedAlarms=new Set(JSON.parse(localStorage.getItem('fired_alarms')||'[]'));
function _saveFiredAlarms(){localStorage.setItem('fired_alarms',JSON.stringify([..._firedAlarms]));}

let _alarmLoopId=null,_alarmQueue=[],_alarmShowing=false;
function _startAlarmSound(){
  _stopAlarmSound();
  playChime(true);
  _alarmLoopId=setInterval(()=>playChime(true),1800);
}
function _stopAlarmSound(){ if(_alarmLoopId){clearInterval(_alarmLoopId);_alarmLoopId=null;} }

function fireGlobalAlarm(kind,task){ // kind: 'start' | 'due'
  // if focus mode is already open on this exact task, let the in-focus alarm handle it instead
  if(focusView.classList.contains('show')&&_fQueue[_fIdx]?.id===task.id)return;
  _alarmQueue.push({kind,task});
  if(!_alarmShowing)_showNextAlarm();
}
function _showNextAlarm(){
  const next=_alarmQueue.shift();
  if(!next){_alarmShowing=false;return;}
  _alarmShowing=true;
  const urgent=next.kind==='due';
  alarmOverlay.classList.toggle('urgent',urgent);
  document.getElementById('alarmKind').textContent=urgent?"time's up":'time to start';
  document.getElementById('alarmTitle').textContent=next.task.title;
  document.getElementById('alarmTime').textContent=urgent
    ?`was due ${fmtRemind(next.task.due_at)}`
    :`scheduled for ${fmtRemind(next.task.start_at)}`;
  alarmOverlay.classList.add('show');
  haptic(40);
  _startAlarmSound();
  fireNative(urgent?'⏰ time\'s up':'⏰ time to start',next.task.title);
  const finish=()=>{
    _stopAlarmSound();alarmOverlay.classList.remove('show');
    setTimeout(_showNextAlarm,300);
  };
  document.getElementById('alarmDismiss').onclick=finish;
  document.getElementById('alarmSnooze').onclick=async()=>{
    const snoozeAt=new Date(Date.now()+5*60000).toISOString();
    const field=next.kind==='start'?'start_at':'due_at';
    try{
      await fetch(API+'/api/tasks/'+next.task.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({[field]:snoozeAt})});
      loadTasks();
    }catch{}
    _firedAlarms.delete(`${next.task.id}:${next.kind}`);_saveFiredAlarms();
    finish();
  };
}

function checkAlarms(){
  const now=Date.now();
  for(const t of _tasksCache){
    if(t.status!=='open')continue;
    if(t.start_at){
      const key=`${t.id}:start`;
      if(!_firedAlarms.has(key)&&new Date(t.start_at).getTime()<=now){
        _firedAlarms.add(key);_saveFiredAlarms();fireGlobalAlarm('start',t);
      }
    }
    if(t.due_at){
      const key=`${t.id}:due`;
      if(!_firedAlarms.has(key)&&new Date(t.due_at).getTime()<=now){
        _firedAlarms.add(key);_saveFiredAlarms();fireGlobalAlarm('due',t);
      }
    }
  }
}
async function loadNudge(){
  const card=document.getElementById('nudgeCard'),msg=document.getElementById('nudgeMsg'),acts=document.getElementById('nudgeActs');
  try{
    const {nudge}=await fetch(API+'/api/nudge').then(r=>r.json());
    if(!nudge){card.style.display='none';return;}
    msg.textContent=nudge.message;
    acts.innerHTML='';
    nudge.actions.forEach((a,i)=>{
      const btn=document.createElement('button');
      btn.textContent=a.label;
      if(i===0)btn.classList.add('primary');
      btn.addEventListener('click',()=>handleNudgeAction(nudge,a));
      acts.appendChild(btn);
    });
    card.style.display='block';
  }catch{card.style.display='none';}
}
async function dismissNudgeCard(){
  document.getElementById('nudgeCard').style.display='none';
  try{await fetch(API+'/api/nudge/dismiss',{method:'POST'});}catch{}
}
function handleNudgeAction(nudge,action){
  if(action.id==='dismiss'){dismissNudgeCard();return;}
  const prompts={
    remind_30:`remind me about "${nudge.message.split('"')[1]||'that task'}" again in 30 minutes`,
    flag:`flag my recent spending as something to watch`,
    plan_tomorrow:`Look at what's actually open, what's been sitting untouched, and anything overdue or close to it. Don't just list my open tasks back at me — reason about which 2-3 things genuinely deserve tomorrow, and why, given deadlines and what I've been avoiding. If something's realistically not happening tomorrow, say so instead of padding the list.`,
  };
  const prompt=prompts[action.id];
  dismissNudgeCard();
  if(prompt&&typeof chatInput!=='undefined'&&typeof sendChat==='function'){
    document.querySelector('.nav-item[data-tab="chat"]')?.click();
    chatInput.value=prompt;
    sendChat();
  }
}
loadNudge();

async function loadBriefingWeather(){
  const row=document.getElementById('dbWeatherRow'),val=document.getElementById('dbWeatherVal');
  try{
    const w=await fetch(API+'/api/weather').then(r=>{if(!r.ok)throw 0;return r.json();});
    val.textContent=`${w.temp}° ${w.condition}`+(w.nextRainAt?`, rain by ${w.nextRainAt}`:'');
    row.style.display='flex';
    document.getElementById('dailyBrief').style.display='block';
  }catch{row.style.display='none';}
}
async function loadDailyBrief(){
  document.getElementById('dbTime').textContent=new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  try{
    const ctx=await getContext();
    const taskRow=document.getElementById('dbTaskRow'),taskVal=document.getElementById('dbTaskVal');
    if(ctx.urgentTask){taskVal.textContent=ctx.urgentTask;taskRow.style.display='flex';document.getElementById('dailyBrief').style.display='block';}
    else taskRow.style.display='none';
    setBriefMoney(await getMonthNet(ctx.financeNet));
  }catch{}
  loadBriefingWeather();
}
loadDailyBrief();

function greeting(){
  const h=new Date().getHours();
  if(h<5)return'still up,';if(h<12)return'morning,';
  if(h<17)return'afternoon,';if(h<21)return'evening,';return'night,';
}
function greetLine(ctx){
  const tod=greeting().replace(',','');
  if(ctx.highCount>0)return`<span class="em">${tod}, ${esc(userName)}.</span> <span class="hot">${esc(ctx.urgentTask||'something')}</span> is flagged urgent.`;
  if(ctx.doneToday>=3)return`<span class="em">${tod}, ${esc(userName)}.</span> ${ctx.doneToday} things knocked out already — nice pace.`;
  if(ctx.openCount===0)return`<span class="em">${tod}, ${esc(userName)}.</span> clean slate — nothing open.`;
  if(ctx.doneToday===0)return`<span class="em">${tod}, ${esc(userName)}.</span> ${ctx.openCount} thing${ctx.openCount===1?'':'s'} open, nothing moved yet.`;
  return`<span class="em">${tod}, ${esc(userName)}.</span> ${ctx.openCount} open, ${ctx.doneToday} down today.`;
}
async function loadMomentum(){
  const heroLoader=document.getElementById('heroLoader');
  try{
    const ctx=await getContext();
    const tod=greeting().replace(',','');
    const greetEl=document.getElementById('heroGreeting');
    const subEl=document.getElementById('heroSubline');
    if(greetEl){
      greetEl.innerHTML=`${tod}, <span class="hot">${esc(userName)}.</span>`;
      if(subEl){
        if(ctx.highCount>0)subEl.textContent=`${ctx.urgentTask||'something'} is flagged urgent.`;
        else if(ctx.doneToday>=3)subEl.textContent=`${ctx.doneToday} things knocked out already — nice pace.`;
        else if(ctx.openCount===0)subEl.textContent='clean slate — nothing open.';
        else if(ctx.doneToday===0)subEl.textContent=`${ctx.openCount} thing${ctx.openCount===1?'':'s'} open, nothing moved yet.`;
        else subEl.textContent=`${ctx.openCount} open, ${ctx.doneToday} down today.`;
      }
    }
    const streakNum=document.getElementById('streakNum');
    if(streakNum)streakNum.textContent=ctx.streakDays||0;
    if(heroLoader)heroLoader.style.display='none';
  }catch{
    if(heroLoader)heroLoader.style.display='none';
    const greetEl=document.getElementById('heroGreeting');
    if(greetEl&&!greetEl.innerHTML)greetEl.innerHTML=`${greeting().replace(',','')}, <span class="hot">${esc(userName)}.</span>`;
    setTimeout(()=>loadMomentum(),2500);
  }
}
async function loadHeatmap(){
  const grid=document.getElementById('heatmapGrid');if(!grid)return;
  try{
    const{days}=await fetch(API+'/api/heatmap').then(r=>r.json());
    const max=Math.max(1,...days.map(d=>d.count));
    const startDow=new Date(days[0].date+'T00:00:00').getDay();
    let html='';
    for(let i=0;i<startDow;i++)html+='<div class="heatmap-cell" style="visibility:hidden"></div>';
    days.forEach(d=>{
      const level=d.count===0?0:d.count>=max*0.75?3:d.count>=max*0.4?2:1;
      html+=`<div class="heatmap-cell" data-level="${level}" title="${d.date}: ${d.count} done"></div>`;
    });
    grid.innerHTML=html;
    requestAnimationFrame(()=>{
      grid.querySelectorAll('.heatmap-cell').forEach((c,i)=>{
        setTimeout(()=>c.classList.add('appear'),i*3);
      });
    });

    // Sparkline reuses the same real completion counts — last 7 days,
    // scaled to their own max rather than the whole grid's, so a busy day
    // months ago doesn't flatten this week's bars into nothing.
    const sparkBars=document.querySelectorAll('#streakSparkBars .spark-bar');
    if(sparkBars.length){
      const recent=days.slice(-7);
      const recentMax=Math.max(1,...recent.map(d=>d.count));
      recent.forEach((d,i)=>{
        const bar=sparkBars[i];if(!bar)return;
        const pct=Math.max(d.count>0?18:6,(d.count/recentMax)*100);
        requestAnimationFrame(()=>{bar.style.height=pct+'%';});
        bar.classList.toggle('on',d.count>0);
        bar.title=`${d.date}: ${d.count} done`;
      });
    }
  }catch{}
}
function fadeIn(el,delay=0){
  setTimeout(()=>{el.style.transition='opacity .5s ease';el.style.opacity='1'},delay);
}

/* ── Theme ────────────────────────────────────────────────────────────────── */
const html=document.documentElement;
const themeColor=document.getElementById('themeColor');
const settingsThemeDark=document.getElementById('settingsThemeDark');
const settingsThemeLight=document.getElementById('settingsThemeLight');
function syncSettingsThemeBtns(){
  const t=html.dataset.theme;
  settingsThemeDark?.classList.toggle('active',t==='dark');
  settingsThemeLight?.classList.toggle('active',t==='light');
}
function applyTheme(t){
  html.setAttribute('data-theme',t);
  themeColor.content=t==='dark'?'#000000':'#f5f5f7';
  localStorage.setItem('theme',t);
  syncSettingsThemeBtns();
}
applyTheme(localStorage.getItem('theme')||'dark');

// ── Custom accent color picker ────────────────────────────────────────────
function hexToRgb(hex){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `${r},${g},${b}`;
}
function darkenHex(hex,amt=0.25){
  let r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  r=Math.max(0,Math.floor(r*(1-amt)));g=Math.max(0,Math.floor(g*(1-amt)));b=Math.max(0,Math.floor(b*(1-amt)));
  return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
}
function applyAccentHex(hex){
  const rgb=hexToRgb(hex);
  const dark=darkenHex(hex);
  html.style.setProperty('--pink',hex);
  html.style.setProperty('--pink-rgb',rgb);
  html.style.setProperty('--pink-dark',dark);
  html.style.setProperty('--pink-glow',`rgba(${rgb},.45)`);
  html.style.setProperty('--pink-dim',`rgba(${rgb},.18)`);
  html.style.setProperty('--pink-sub',`rgba(${rgb},.07)`);
  localStorage.setItem('accentHex',hex);
  const preview=document.getElementById('accentColorPreview');
  if(preview){preview.style.background=hex;preview.style.boxShadow=`0 0 8px rgba(${rgb},.55)`;}
  const label=document.getElementById('accentHexLabel');
  if(label)label.textContent=hex.toUpperCase();
  const inp=document.getElementById('accentColorInput');
  if(inp)inp.value=hex;
}
const _savedAccentHex=localStorage.getItem('accentHex')||'#F81295';
applyAccentHex(_savedAccentHex);
setTimeout(()=>{
  const inp=document.getElementById('accentColorInput');
  if(inp){inp.value=_savedAccentHex;inp.addEventListener('input',e=>{
    applyAccentHex(e.target.value);haptic(4);
    // restart chat particles so they pick up the new accent color
    _stopChatParticles();
    const chatPanel=document.getElementById('tab-chat');
    if(chatPanel?.classList.contains('active')){
      requestAnimationFrame(()=>requestAnimationFrame(_startChatParticles));
    }
  });}
},0);

/* ── Sound ────────────────────────────────────────────────────────────────── */
let audioCtx=null;
function playChime(highPriority){
  if(localStorage.getItem('sound_off')==='1')return;
  try{
    audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();
    const now=audioCtx.currentTime;
    const freqs=highPriority?[880,1318.5]:[660,990];
    freqs.forEach((f,i)=>{
      const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();
      osc.type='sine';osc.frequency.value=f;
      osc.connect(gain);gain.connect(audioCtx.destination);
      const start=now+i*0.09;
      gain.gain.setValueAtTime(0,start);
      gain.gain.linearRampToValueAtTime(0.12,start+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001,start+0.35);
      osc.start(start);osc.stop(start+0.4);
    });
  }catch{}
}
function applySoundIcon(){
  const s=document.getElementById('settingsSoundToggle');
  if(s)s.textContent=localStorage.getItem('sound_off')==='1'?'🔕':'🔔';
}
applySoundIcon();

/* ── Cursor glow ──────────────────────────────────────────────────────────── */
const glowEl=document.getElementById('cursorGlow');
let _mu=false,_mgPending=false,_mgX=0,_mgY=0;
window.addEventListener('mousemove',e=>{
  _mgX=e.clientX;_mgY=e.clientY;
  if(!_mu){_mu=true;glowEl.style.opacity='1';}
  if(_mgPending)return;
  _mgPending=true;
  requestAnimationFrame(()=>{
    glowEl.style.transform=`translate(calc(${_mgX}px - 50%),calc(${_mgY}px - 50%))`;
    _mgPending=false;
  });
},{passive:true});

/* ── Canvas orb ───────────────────────────────────────────────────────────── */
(function(){
  const canvas=document.getElementById('orbCanvas');
  if(!canvas)return;
  const ctx=canvas.getContext('2d');
  const DPR=Math.min(window.devicePixelRatio||1,2);
  const S=400;
  canvas.width=S*DPR;canvas.height=S*DPR;ctx.scale(DPR,DPR);
  const cx=S/2,cy=S/2;
  const PK='rgba('+getComputedStyle(document.documentElement).getPropertyValue('--pink-rgb').trim()+',',SL='rgba(220,220,228,';
  const RINGS=[
    {rx:80,ry:26,tilt:.9, speed:.38,color:SL,a:.55,w:1.4},
    {rx:96,ry:33,tilt:-.6,speed:-.26,color:SL,a:.38,w:1.1},
    {rx:112,ry:20,tilt:.3,speed:.17,color:PK,a:.28,w:.9},
  ];
  const PARTS=Array.from({length:26},(_,i)=>({
    ring:Math.floor(i/9),
    angle:(i/26)*Math.PI*2+Math.random()*.5,
    speed:(.28+Math.random()*.38)*(Math.random()>.5?1:-1),
    size:.9+Math.random()*1.8,alpha:.38+Math.random()*.48,
    isPink:Math.random()<.28,
  }));
  const LAUNCH_PARTS=Array.from({length:34},()=>({
    angle:Math.random()*Math.PI*2,speed:.22+Math.random()*.42,
    size:.7+Math.random()*1.7,alpha:.28+Math.random()*.48,
    offset:Math.random()*.9,isPink:Math.random()<.58,
  }));
  let raf=null,t=0,launchT=0;
  const pm=window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  function drawCore(p){
    const g=ctx.createRadialGradient(cx,cy,8,cx,cy,88);
    g.addColorStop(0,`${PK}${.26+p*.1})`);g.addColorStop(.5,`${PK}.05)`);g.addColorStop(1,`${PK}0)`);
    ctx.beginPath();ctx.arc(cx,cy,88,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
    const s=ctx.createRadialGradient(cx-9,cy-9,2,cx,cy,32);
    s.addColorStop(0,'rgba(255,255,255,.98)');s.addColorStop(.3,'rgba(220,220,228,.92)');
    s.addColorStop(.7,'rgba(140,140,148,.85)');s.addColorStop(1,'rgba(22,22,26,.9)');
    ctx.beginPath();ctx.arc(cx,cy,32,0,Math.PI*2);ctx.fillStyle=s;ctx.fill();
    const sp=ctx.createRadialGradient(cx-11,cy-11,0,cx-6,cy-6,18);
    sp.addColorStop(0,'rgba(255,255,255,.5)');sp.addColorStop(1,'rgba(255,255,255,0)');
    ctx.beginPath();ctx.arc(cx,cy,32,0,Math.PI*2);ctx.fillStyle=sp;ctx.fill();
    ctx.beginPath();ctx.arc(cx,cy,32,0,Math.PI*2);
    ctx.strokeStyle=`${PK}${.32+p*.22})`;ctx.lineWidth=1;ctx.stroke();
  }
  function drawRing(r,o){
    ctx.save();ctx.translate(cx,cy);ctx.beginPath();
    ctx.ellipse(0,0,r.rx,r.ry*Math.abs(Math.cos(o*.08+r.tilt)),r.tilt+o*.04,0,Math.PI*2);
    ctx.strokeStyle=`${r.color}${r.a})`;ctx.lineWidth=r.w;ctx.stroke();ctx.restore();
  }
  function drawPart(p,o){
    const r=RINGS[Math.min(p.ring,RINGS.length-1)];
    const a=p.angle+o*p.speed;
    const x=cx+r.rx*Math.cos(a),y=cy+r.ry*Math.sin(a)*Math.cos(r.tilt);
    const c=p.isPink?PK:SL;
    const gr=ctx.createRadialGradient(x,y,0,x,y,p.size*2.5);
    gr.addColorStop(0,`${c}${p.alpha})`);gr.addColorStop(1,`${c}0)`);
    ctx.beginPath();ctx.arc(x,y,p.size*2.5,0,Math.PI*2);ctx.fillStyle=gr;ctx.fill();
  }
  function drawLaunchPart(p){
    const progress=(launchT*p.speed+p.offset)%1.25;
    const distance=progress*154;
    const x=cx+Math.cos(p.angle)*distance,y=cy+Math.sin(p.angle)*distance;
    const fade=progress<.12?progress/.12:Math.max(0,1-(progress-.72)/.53);
    const c=p.isPink?PK:SL;
    const gr=ctx.createRadialGradient(x,y,0,x,y,p.size*3.8);
    gr.addColorStop(0,`${c}${(p.alpha*fade).toFixed(2)})`);gr.addColorStop(1,`${c}0)`);
    ctx.beginPath();ctx.arc(x,y,p.size*3.8,0,Math.PI*2);ctx.fillStyle=gr;ctx.fill();
  }
  function draw(){
    ctx.clearRect(0,0,S,S);
    const p=(Math.sin(t*1.3)+1)/2;
    RINGS.forEach((r,i)=>drawRing(r,t*r.speed*60+i));
    PARTS.forEach(p2=>drawPart(p2,t));
    LAUNCH_PARTS.forEach(drawLaunchPart);
    drawCore(p);
    if(!pm){t+=.016;launchT+=.012;}
    raf=requestAnimationFrame(draw);
  }
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){cancelAnimationFrame(raf);raf=null}
    else if(!raf)draw();
  });
  draw();
  window._stopOrb=()=>{cancelAnimationFrame(raf);raf=null};
})();

/* ── Focus canvas orbital ─────────────────────────────────────────────────
   Runs while focus mode is open. Same ring+particle approach as the start
   screen orb but larger, slower, more cinematic. Pauses when hidden.    */
let _focusRaf=null,_focusT=0;
function _startFocusCanvas(){
  const canvas=document.getElementById('focusCanvas');
  if(!canvas||_focusRaf)return;
  // size canvas to screen
  const resize=()=>{
    const DPR=Math.min(window.devicePixelRatio||1,2);
    canvas.width=canvas.offsetWidth*DPR;
    canvas.height=canvas.offsetHeight*DPR;
  };
  resize();
  const ctx=canvas.getContext('2d');
  const getSize=()=>({w:canvas.width,h:canvas.height,cx:canvas.width/2,cy:canvas.height/2});
  const PK='rgba('+getComputedStyle(document.documentElement).getPropertyValue('--pink-rgb').trim()+',';
  const SL='rgba(200,200,215,';
  const pm=window.matchMedia('(prefers-reduced-motion:reduce)').matches;

  const RINGS=[
    {rx:.42,ry:.12,tilt:-.7,speed:.22,color:PK,a:.45,w:1.8},
    {rx:.52,ry:.16,tilt:.55,speed:-.15,color:SL,a:.3,w:1.4},
    {rx:.62,ry:.10,tilt:.2,speed:.09,color:PK,a:.18,w:1},
    {rx:.72,ry:.18,tilt:-.35,speed:-.06,color:SL,a:.12,w:.8},
  ];
  const PARTS=Array.from({length:40},(_,i)=>{
    const ring=Math.floor(i/10);
    return{
      ring,angle:(i/40)*Math.PI*2+Math.random()*.8,
      speed:(.08+Math.random()*.18)*(Math.random()>.5?1:-1),
      size:.8+Math.random()*2.2,alpha:.2+Math.random()*.55,
      isPink:Math.random()<.32,
    };
  });

  function draw(){
    const{w,h,cx,cy}=getSize();
    ctx.clearRect(0,0,w,h);
    const minDim=Math.min(w,h);

    // Ambient central glow
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,minDim*.38);
    g.addColorStop(0,`${PK}.06)`);g.addColorStop(.55,`${PK}.02)`);g.addColorStop(1,`${PK}0)`);
    ctx.beginPath();ctx.ellipse(cx,cy,minDim*.38,minDim*.38,0,0,Math.PI*2);
    ctx.fillStyle=g;ctx.fill();

    RINGS.forEach(r=>{
      const rx=minDim*r.rx,ry=minDim*r.ry;
      const o=_focusT*r.speed*120;
      ctx.save();ctx.translate(cx,cy);ctx.beginPath();
      ctx.ellipse(0,0,rx,ry*Math.abs(Math.cos(o*.05+r.tilt)),r.tilt+o*.03,0,Math.PI*2);
      ctx.strokeStyle=`${r.color}${r.a})`;ctx.lineWidth=r.w;ctx.stroke();ctx.restore();
    });

    PARTS.forEach(p=>{
      const r=RINGS[Math.min(p.ring,RINGS.length-1)];
      const rx=minDim*r.rx,ry=minDim*r.ry;
      const o=_focusT*r.speed*120;
      const a=p.angle+_focusT*p.speed;
      const x=cx+rx*Math.cos(a),y=cy+ry*Math.sin(a)*Math.cos(r.tilt+o*.03);
      const c=p.isPink?PK:SL;
      const gr=ctx.createRadialGradient(x,y,0,x,y,p.size*3);
      gr.addColorStop(0,`${c}${p.alpha})`);gr.addColorStop(1,`${c}0)`);
      ctx.beginPath();ctx.arc(x,y,p.size*3,0,Math.PI*2);ctx.fillStyle=gr;ctx.fill();
    });

    if(!pm)_focusT+=.008;
    _focusRaf=requestAnimationFrame(draw);
  }
  draw();
}
function _stopFocusCanvas(){
  if(_focusRaf){cancelAnimationFrame(_focusRaf);_focusRaf=null;}
}

/* Seed the star field with 40 positioned stars */
function _seedFocusStars(){
  const container=document.getElementById('focusStars');
  if(!container||container.childElementCount>0)return;
  for(let i=0;i<40;i++){
    const s=document.createElement('div');
    s.className='focus-star';
    const sz=Math.random()<.15?2.5:Math.random()<.35?1.5:1;
    const op=.15+Math.random()*.5;
    s.style.cssText=`
      left:${Math.random()*100}%;top:${Math.random()*100}%;
      width:${sz}px;height:${sz}px;
      --op:${op.toFixed(2)};
      --sd:${(2+Math.random()*4).toFixed(1)}s;
      --delay:-${(Math.random()*4).toFixed(1)}s;
    `;
    container.appendChild(s);
  }
}

/* ── Chat particle canvas ─────────────────────────────────────────────────
   Ambient floating particles in the chat tab. Color tracks the user's
   accent. Fades out when messages arrive so it doesn't fight content.   */
let _chatRaf=null;
let _chatPulse=0;
function _chatParticlesPulse(){_chatPulse=1;}
function _startChatParticles(){
  const canvas=document.getElementById('chatParticleCanvas');
  if(!canvas||_chatRaf)return;
  canvas.style.display='block';
  const DPR=Math.min(window.devicePixelRatio||1,2);
  const ctx=canvas.getContext('2d');
  let W=0,H=0;
  const resize=()=>{W=canvas.offsetWidth;H=canvas.offsetHeight;canvas.width=W*DPR;canvas.height=H*DPR;ctx.setTransform(DPR,0,0,DPR,0,0);};
  resize();
  const rgb=()=>getComputedStyle(document.documentElement).getPropertyValue('--pink-rgb').trim()||'248,18,149';
  const sprite=c=>{const s=document.createElement('canvas');s.width=s.height=64;const g=s.getContext('2d'),r=g.createRadialGradient(32,32,0,32,32,32);r.addColorStop(0,'rgba('+c+',1)');r.addColorStop(.3,'rgba('+c+',.5)');r.addColorStop(1,'rgba('+c+',0)');g.fillStyle=r;g.fillRect(0,0,64,64);return s;};
  let curRGB=rgb(),accent=sprite(curRGB);
  const silver=sprite('214,214,226');
  const reduce=window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  const P=Array.from({length:64},()=>{
    const z=.25+Math.random()*.75; // depth: small, slow, dim up to big, fast, bright
    return{x:Math.random()*W,y:Math.random()*H,z,d:6+z*26,sp:5+z*16,
      ang:-Math.PI/2+(Math.random()-.5)*2.4,turn:.15+Math.random()*.35,ph:Math.random()*6.28,
      tw:.5+Math.random()*1.1,tph:Math.random()*6.28,a:.22+z*.5,acc:Math.random()<.55};
  });
  let last=performance.now(),t=0,fr=0;
  function draw(now){
    const dt=Math.min(.05,(now-last)/1000);last=now;t+=dt;
    if(fr++%30===0){
      if(canvas.offsetWidth!==W||canvas.offsetHeight!==H)resize();
      const c=rgb();if(c!==curRGB){curRGB=c;accent=sprite(c);}
    }
    ctx.clearRect(0,0,W,H);
    const boost=1+_chatPulse*2.2;
    _chatPulse*=Math.pow(.12,dt);if(_chatPulse<.01)_chatPulse=0;
    for(const p of P){
      if(!reduce){
        const a=p.ang+Math.sin(t*p.turn+p.ph)*1.1;
        p.x+=Math.cos(a)*p.sp*boost*dt;p.y+=Math.sin(a)*p.sp*boost*dt;
      }
      const m=p.d;
      if(p.x<-m)p.x=W+m;else if(p.x>W+m)p.x=-m;
      if(p.y<-m)p.y=H+m;else if(p.y>H+m)p.y=-m;
      const tw=reduce?1:.7+.3*Math.sin(t*p.tw+p.tph);
      ctx.globalAlpha=Math.min(1,p.a*tw*(1+_chatPulse*.5));
      ctx.drawImage(p.acc?accent:silver,p.x-p.d/2,p.y-p.d/2,p.d,p.d);
    }
    ctx.globalAlpha=1;
    _chatRaf=requestAnimationFrame(draw);
  }
  _chatRaf=requestAnimationFrame(draw);
}
function _startChatParticlesOld(){
  const canvas=document.getElementById('chatParticleCanvas');
  if(!canvas||_chatRaf)return;
  const DPR=Math.min(window.devicePixelRatio||1,2);
  const resize=()=>{
    canvas.width=canvas.offsetWidth*DPR;
    canvas.height=canvas.offsetHeight*DPR;
  };
  resize();
  const ctx=canvas.getContext('2d');
  const pm=window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  if(pm){_chatRaf=1;return;} // skip animation if user prefers reduced motion

  const getPK=()=>'rgba('+getComputedStyle(document.documentElement).getPropertyValue('--pink-rgb').trim()+',';

  // 55 particles — mix of accent-colored and silver/white
  const PARTS=Array.from({length:70},(_,i)=>({
    x:Math.random(),y:Math.random(),
    vx:(Math.random()-.5)*.24,vy:(Math.random()-.5)*.24,
    r:1+Math.random()*3,
    alpha:.18+Math.random()*.42,
    isPink:Math.random()<.55,
    // each particle drifts slightly differently
    wobbleAmp:Math.random()*.4,wobbleFreq:.4+Math.random()*.6,wobbleOff:Math.random()*Math.PI*2,
  }));
  let t=0;

  function draw(){
    const w=canvas.width,h=canvas.height;
    ctx.clearRect(0,0,w,h);
    const PK=getPK();
    const SL='rgba(210,210,220,';

    PARTS.forEach(p=>{
      // drift
      p.x+=p.vx*.002 + Math.sin(t*p.wobbleFreq+p.wobbleOff)*p.wobbleAmp*.001;
      p.y+=p.vy*.002;
      // wrap
      if(p.x<-.05)p.x=1.05;if(p.x>1.05)p.x=-.05;
      if(p.y<-.05)p.y=1.05;if(p.y>1.05)p.y=-.05;

      const px=p.x*w,py=p.y*h;
      const c=p.isPink?PK:SL;
      const g=ctx.createRadialGradient(px,py,0,px,py,p.r*3);
      g.addColorStop(0,`${c}${p.alpha})`);
      g.addColorStop(1,`${c}0)`);
      ctx.beginPath();ctx.arc(px,py,p.r*3,0,Math.PI*2);
      ctx.fillStyle=g;ctx.fill();
    });

    t+=.6;
    _chatRaf=requestAnimationFrame(draw);
  }
  draw();
}
function _stopChatParticles(){
  if(_chatRaf&&_chatRaf!==1){cancelAnimationFrame(_chatRaf);}
  _chatRaf=null;
  const _cc=document.getElementById('chatParticleCanvas');if(_cc)_cc.style.display='none';
}

/* ── Boot sequence ────────────────────────────────────────────────────────── */
const bootLog=document.getElementById('bootLog');
const enterBtn=document.getElementById('enterBtn');
const startScreen=document.getElementById('startScreen');
const app=document.getElementById('app');
const logoReveal=document.getElementById('logoReveal');
const startOrbital=document.getElementById('startOrbital');
const startWordmark=document.getElementById('startWordmark');
const startDivider=document.getElementById('startDivider');
const startSub=document.getElementById('startSub');

async function runBoot(options={}){
  const signedIn=options.signedIn===true;
  startScreen.style.display='flex';
  startScreen.classList.toggle('signed-in',signedIn);
  if(signedIn){
    startSub.textContent='personal assistant · welcome back';
    enterBtn.textContent='opening workspace';
    enterBtn.classList.remove('ready');
  }
  // logo reveal → orb transition
  await new Promise(r=>setTimeout(r,signedIn?1050:1900));
  logoReveal.classList.add('hidden');
  startOrbital.classList.add('visible');
  fadeIn(startWordmark,180);fadeIn(startDivider,320);fadeIn(startSub,420);
  await new Promise(r=>setTimeout(r,560));

  let openCount=0,highCount=0;
  try{const ctx=await getContext();openCount=ctx.openCount;highCount=ctx.highCount;}catch{}

  const lines=[
    {text:signedIn?'reconnecting your workspace…':'initialising core systems…',cls:'dim', wait:0},
    {text:signedIn?'syncing your context…':'loading your context…',cls:'dim', wait:signedIn?380:580},
    {text:openCount===0?'clean slate — nothing open':`${openCount} task${openCount===1?'':'s'} open${highCount>0?`, ${highCount} urgent`:''}`,cls:highCount>0?'pink':'',wait:signedIn?760:1160},
    {text:'— ready —',cls:'pink',wait:signedIn?1120:1740},
  ];
  for(const line of lines){
    await new Promise(r=>setTimeout(r,line.wait-(lines[lines.indexOf(line)-1]?.wait||0)));
    const el=document.createElement('div');
    el.className=`boot-line ${line.cls}`;el.textContent=line.text;
    bootLog.appendChild(el);
    requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('show')));
  }
  await new Promise(r=>setTimeout(r,300));
  if(signedIn)enterApp();
  else enterBtn.classList.add('ready');
}

function handleShortcutAction(){
  const params=new URLSearchParams(location.search);
  const action=params.get('action');
  if(action==='add'){document.querySelector('.nav-item[data-tab="tasks"]').click();input.focus();}
  else if(action==='focus'){openFocus();}
  else if(action==='task'){
    const id=params.get('id');
    if(id)openTaskFromNotification(id);
  }
  if(action)history.replaceState(null,'',location.pathname);
}
// Scrolls to and briefly highlights a task opened from a push notification tap,
// instead of just dropping the person on whatever tab happened to be open.
function openTaskFromNotification(id){
  document.querySelector('.nav-item[data-tab="tasks"]')?.click();
  const tryFind=()=>[...openList.children].find(c=>c.dataset.id==id);
  let attempts=0;
  const poll=setInterval(()=>{
    attempts++;
    const el=tryFind();
    if(el){
      clearInterval(poll);
      el.scrollIntoView({block:'center',behavior:'smooth'});
      el.classList.add('notif-highlight');
      setTimeout(()=>el.classList.remove('notif-highlight'),2200);
    }else if(attempts>20){clearInterval(poll);} // task list never loaded / already done — give up quietly
  },150);
}
function enterApp(){
  startScreen.classList.add('exit');
  // Let the app begin zooming in while the start screen is still zooming/blurring
  // out — the overlap is what sells the "diving into the app" feel.
  setTimeout(()=>{
    app.classList.add('visible');
    document.getElementById('coreNavIcon')?.classList.add('reveal-play');
  },240);
  setTimeout(()=>{
    startScreen.style.display='none';
    handleShortcutAction();
    // Kill the canvas animation loop — it only runs on the start screen
    if(typeof window._stopOrb==='function')window._stopOrb();
    // Only now is the user actually on the app — safe to show notification pop-ups.
    _appReady=true;
    setTimeout(()=>{window.startCoreTour&&window.startCoreTour();},500);
    _flushPendingNotifies();
  },700);
}
function showSignedInApp(){
  runBoot({signedIn:true});
}
const openList=document.getElementById('openList');
const doneList=document.getElementById('doneList');
const doneLabel=document.getElementById('doneLabel');
const taskCount=document.getElementById('taskCount');
const input=document.getElementById('input');
const sendBtn=document.getElementById('sendBtn');
let taskInputMode='ai'; // 'ai' | 'manual'
const aiModeChip=document.getElementById('aiModeChip');
function applyTaskInputMode(){
  const isAI=taskInputMode==='ai';
  aiModeChip.classList.toggle('on',isAI);
  const aiModeLabel=document.getElementById('aiModeChipLabel');
  if(aiModeLabel)aiModeLabel.textContent=isAI?'AI mode':'manual';
  input.placeholder=isAI?'tell Core what to do, and when…':'what needs to happen…';
  document.getElementById('reminderChip').style.display=isAI?'none':'inline-flex';
  document.getElementById('optionsChip').style.display=isAI?'none':'inline-flex';
}
aiModeChip?.addEventListener('click',()=>{
  taskInputMode=taskInputMode==='ai'?'manual':'ai';
  applyTaskInputMode();
});
applyTaskInputMode();
const micBtn=document.getElementById('micBtn');
// always show the start screen + reveal
let authMode='login';
const landingScreen=document.getElementById('landingScreen'),
      authScreen=document.getElementById('authScreen'),authTitle=document.getElementById('authTitle'),
      authName=document.getElementById('authName'),
      authEmail=document.getElementById('authEmail'),authPassword=document.getElementById('authPassword'),
      authCode=document.getElementById('authCode'),authHint=document.getElementById('authHint'),
      authError=document.getElementById('authError'),authSubmit=document.getElementById('authSubmit'),
      authToggle=document.getElementById('authToggle'),authLegal=document.getElementById('authLegal'),
      authResendRow=document.getElementById('authResendRow'),authResend=document.getElementById('authResend');
let userName='there';
let verificationToken=null,verificationAfterSignup=false;

function showLanding(){ authScreen.style.display='none'; landingScreen.style.display='flex'; }
function showAuth(mode){ landingScreen.style.display='none'; authScreen.style.display='flex'; setAuthMode(mode); }

document.getElementById('landingGetStarted').addEventListener('click',()=>showAuth('signup'));
document.getElementById('landingSignIn').addEventListener('click',()=>showAuth('login'));

function setAuthMode(mode){
  authMode=mode;
  verificationToken=null;
  verificationAfterSignup=false;
  authTitle.textContent=mode==='login'?'sign in':'create account';
  authName.style.display=mode==='login'?'none':'block';
  authEmail.style.display='block';
  authPassword.style.display='block';
  authCode.style.display='none';
  authHint.style.display='none';
  authResendRow.style.display='none';
  authLegal.style.display=mode==='login'?'none':'block';
  authSubmit.textContent=mode==='login'?'sign in':'sign up';
  authToggle.innerHTML=mode==='login'?'no account? <span>sign up</span>':'have an account? <span>sign in</span>';
  authSubmit.disabled=false;
  authError.textContent='';
}
function showVerification(data,afterSignup){
  authMode='verify';
  verificationToken=data.verificationToken;
  verificationAfterSignup=afterSignup;
  authScreen.style.display='flex';
  authTitle.textContent='check your email';
  authName.style.display='none';
  authEmail.style.display='none';
  authPassword.style.display='none';
  authCode.style.display='block';
  authCode.value='';
  authHint.textContent=`we sent a six-digit code to ${data.email}. it expires in 10 minutes.`;
  authHint.style.display='block';
  authSubmit.textContent='verify email';
  authSubmit.disabled=false;
  authToggle.innerHTML='wrong email? <span>start again</span>';
  authResendRow.style.display='block';
  authLegal.style.display='none';
  authError.textContent='';
  setTimeout(()=>authCode.focus(),50);
}
authToggle.addEventListener('click',()=>setAuthMode(authMode==='verify'?'signup':authMode==='login'?'signup':'login'));
authResend.addEventListener('click',async()=>{
  if(!verificationToken)return;
  authResend.disabled=true;authError.textContent='';
  try{
    const res=await fetch(API+'/api/auth/resend-verification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({verificationToken})});
    const data=await res.json();
    if(!res.ok){authError.textContent=data.error||'could not resend the code';return;}
    verificationToken=data.verificationToken||verificationToken;
    authHint.textContent='new code sent. check your email, then enter it here.';
  }catch{authError.textContent='network error — try again';}
  finally{authResend.disabled=false;}
});

// ─── Tutorial ───────────────────────────────────────────────────────────────
const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;
const isStandalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone;

const TUT_STEPS=[
  {emoji:'✓',title:'tasks that chase you',body:'add a task, and if it sits untouched too long, Core PA nudges you on Telegram — no more "I\'ll remember."'},
  {emoji:'R',title:'finance, sorted for you',body:'drop in a bank statement — Capitec, FNB, Standard Bank, Nedbank, Absa — and it categorises every line automatically.'},
  {emoji:'*',title:'an AI that sees it all',body:'your tasks and your money, one context. ask it to think through your day and it actually knows what\'s going on.'},
  {emoji:'⌂',title:isIOS?'add to your home screen':'you\'re all set',body:isIOS
      ?'tap the <span class="tut-kbd">share</span> icon below, then <span class="tut-kbd">add to home screen</span> — Core PA opens like a real app, no browser bar.'
      :'jump in and start adding your first task.'},
];
let tutIdx=0;
const tutDots=document.getElementById('tutDots'),tutContent=document.getElementById('tutContent'),
      tutNext=document.getElementById('tutNext'),tutSkip=document.getElementById('tutSkip'),
      tutScreen=document.getElementById('tutorialScreen');

function renderTutStep(){
  const s=TUT_STEPS[tutIdx];
  tutContent.innerHTML=`<div class="tut-emoji">${s.emoji}</div><div class="tut-title">${s.title}</div><div class="tut-body">${s.body}</div>`;
  tutDots.innerHTML=TUT_STEPS.map((_,i)=>`<span class="tut-dot${i===tutIdx?' active':''}"></span>`).join('');
  tutNext.textContent=tutIdx===TUT_STEPS.length-1?'let\'s go':'next';
}
function finishTutorial(){
  tutScreen.style.display='none';
  runBoot();
}
tutNext.addEventListener('click',()=>{
  if(tutIdx<TUT_STEPS.length-1){tutIdx++;renderTutStep();}
  else finishTutorial();
});
tutSkip.addEventListener('click',finishTutorial);
function showTutorial(){
  tutIdx=0;renderTutStep();
  authScreen.style.display='none';
  tutScreen.style.display='flex';
}

async function submitAuth(){
  const email=authEmail.value.trim(),password=authPassword.value,name=authName.value.trim();
  if(authMode==='verify'){
    const code=authCode.value.replace(/\s/g,'');
    if(!/^\d{6}$/.test(code)){authError.textContent='enter the six-digit code from your email';return;}
    authSubmit.disabled=true;authError.textContent='';
    try{
      const res=await fetch(API+'/api/auth/verify-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({verificationToken,code})});
      const data=await res.json();
      if(!res.ok){authError.textContent=data.error||'could not verify that code';authSubmit.disabled=false;return;}
      await finishAuth(data,name);
    }catch{authError.textContent='network error — try again';authSubmit.disabled=false;}
    return;
  }
  if(!email||!password){authError.textContent='enter an email and password';return;}
  if(authMode==='signup'&&!name){authError.textContent='tell us what to call you';return;}
  authSubmit.disabled=true;authError.textContent='';
  try{
    const res=await fetch(API+`/api/auth/${authMode==='login'?'login':'signup'}`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email,password,name}),
    });
    const data=await res.json();
    if(data.verificationRequired){showVerification(data,authMode==='signup');return;}
    if(!res.ok){authError.textContent=data.error||"hmm, that didn't work — try again";authSubmit.disabled=false;return;}
    await finishAuth(data,name);
  }catch(err){
    authError.textContent='network error — try again';
    authSubmit.disabled=false;
  }
}
async function finishAuth(data,fallbackName){
  userName=data.name||fallbackName||'there';
  // This endpoint is now restricted server-side to the configured legacy-data
  // owner, so a new account cannot claim another person's old rows.
  try{await fetch(API+'/api/auth/claim-legacy-data',{method:'POST'});}catch{}
  if(verificationAfterSignup&&!isStandalone){ showTutorial(); }
  else {
    authScreen.style.display='none';
    showSignedInApp();
  }
}
authSubmit.addEventListener('click',submitAuth);
authPassword.addEventListener('keydown',e=>{if(e.key==='Enter')submitAuth();});
authCode.addEventListener('keydown',e=>{if(e.key==='Enter')submitAuth();});

(async function checkAuthAndBoot(){
  try{
    const res=await fetch(API+'/api/auth/me',{credentials:'include'});
    if(res.ok){
      const data=await res.json();
      userName=data.name||'there';
      showSignedInApp();
      return;
    }
    console.error('[boot] /api/auth/me not ok:',res.status,await res.text().catch(()=>''));
  }catch(err){
    console.error('[boot] /api/auth/me failed:',err);
    alert('Debug: auth check failed \u2014 '+(err && err.message ? err.message : String(err)));
  }
  // Not signed in. Arriving from the marketing page's "Get started" CTA?
  // Skip the tap-to-enter splash and open the right form directly, instead
  // of making them tap through a screen they didn't ask to see.
  const p=new URLSearchParams(location.search);
  if(p.get('signup')==='1'){
    if(p.get('plan')) sessionStorage.setItem('pendingPlan',p.get('plan'));
    showAuth('signup');
  }else{
    showLanding();
  }
})();
enterBtn.addEventListener('click',enterApp);
document.getElementById('logoutBtn').addEventListener('click',async()=>{
  if(!confirm('log out of Core PA on this device?')) return;
  await fetch(API+'/api/auth/logout',{method:'POST'});
  location.reload();
});

// PWA shortcuts skip the tap-to-enter splash
if(new URLSearchParams(location.search).get('action'))setTimeout(enterApp,200);

/* ── Bottom sheets ────────────────────────────────────────────────────────── */
const sheetOverlay = document.getElementById('sheetOverlay');
const sheetRemind  = document.getElementById('sheetRemind');
const sheetOptions = document.getElementById('sheetOptions');
const sheetDanger  = document.getElementById('sheetDanger');

// state kept here, read on task add
let sheetRemindAt   = null;  // ISO string or null
let sheetPriority   = 'normal';
let sheetRecurring  = '';
let sheetNudgeMins  = 4320; // 3 days default

function openSheet(sheet) {
  // Close any other sheet first — sheets should never stack on top of each other.
  [sheetRemind, sheetOptions, sheetDanger].forEach(s => { if (s !== sheet) s.classList.remove('open'); });
  sheetOverlay.classList.add('open');
  sheet.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSheets() {
  sheetOverlay.classList.remove('open');
  sheetRemind.classList.remove('open');
  sheetOptions.classList.remove('open');
  sheetDanger.classList.remove('open');
  document.body.style.overflow = '';
}
sheetOverlay.addEventListener('click', closeSheets);

// Sheet swipe-to-dismiss: drag the handle or sheet body down to close
document.querySelectorAll('.bottom-sheet').forEach(sheet => {
  const handle = sheet.querySelector('.sheet-handle');
  if (!handle) return;
  let sy = 0, dy = 0, dragging = false;
  const onStart = e => { if (e.touches?.length !== 1) return; sy = e.touches[0].clientY; dy = 0; dragging = true; sheet.style.transition = 'none'; };
  const onMove = e => {
    if (!dragging) return;
    dy = Math.max(0, e.touches[0].clientY - sy); // only downward
    sheet.style.transform = `translateY(${dy}px)`;
    sheetOverlay.style.opacity = String(Math.max(0, 1 - dy / 260));
  };
  const onEnd = () => {
    if (!dragging) return; dragging = false;
    sheet.style.transition = '';
    if (dy > 120) {
      closeSheets();
    } else {
      // Spring snap back
      springAnimate({ from: dy, to: 0, stiffness: 340, damping: 28, onUpdate: y => { sheet.style.transform = `translateY(${y}px)`; sheetOverlay.style.opacity = String(1 - y / 260); }, onDone: () => { sheet.style.transform = ''; sheetOverlay.style.opacity = ''; } });
    }
  };
  handle.addEventListener('touchstart', onStart, { passive: true });
  handle.addEventListener('touchmove', onMove, { passive: true });
  handle.addEventListener('touchend', onEnd);
});

function openDangerConfirm(opts){
  const titleEl=document.getElementById('dangerTitle');
  const msgEl=document.getElementById('dangerMessage');
  const phraseLabelEl=document.getElementById('dangerPhraseLabel');
  const phraseInput=document.getElementById('dangerPhraseInput');
  const pwRow=document.getElementById('dangerPasswordRow');
  const pwInput=document.getElementById('dangerPasswordInput');
  const confirmBtn=document.getElementById('dangerConfirmBtn');

  titleEl.textContent=opts.title||'are you sure?';
  msgEl.textContent=opts.message||"this can't be undone.";
  phraseLabelEl.textContent=opts.phraseLabel||`type ${opts.phrase} to continue`;
  phraseInput.value='';
  pwRow.style.display=opts.needsPassword?'block':'none';
  pwInput.value='';
  confirmBtn.textContent=opts.confirmLabel||'confirm';
  confirmBtn.disabled=true;
  confirmBtn.style.opacity='.4';

  function checkReady(){
    const phraseOk=phraseInput.value.trim()===opts.phrase;
    const pwOk=!opts.needsPassword||pwInput.value.length>0;
    const ready=phraseOk&&pwOk;
    confirmBtn.disabled=!ready;
    confirmBtn.style.opacity=ready?'1':'.4';
  }
  phraseInput.oninput=checkReady;
  pwInput.oninput=checkReady;

  confirmBtn.onclick=()=>{
    if(confirmBtn.disabled)return;
    closeSheets();
    opts.onConfirm(opts.needsPassword?pwInput.value:null);
  };

  openSheet(sheetDanger);
  setTimeout(()=>phraseInput.focus(),300);
}

// Reminder sheet
document.getElementById('reminderChip').addEventListener('click', () => openSheet(sheetRemind));
document.getElementById('reminderDone').addEventListener('click', () => {
  const v = document.getElementById('remindAt').value;
  sheetRemindAt = v ? new Date(v).toISOString() : null;
  const chip = document.getElementById('reminderChip');
  chip.classList.toggle('on', !!sheetRemindAt);
  const chipLabel = document.getElementById('reminderChipLabel');
  if(chipLabel) chipLabel.textContent = sheetRemindAt ? new Date(sheetRemindAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'remind';
  if(sheetRemindAt)ensureNotifyPermission();
  closeSheets();
});

// Options sheet — priority chips
document.querySelectorAll('[data-priority]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('[data-priority]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    sheetPriority = chip.dataset.priority;
  });
});

// Options sheet — recurring chips
document.querySelectorAll('[data-recurring]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('[data-recurring]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    sheetRecurring = chip.dataset.recurring;
  });
});

// Options sheet — nudge timing
function computeNudgeMins() {
  const num  = parseInt(document.getElementById('nudgeNum').value, 10) || 3;
  const unit = document.getElementById('nudgeUnit').value;
  const mult = unit === 'minutes' ? 1 : unit === 'hours' ? 60 : 1440;
  return num * mult;
}
['nudgeNum','nudgeUnit'].forEach(id =>
  document.getElementById(id).addEventListener('change', () => { sheetNudgeMins = computeNudgeMins(); })
);

document.getElementById('optionsChip').addEventListener('click', () => openSheet(sheetOptions));
document.getElementById('optionsDone').addEventListener('click', () => {
  sheetNudgeMins = computeNudgeMins();
  const chip = document.getElementById('optionsChip');
  const hasCustom = sheetPriority !== 'normal' || sheetRecurring || sheetNudgeMins !== 4320;
  chip.classList.toggle('on', hasCustom);
  closeSheets();
});

/* ── Focus mode ──────────────────────────────────────────────────────────── */
const focusView=document.getElementById('focusView'),focusContent=document.getElementById('focusContent'),focusCloseBtn=document.getElementById('focusCloseBtn');
let _fQueue=[],_fIdx=0,_fTimer=null,_fStartAt=null,_fEndAt=null,_fTotalMs=0,_fMode='idle',_fAlarmLoop=null,_fPausedRemainingMs=0;
const F_CIRC=578.1; // 2·Ï€·92, matches the complete-ring's r=92 (200px ring)

function _fSetRing(frac){
  const fill=document.getElementById('fCrFill');
  if(fill)fill.style.strokeDashoffset=String(F_CIRC*(1-Math.max(0,Math.min(1,frac))));
}
function _fStopAlarm(){
  if(_fAlarmLoop){clearInterval(_fAlarmLoop);_fAlarmLoop=null;}
  focusView.classList.remove('alarm-flash');
  document.getElementById('fCompleteRing')?.classList.remove('alarm');
  document.getElementById('fTimerDisplay')?.classList.remove('alarm');
}
function _fStopTimer(){
  if(_fTimer){clearInterval(_fTimer);_fTimer=null;}
  _fStopAlarm();
  _fMode='idle';_fStartAt=null;_fEndAt=null;_fTotalMs=0;_fPausedRemainingMs=0;
  const pauseBtn=document.getElementById('fPauseBtn');
  if(pauseBtn){pauseBtn.style.display='none';pauseBtn.textContent='pause';}
}

async function openFocus(){
  focusView.classList.add('show');
  document.body.style.overflow='hidden';
  _fStopTimer();
  _stopChatParticles();
  _seedFocusStars();
  // Defer canvas start one frame so focus-view is visible and has layout
  requestAnimationFrame(()=>requestAnimationFrame(_startFocusCanvas));
  await loadFocusTask(true);
}

async function openFocusForTask(taskId){
  focusView.classList.add('show');
  document.body.style.overflow='hidden';
  _fStopTimer();
  _stopChatParticles();
  _seedFocusStars();
  requestAnimationFrame(()=>requestAnimationFrame(_startFocusCanvas));
  const tasks=await fetch(API+'/api/tasks').then(r=>r.json());
  _fQueue=tasks.filter(t=>t.status==='open');
  const idx=_fQueue.findIndex(t=>t.id===taskId);
  _fIdx=idx>=0?idx:0;
  await loadFocusTask(false);
}

function closeFocus(){
  focusView.classList.remove('show');
  document.body.style.overflow='';
  _fStopTimer();
  _stopFocusCanvas();
  // restart chat particles if chat tab is still active
  const chatPanel=document.getElementById('tab-chat');
  if(chatPanel?.classList.contains('active')){
    requestAnimationFrame(()=>requestAnimationFrame(_startChatParticles));
  }
}

function _fFireAlarm(){
  if(_fTimer){clearInterval(_fTimer);_fTimer=null;}
  _fMode='alarm';
  const display=document.getElementById('fTimerDisplay'),label=document.getElementById('fTimerLabel'),
        startBtn=document.getElementById('fStartBtn'),ring=document.getElementById('fCompleteRing'),
        hint=document.getElementById('fCompleteHint'),pauseBtn=document.getElementById('fPauseBtn');
  if(display){display.textContent="time's up";display.classList.add('alarm');display.classList.remove('ticking');}
  if(label)label.textContent='session complete — mark it done, or keep going';
  if(startBtn){startBtn.textContent='dismiss';startBtn.classList.remove('running');startBtn.classList.add('alarm-state');}
  if(pauseBtn)pauseBtn.style.display='none';
  ring?.classList.add('alarm');
  if(hint)hint.textContent='tap edge to complete';
  _fSetRing(1);
  focusView.classList.add('alarm-flash');
  haptic(300);
  playChime(true);
  _fAlarmLoop=setInterval(()=>{playChime(true);haptic(200);},1800);
  fireNative('⏰ time\'s up','focus session complete — back to the app to wrap up.');
}

function _fStartTimer(startISO,endISO){
  _fStopTimer();
  const startMs=startISO?new Date(startISO).getTime():Date.now();
  const endMs=new Date(endISO).getTime();
  const nowMs=Date.now();
  const display=document.getElementById('fTimerDisplay');
  const label=document.getElementById('fTimerLabel');
  const startBtn=document.getElementById('fStartBtn');
  const pauseBtn=document.getElementById('fPauseBtn');

  if(startMs>nowMs){
    // waiting-to-start: count down to the scheduled start, ring stays empty
    _fMode='waiting';_fStartAt=startMs;_fEndAt=endMs;
    if(startBtn){startBtn.textContent='start now';startBtn.classList.remove('running');}
    if(pauseBtn)pauseBtn.style.display='none';
    if(label)label.textContent='starts in';
    _fSetRing(0);
    const tick=()=>{
      const rem=_fStartAt-Date.now();
      if(rem<=0){
        if(_fTimer){clearInterval(_fTimer);_fTimer=null;}
        _fStartTimer(null,new Date(_fEndAt).toISOString());
        return;
      }
      if(!display)return;
      const m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);
      display.textContent=`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      display.classList.remove('ticking');
    };
    tick();_fTimer=setInterval(tick,1000);
    return;
  }

  // active countdown-to-finish: ring fills as time elapses
  _fMode='running';_fStartAt=startMs;_fEndAt=endMs;_fTotalMs=Math.max(1,endMs-startMs);
  if(startBtn){startBtn.textContent='stop';startBtn.classList.add('running');}
  if(pauseBtn){pauseBtn.style.display='inline-block';pauseBtn.textContent='pause';}
  if(label)label.textContent='in session';
  const tick=()=>{
    const rem=_fEndAt-Date.now();
    if(!display)return;
    if(rem<=0){_fFireAlarm();return;}
    const m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);
    display.textContent=`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    display.classList.add('ticking');
    _fSetRing((Date.now()-_fStartAt)/_fTotalMs);
  };
  tick();_fTimer=setInterval(tick,1000);
}

function _fPauseTimer(){
  if(_fMode!=='running')return;
  if(_fTimer){clearInterval(_fTimer);_fTimer=null;}
  _fPausedRemainingMs=Math.max(0,_fEndAt-Date.now());
  _fMode='paused';
  const display=document.getElementById('fTimerDisplay'),label=document.getElementById('fTimerLabel'),pauseBtn=document.getElementById('fPauseBtn');
  display?.classList.remove('ticking');
  if(label)label.textContent='paused';
  if(pauseBtn)pauseBtn.textContent='resume';
}
function _fResumeTimer(){
  if(_fMode!=='paused')return;
  _fEndAt=Date.now()+_fPausedRemainingMs;
  _fMode='running';
  const display=document.getElementById('fTimerDisplay'),label=document.getElementById('fTimerLabel'),pauseBtn=document.getElementById('fPauseBtn');
  if(label)label.textContent='in session';
  if(pauseBtn)pauseBtn.textContent='pause';
  const tick=()=>{
    const rem=_fEndAt-Date.now();
    if(!display)return;
    if(rem<=0){_fFireAlarm();return;}
    const m=Math.floor(rem/60000),s=Math.floor((rem%60000)/1000);
    display.textContent=`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    display.classList.add('ticking');
    _fSetRing((Date.now()-_fStartAt)/_fTotalMs);
  };
  tick();_fTimer=setInterval(tick,1000);
}

async function loadFocusTask(refetch){
  const skipBtn=document.getElementById('focusSkipGlobal');
  const navText=document.getElementById('focusNavText');
  try{
    if(refetch){
      const tasks=await fetch(API+'/api/tasks').then(r=>r.json());
      _fQueue=tasks.filter(t=>t.status==='open');_fIdx=0;
    }
    if(!_fQueue.length){
      focusContent.innerHTML='<div class="focus-empty">nothing open.<br>clean slate, go you 👏</div>';
      if(skipBtn)skipBtn.style.display='none';
      if(navText)navText.textContent='focus mode';
      return;
    }
    if(_fIdx>=_fQueue.length)_fIdx=0;
    _fStopTimer();
    const t=_fQueue[_fIdx];
    if(navText)navText.textContent=`${_fIdx+1} of ${_fQueue.length}`;
    if(skipBtn)skipBtn.style.display=_fQueue.length>1?'inline-block':'none';
    const hasNotes=!!(t.notes&&t.notes.trim());
    const badge=t.priority==='high'?'<span class="pri-dot high"></span>high priority':t.priority==='low'?'<span class="pri-dot low"></span>low priority':'';

    // default: start now, end 25 min from now — unless this task already has a schedule
    const now=new Date();
    // Determine initial duration
    let _activeMins = 25;
    if (t.due_at && t.start_at) {
      const stored = Math.round((new Date(t.due_at) - new Date(t.start_at)) / 60000);
      if (stored > 0) _activeMins = stored;
    }

    const _quickDurs = [5, 10, 25, 50];

    focusContent.innerHTML = `
      <div class="focus-top">
        ${badge ? `<div class="focus-priority-badge">${badge}</div>` : ''}
        <div class="focus-task-title">${esc(t.title)}</div>
        ${hasNotes ? `<div class="focus-task-notes">${esc(t.notes)}</div>` : ''}
      </div>

      <div class="focus-hero">
        <div class="focus-complete-wrap">
          <div class="focus-complete-ring" id="fCompleteRing" role="button" aria-label="Mark done" tabindex="0">
            <svg viewBox="0 0 200 200">
              <circle class="focus-cr-bg" cx="100" cy="100" r="92"/>
              <circle class="focus-cr-fill" id="fCrFill" cx="100" cy="100" r="92"/>
            </svg>
            <div class="focus-cr-inner">
              <div class="focus-timer-edit-wrap">
                <div id="fTimerDisplay" class="focus-timer-display" title="tap to set custom duration">
                  ${String(Math.floor(_activeMins)).padStart(2,'0')}:00
                </div>
                <div class="focus-timer-label" id="fTimerLabel">tap center to edit</div>
                <!-- hidden input for custom duration entry -->
                <input type="number" id="fCustomInput" class="focus-timer-custom-input"
                  min="1" max="999" step="1"
                  placeholder="${_activeMins}"
                  aria-label="Custom duration in minutes">
              </div>
            </div>
          </div>
          <div class="focus-complete-hint" id="fCompleteHint">tap edge to complete</div>
        </div>
      </div>

      <div class="focus-bottom">
        <div class="focus-duration-chips" id="fDurChips">
          ${_quickDurs.map(m => `
            <button class="focus-dur-chip${m === _activeMins ? ' active' : ''}"
              data-mins="${m}" type="button">${m}m</button>
          `).join('')}
        </div>
        <div class="focus-btn-row">
          <button class="focus-start-btn" id="fStartBtn" type="button">start</button>
          <button class="focus-pause-btn" id="fPauseBtn" type="button" style="display:none">pause</button>
        </div>
      </div>
    `;

    // Tap timer display to edit custom duration
    const disp = document.getElementById('fTimerDisplay');
    const customInput = document.getElementById('fCustomInput');

    disp?.addEventListener('click', () => {
      if (_fMode !== 'idle') return;
      disp.classList.add('editing');
      customInput.value = '';
      customInput.placeholder = String(_activeMins);
      customInput.style.opacity = '1';
      customInput.focus();
    });
    customInput?.addEventListener('blur', () => {
      const v = parseInt(customInput.value, 10);
      if (v > 0) {
        _activeMins = Math.min(v, 999);
        // deactivate all quick chips since this is custom
        document.querySelectorAll('.focus-dur-chip').forEach(c => c.classList.remove('active'));
      }
      disp?.classList.remove('editing');
      customInput.style.opacity = '0';
      if (disp && _fMode === 'idle') {
        disp.textContent = String(_activeMins).padStart(2, '0') + ':00';
        const l = document.getElementById('fTimerLabel');
        if (l) l.textContent = 'tap to set time';
      }
    });
    customInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { customInput.blur(); }
      if (e.key === 'Escape') { customInput.value = ''; customInput.blur(); }
    });

    // Quick chip selection
    document.getElementById('fDurChips')?.addEventListener('click', e => {
      const chip = e.target.closest('.focus-dur-chip');
      if (!chip || _fMode === 'running' || _fMode === 'waiting') return;
      _activeMins = parseInt(chip.dataset.mins, 10);
      document.querySelectorAll('.focus-dur-chip').forEach(c => c.classList.toggle('active', c === chip));
      if (disp && _fMode === 'idle') {
        disp.textContent = String(_activeMins).padStart(2, '0') + ':00';
      }
    });

    // Start / stop / dismiss
    document.getElementById('fStartBtn')?.addEventListener('click', () => {
      if (_fMode === 'alarm') {
        _fStopTimer();
        if (disp) { disp.textContent = String(_activeMins).padStart(2,'0')+':00'; disp.classList.remove('alarm'); }
        const b = document.getElementById('fStartBtn');
        if (b) { b.textContent = 'start'; b.classList.remove('running','alarm-state'); }
        const l = document.getElementById('fTimerLabel');
        if (l) l.textContent = 'tap to set time';
        _fSetRing(0);
        return;
      }
      if (_fMode === 'running') {
        _fStopTimer();
        if (disp) { disp.textContent = String(_activeMins).padStart(2,'0')+':00'; disp.classList.remove('ticking'); }
        const b = document.getElementById('fStartBtn');
        if (b) { b.textContent = 'start'; b.classList.remove('running'); }
        const l = document.getElementById('fTimerLabel');
        if (l) l.textContent = 'tap to set time';
        _fSetRing(0);
        return;
      }
      const startNow = new Date().toISOString();
      const endVal = new Date(Date.now() + _activeMins * 60000).toISOString();
      fetch(`${API}/api/tasks/${t.id}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({start_at: startNow, due_at: endVal})
      }).catch(() => {});
      _fStartTimer(startNow, endVal);
    });

    // Pause / resume — separate from stop, keeps the session alive
    document.getElementById('fPauseBtn')?.addEventListener('click', () => {
      if (_fMode === 'running') _fPauseTimer();
      else if (_fMode === 'paused') _fResumeTimer();
    });

    // Reset: just stop timer, restore display
    document.getElementById('fResetBtn')?.addEventListener('click', () => {
      _fStopTimer();
      if (disp) { disp.textContent = String(_activeMins).padStart(2,'0')+':00'; disp.classList.remove('ticking','alarm'); }
      const l = document.getElementById('fTimerLabel');
      if (l) l.textContent = 'tap to set time';
      const b = document.getElementById('fStartBtn');
      if (b) { b.textContent = 'start'; b.classList.remove('running','alarm-state'); }
      _fSetRing(0);
    });

    // Complete ring tap
    const ring = document.getElementById('fCompleteRing');
    const completeTask = async () => {
      // Don't complete if user tapped inner area to edit time
      if (_fMode === 'idle') return;
      const r = ring.getBoundingClientRect();
      popBurst(r.left+r.width/2, r.top+r.height/2);
      playChime(t.priority === 'high');
      haptic(10);
      _fStopTimer();
      await fetch(`${API}/api/tasks/${t.id}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({status: 'done', touch: true})
      });
      loadTasks(); loadMomentum(); checkMilestones();
      _fQueue.splice(_fIdx, 1);
      loadFocusTask(false);
    };
    ring?.addEventListener('click', e => {
      // Only complete if clicking the outer ring SVG part, not the inner timer area
      if (e.target.closest('.focus-cr-inner')) return;
      completeTask();
    });
    ring?.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') completeTask(); });

    // Auto-resume existing schedule
    if (t.due_at) {
      const dueMs = new Date(t.due_at).getTime();
      if (dueMs <= Date.now()) {
        setTimeout(() => _fFireAlarm(), 50);
      } else {
        _fStartTimer(t.start_at || null, t.due_at);
      }
    }
  }catch{focusContent.innerHTML='<div class="focus-empty">couldn\'t load — check your connection.</div>';}
}

focusCloseBtn.addEventListener('click',closeFocus);
focusView.addEventListener('click',e=>{
  if(e.target.id==='focusSkipGlobal'||e.target.closest('#focusSkipGlobal')){
    _fIdx=(_fIdx+1)%Math.max(1,_fQueue.length);loadFocusTask(false);
  }
});

/* ── Nav / tabs ───────────────────────────────────────────────────────────── */
const composeBar=document.getElementById('composeBar');
const chatInputRow=document.getElementById('chatInputRow');

// Mobile keyboards resize the visual viewport, not the layout viewport —
// a `position:fixed` bar keeps sitting where the *layout* viewport's bottom
// used to be, which is now behind the keyboard. Pin it to the real bottom
// of the visible viewport instead whenever the keyboard is up.
if(window.visualViewport){
  function syncInputToKeyboard(){
    const vv=window.visualViewport;
    if(!vv)return;
    const kb=Math.max(0,window.innerHeight-vv.height-vv.offsetTop);
    const bottom=kb>60?(kb+8)+'px':'';
    if(composeBar)composeBar.style.bottom=bottom;
    if(chatInputRow)chatInputRow.style.bottom=bottom;
  }
  window.visualViewport.addEventListener('resize',syncInputToKeyboard);
  window.visualViewport.addEventListener('scroll',syncInputToKeyboard);
  syncInputToKeyboard();
}
const tabOrder=['tasks','calendar','finance','chat','profile'];
// Desktop only: "/" jumps to the input on the current tab, Esc leaves it.
document.addEventListener('keydown',e=>{
  if(!window.matchMedia('(min-width:1024px)').matches)return;
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  const ae=document.activeElement;
  if(ae&&(/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)||ae.isContentEditable)){
    if(e.key==='Escape')ae.blur();
    return;
  }
  if(e.key==='/'){
    const tab=document.querySelector('.nav-item.active')?.dataset.tab;
    const el=tab==='chat'?document.getElementById('chatInput'):tab==='tasks'?document.getElementById('input'):null;
    if(el){e.preventDefault();el.focus();}
  }
});
document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click',()=>{
    const current=document.querySelector('.nav-item.active')?.dataset.tab||'tasks';
    const next=item.dataset.tab;
    if(current===next)return;
    const movingBack=tabOrder.indexOf(next)<tabOrder.indexOf(current);
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    item.classList.add('active');
    const panel=document.getElementById('tab-'+next);
    panel.classList.toggle('tab-back',movingBack);
    panel.classList.add('active');
    // Clip overflow during slide so panel doesn't show outside viewport
    document.getElementById('app').style.overflow='hidden';
    panel.addEventListener('animationend',()=>{
      panel.classList.remove('tab-back');
      document.getElementById('app').style.overflow='';
    },{once:true});
    // show compose bar only on tasks tab
    composeBar.style.display=item.dataset.tab==='tasks'?'block':'none';
    if(finLogBar)finLogBar.classList.toggle('show',item.dataset.tab==='finance');
    document.getElementById('finGlow').style.display=item.dataset.tab==='finance'?'block':'none';
    chatInputRow?.classList.toggle('show',item.dataset.tab==='chat');
    if(item.dataset.tab==='tasks')refreshBriefMoney();
    if(item.dataset.tab==='finance'){loadFinance();loadBankSettings();loadBudgets();loadBudgetSuggestions();}
    if(item.dataset.tab==='chat'){
      loadChatContext();
      requestAnimationFrame(()=>requestAnimationFrame(_startChatParticles));
    } else {
      _stopChatParticles();
    }
    if(item.dataset.tab==='calendar')window.CorePACalendar?.open(); if(item.dataset.tab==='profile'){loadProfile();if(settingsNameInput)settingsNameInput.value=userName==='there'?'':userName;}
    window.scrollTo({top:0,behavior:'instant'});
  });
});

// ── Tab swipe gesture (mobile) ────────────────────────────────────────────────
(function(){
  const wrap = document.querySelector('.wrap');
  if (!wrap) return;
  const tabSwipeOrder = ['tasks','calendar','finance','chat','profile'];
  let tgX = 0, tgDX = 0, tgActive = false, tgStartY = 0;
  wrap.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    tgX = e.touches[0].clientX; tgStartY = e.touches[0].clientY; tgDX = 0; tgActive = true;
  }, { passive: true });
  wrap.addEventListener('touchmove', e => {
    if (!tgActive) return;
    const dx = e.touches[0].clientX - tgX;
    const dy = e.touches[0].clientY - tgStartY;
    if (Math.abs(dx) < Math.abs(dy) * 1.2) { tgActive = false; return; }
    tgDX = dx;
  }, { passive: true });
  wrap.addEventListener('touchend', () => {
    if (!tgActive) return; tgActive = false;
    if (Math.abs(tgDX) < 60) return;
    const activeTab = document.querySelector('.nav-item.active');
    if (!activeTab) return;
    const cur = tabSwipeOrder.indexOf(activeTab.dataset.tab);
    if (cur === -1) return;
    const next = tgDX < -60 ? tabSwipeOrder[cur + 1] : tabSwipeOrder[cur - 1];
    if (!next) return;
    const btn = document.querySelector(`.nav-item[data-tab="${next}"]`);
    if (btn) btn.click();
  });
})();

/* ── Status ───────────────────────────────────────────────────────────────── */
async function loadStatus(){
  try{
    const d=await fetch(API+'/api/telegram/status').then(r=>r.json());
    const dot=document.getElementById('statusDot'),
          txt=document.getElementById('statusText'),
          ban=document.getElementById('linkBanner');
    if(d.linked){
      dot.classList.add('linked');txt.textContent='linked';ban.style.display='none';
    }else{
      dot.classList.remove('linked');txt.textContent='not linked';ban.style.display='flex';
    }
    const st=document.getElementById('tgStatusLabel');
    if(st) st.textContent=d.linked?'connected':'not connected';
    const tgDot=document.getElementById('tgDot');
    if(tgDot) tgDot.classList.toggle('linked',!!d.linked);
    const btn=document.getElementById('tgActionBtn');
    if(btn) btn.textContent=d.linked?'disconnect':'connect →';
  }catch{document.getElementById('statusText').textContent='offline';}
}

// Generates a one-time link code and opens Telegram with it prefilled.
async function connectTelegram(){
  try{
    const response=await fetch(API+'/api/telegram/link-code',{method:'POST'});
    const raw=await response.text();
    let d={};
    try{d=raw?JSON.parse(raw):{};}catch{}
    if(d.error){
      notify({msg:d.error});
      return;
    }
    if(!response.ok || !d.url){
      const detail=raw&&raw.length<180?raw:`server returned HTTP ${response.status}`;
      notify({msg:`could not generate a Telegram link: ${detail}`});
      return;
    }

    const openDeepLink = (url) => {
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        return true;
      } catch (e) {
        return false;
      }
    };

    const isAppleDevice=/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;
    const opened = isAppleDevice ? (window.location.href=d.url,true) : openDeepLink(d.url);
    if(!opened){
      window.location.href = d.url;
    }

    notify({msg:'opening telegram — tap start to finish linking'});
    // poll briefly so the UI updates once they've tapped start
    let tries=0;
    const iv=setInterval(async()=>{
      tries++;
      await loadStatus();
      const s=await fetch(API+'/api/telegram/status').then(r=>r.json()).catch(()=>({}));
      if(s.linked||tries>20) clearInterval(iv);
    },3000);
  }catch(e){
    notify({msg:'couldn\'t generate a link code — try again'});
  }
}

async function disconnectTelegram(){
  if(!confirm('stop receiving reminders on telegram?')) return;
  await fetch(API+'/api/telegram/unlink',{method:'POST'});
  loadStatus();
  notify({msg:'telegram disconnected'});
}

document.querySelectorAll('.telegram-connect-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const connected = document.getElementById('tgStatusLabel')?.textContent === 'connected';
    if (connected) {
      disconnectTelegram();
      return;
    }
    connectTelegram();
  });
});

/* ── Notification preferences (channel + escalation timing) ─────────────────── */

// Web Push needs its VAPID key as a Uint8Array, not the base64url string the
// server hands back — this is the standard conversion every push
// implementation needs.
function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

let _notifPrefsCache=null;

function formatMinutesList(values){
  return (values||[]).map(v => {
    const minutes = Number(v);
    if (!Number.isFinite(minutes) || minutes <= 0) return '';
    const days = minutes / 1440;
    if (Number.isInteger(days) && days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
    const hours = minutes / 60;
    if (Number.isInteger(hours) && hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
    return `${minutes} min`;
  }).filter(Boolean).join(', ');
}

function parseMinutesInput(raw){
  const text = String(raw || '').trim();
  if (!text) return [];
  const matches = text.split(',').flatMap(part => {
    const match = part.trim();
    if (!match) return [];
    const normalized = match.toLowerCase();
    const dayMatch = normalized.match(/^([0-9]+)\s*(d|day|days)$/);
    if (dayMatch) return [Number(dayMatch[1]) * 1440];
    const hourMatch = normalized.match(/^([0-9]+)\s*(h|hr|hrs|hour|hours)$/);
    if (hourMatch) return [Number(hourMatch[1]) * 60];
    const minuteMatch = normalized.match(/^([0-9]+)\s*(m|min|mins|minute|minutes)$/);
    if (minuteMatch) return [Number(minuteMatch[1])];
    const numeric = Number(match);
    return Number.isFinite(numeric) && numeric > 0 ? [numeric] : [];
  });
  return matches.filter(v => Number.isFinite(v) && v > 0);
}

async function loadNotificationPrefs(){
  try{
    const d=await fetch(API+'/api/notifications/preferences').then(r=>r.json());
    _notifPrefsCache=d;

    document.querySelectorAll('.notif-chip').forEach(chip=>{
      chip.classList.toggle('active', chip.dataset.channel===d.channel);
    });

    const escHigh=document.getElementById('escHigh'), escNormal=document.getElementById('escNormal'), escLow=document.getElementById('escLow');
    if(escHigh)   escHigh.value=formatMinutesList(d.escalation.high||[]);
    if(escNormal) escNormal.value=formatMinutesList(d.escalation.normal||[]);
    if(escLow)    escLow.value=formatMinutesList(d.escalation.low||[]);

    // Morning brief toggle
    const mbToggle=document.getElementById('morningBriefToggle');
    const mbTrack=document.getElementById('morningBriefTrack');
    const mbThumb=document.getElementById('morningBriefThumb');
    if(mbToggle){
      mbToggle.checked=!!d.morningBrief;
      _applyMorningBriefToggle(!!d.morningBrief,mbTrack,mbThumb);
    }

    const enableRow=document.getElementById('pushEnableRow'), notConfigured=document.getElementById('pushNotConfiguredNote');
    const wantsPush=d.channel==='push'||d.channel==='both';
    if(!d.pushConfigured){
      if(notConfigured) notConfigured.style.display=wantsPush?'block':'none';
      if(enableRow) enableRow.style.display='none';
    }else{
      if(notConfigured) notConfigured.style.display='none';
      if(enableRow) enableRow.style.display=wantsPush?'block':'none';
    }
  }catch(e){ console.error('[notif] failed to load preferences:', e.message); }
}

async function loadVoiceSetting(){
  const select=document.getElementById('voiceSelect'), hint=document.getElementById('voiceSettingHint');
  try{
    const d=await fetch(API+'/api/settings/voice').then(r=>r.json());
    select.innerHTML=d.options.map(o=>`<option value="${o.id}" ${o.id===d.voice?'selected':''}>${esc(o.label)}</option>`).join('');
    if(hint)hint.textContent='used for the speaker icon on Core\'s replies';
  }catch(e){
    console.error('[voice] failed to load setting:', e.message);
    if(hint)hint.textContent='could not load — try again later';
  }
}
async function setVoiceSetting(voice){
  const hint=document.getElementById('voiceSettingHint');
  try{
    const res=await fetch(API+'/api/settings/voice',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice})});
    if(!res.ok)throw new Error((await res.json().catch(()=>({}))).error||'save failed');
    toast(`voice set — tap the speaker on any reply to hear it`);
  }catch(e){
    if(hint)hint.textContent='couldn\'t save that — try again';
    toast('couldn\'t change voice — try again');
  }
}
document.getElementById('voiceSelect')?.addEventListener('change',e=>setVoiceSetting(e.target.value));

async function setNotificationChannel(channel){
  document.querySelectorAll('.notif-chip').forEach(chip=>chip.classList.toggle('active',chip.dataset.channel===channel));
  try{
    await fetch(API+'/api/notifications/preferences',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({channel}),
    });
    notify({msg:`reminders set to ${channel}`});
  }catch(e){ notify({msg:'couldn\'t save that — try again'}); }

  const wantsPush=channel==='push'||channel==='both';
  if(wantsPush && 'Notification' in window){
    const perm=Notification.permission;
    if(perm==='default'){
      await enablePushOnThisDevice();
    } else if(perm==='denied'){
      showPushSettingsHelp();
      openPhoneNotificationSettings();
      notify({msg:'notifications are blocked on this phone — open your app settings and allow them'});
    }
  }

  loadNotificationPrefs();
}

document.querySelectorAll('.notif-chip').forEach(chip=>{
  chip.addEventListener('click',()=>setNotificationChannel(chip.dataset.channel));
});

document.getElementById('saveEscalationBtn')?.addEventListener('click',async()=>{
  const parse=(id,fallback)=>{
    const raw=document.getElementById(id)?.value||'';
    const nums=parseMinutesInput(raw);
    return nums.length?nums:fallback;
  };
  const escalation={
    high:   parse('escHigh',[5,15,60]),
    normal: parse('escNormal',[60]),
    low:    parse('escLow',[4320]),
  };
  try{
    await fetch(API+'/api/notifications/preferences',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({escalation}),
    });
    notify({msg:'nudge timing saved'});
  }catch(e){ notify({msg:'couldn\'t save that — try again'}); }
});

// ── Morning brief toggle ───────────────────────────────────────────────────────
function _applyMorningBriefToggle(on, track, thumb) {
  if (!track || !thumb) return;
  track.style.background = on ? 'rgba(var(--pink-rgb),.35)' : '';
  track.style.borderColor = on ? 'var(--pink-dim)' : '';
  thumb.style.transform = on ? 'translateX(20px)' : '';
  thumb.style.background = on ? 'var(--pink)' : '';
}

document.getElementById('morningBriefToggle')?.addEventListener('change', async function() {
  const on = this.checked;
  _applyMorningBriefToggle(on,
    document.getElementById('morningBriefTrack'),
    document.getElementById('morningBriefThumb')
  );
  try {
    await fetch(API+'/api/notifications/preferences', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ morningBrief: on }),
    });
    notify({ msg: on ? 'morning brief on — see you at 07:00 ☀️' : 'morning brief off' });
  } catch { notify({ msg: 'couldn\'t save — try again' }); }
});

function showPushSettingsHelp(){
  const note=document.getElementById('pushNotConfiguredNote');
  const btn=document.getElementById('pushEnableBtn');
  const ua=navigator.userAgent||'';
  const isApple=/iPhone|iPad|iPod/i.test(ua);
  const isAndroid=/Android/i.test(ua);
  const helpText = isApple
    ? 'notifications are blocked on this iPhone. open Settings → Notifications → Safari/Chrome → Allow notifications, then return here and tap the button again.'
    : isAndroid
      ? 'notifications are blocked on this phone. open Settings → Apps → your browser → Notifications → Allow, then return here and tap the button again.'
      : 'notifications are blocked for this site in your browser settings. enable them there, then come back and try again.';

  if(note){
    note.style.display='block';
    note.textContent=helpText;
    note.style.color='var(--text)';
  }
  if(btn){
    btn.textContent=isApple || isAndroid ? 'open phone settings →' : 'enable notifications →';
    btn.dataset.help='true';
  }
}

function openPhoneNotificationSettings(){
  const ua=navigator.userAgent||'';
  const attempts=[
    'app-settings:',
    'prefs:root=NOTIFICATIONS_ID',
    'about:blank',
  ];

  const maybeOpen=(url)=>{
    try{ window.location.href=url; }
    catch(e){}
  };

  if(/iPhone|iPad|iPod/i.test(ua)){
    maybeOpen('app-settings:');
    maybeOpen('prefs:root=NOTIFICATIONS_ID');
    return true;
  }

  if(/Android/i.test(ua)){
    try{
      const androidUrl='android.settings.APP_NOTIFICATION_SETTINGS';
      window.location.href=androidUrl;
      return true;
    }catch(e){}
  }

  return false;
}

async function enablePushOnThisDevice(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window)){
    notify({msg:'push isn\'t supported on this browser'});
    return;
  }
  try{
    if(Notification.permission==='denied'){
      showPushSettingsHelp();
      const opened=openPhoneNotificationSettings();
      notify({msg: opened ? 'open your phone notifications settings to allow alerts' : 'notifications are blocked for this site in your browser settings'});
      return;
    }
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){
      showPushSettingsHelp();
      notify({msg:'permission not granted — enable notifications in your phone settings'});
      return;
    }

    const {key}=await fetch(API+'/api/push/vapid-public-key').then(r=>r.json());
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:urlBase64ToUint8Array(key),
    });

    await fetch(API+'/api/push/subscribe',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({subscription:sub.toJSON()}),
    });
    const note=document.getElementById('pushNotConfiguredNote');
    if(note){ note.style.display='none'; }
    const btn=document.getElementById('pushEnableBtn');
    if(btn){ btn.textContent='enabled on this device ✓'; btn.dataset.help='false'; }
    notify({msg:'push enabled on this device 🔔'});
    loadNotificationPrefs();
  }catch(e){
    console.error('[push] subscribe failed:',e);
    notify({msg:'couldn\'t enable push — try again'});
  }
}

document.getElementById('pushEnableBtn')?.addEventListener('click',enablePushOnThisDevice);

/* ── Plan, usage & billing ───────────────────────────────────────────────── */

const USAGE_LABELS={
  ai_message:'AI messages', statement_import:'statement imports',
  transcribe:'voice notes', task:'open tasks', itinerary:'AI plans', breakdown:'task breakdowns',
};

async function loadPlan(){
  try{
    const d=await fetch(API+'/api/billing/me').then(r=>r.json());
    const nameEl=document.getElementById('planName'), priceEl=document.getElementById('planPrice');
    if(!nameEl) return; // settings tab not in DOM yet on this build — skip quietly
    nameEl.textContent=d.plan.name;
    priceEl.textContent=d.plan.priceZAR>0?`R${d.plan.priceZAR}/month`:'free plan';
    const upBtn=document.getElementById('upgradeBtn');
    if(upBtn) upBtn.style.display=d.plan.id==='free'?'block':'none';

    const meters=document.getElementById('usageMeters');
    if(meters) meters.innerHTML=Object.entries(d.usage).map(([k,v])=>{
      if(v.limit===null) return `
        <div class="usage-row">
          <div class="usage-top"><span>${USAGE_LABELS[k]||k}</span><span class="usage-num">unlimited</span></div>
        </div>`;
      const pct=Math.min(100,Math.round((v.used/v.limit)*100));
      const hot=pct>=80;
      return `
        <div class="usage-row">
          <div class="usage-top">
            <span>${USAGE_LABELS[k]||k}</span>
            <span class="usage-num${hot?' hot':''}">${v.used} / ${v.limit}</span>
          </div>
          <div class="usage-bar"><div class="usage-fill${hot?' hot':''}" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
  }catch(e){
    const priceEl=document.getElementById('planPrice');
    if(priceEl) priceEl.textContent='could not load plan';
  }
}

// Builds the PayFast form server-side (signed there, never here) and submits it.
async function startCheckout(plan='pro'){
  try{
    const d=await fetch(API+'/api/billing/checkout',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({plan}),
    }).then(r=>r.json());

    if(d.error){ notify({msg:'billing isn\'t configured yet'}); return; }

    const f=document.createElement('form');
    f.method='POST'; f.action=d.action;
    Object.entries(d.fields).forEach(([k,v])=>{
      const i=document.createElement('input');
      i.type='hidden'; i.name=k; i.value=v; f.appendChild(i);
    });
    document.body.appendChild(f); f.submit();
  }catch(e){ notify({msg:'billing isn\'t configured yet'}); }
}

document.getElementById('upgradeBtn')?.addEventListener('click',()=>startCheckout('pro'));

document.getElementById('deleteAccountBtn')?.addEventListener('click',()=>{
  openDangerConfirm({
    title:'delete your account?',
    message:'this permanently deletes your account and all your data. this cannot be undone.',
    phrase:'DELETE',
    needsPassword:true,
    confirmLabel:'delete my account',
    onConfirm: async (pw)=>{
      try{
        const d=await fetch(API+'/api/account',{
          method:'DELETE',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({password:pw}),
        }).then(r=>r.json());
        if(d.error){ notify({msg:d.error}); return; }
        location.href='/';
      }catch(e){ notify({msg:e.message||'could not delete account'}); }
    },
  });
});

// If they came from the pricing page having picked Pro, send them to checkout
// once they're signed in.
function resumePendingPlan(){
  const p=sessionStorage.getItem('pendingPlan');
  if(p){ sessionStorage.removeItem('pendingPlan'); startCheckout(p); }
}

/* ── Briefing card ───────────────────────────────────────────────────────── */

async function loadBrief(){
  try{
    const d=await fetch(API+'/api/context').then(r=>r.json());
    const btn=document.getElementById('briefBtn');
    if(!btn) return;
    if(!d.openCount && !d.financeNet){ btn.style.display='none'; return; }
    document.getElementById('dailyBrief').style.display='block';
    btn.style.display='';
  }catch{}
}

document.getElementById('briefBtn')?.addEventListener('click',async e=>{
  const btn=e.currentTarget, out=document.getElementById('briefReply');
  btn.disabled=true; btn.textContent='thinking…';
  try{
    const d=await fetch(API+'/api/chat/day',{method:'POST'}).then(r=>r.json());
    if(d.error) throw new Error(d.error);
    out.textContent=d.reply;
    out.classList.add('show');
    btn.style.display='none';
    loadPlan(); // usage just changed — refresh the meter
  }catch(err){
    const msg=String(err.message||'');
    if(msg.includes('quota')||msg.includes('402')){
      out.textContent='you\'ve used your AI messages for this month. upgrade in settings to keep going.';
    }else{
      out.textContent='couldn\'t think that through right now — try again in a sec.';
    }
    out.classList.add('show');
    btn.disabled=false; btn.textContent='try again →';
  }
});


/* ── recording indicator (shared by both mics) ── */
let _recPill=null,_recTick=null,_recAuto=null;
function showRecIndicator(onStop){
  if(!_recPill){_recPill=document.createElement('div');_recPill.className='rec-pill';document.body.appendChild(_recPill);}
  _recPill.onclick=onStop;
  _recPill.classList.remove('busy');_recPill.classList.add('show');
  const t0=Date.now();
  const paint=()=>{const s=Math.floor((Date.now()-t0)/1000);_recPill.innerHTML=`<span class="dot"></span>recording ${Math.floor(s/60)}:${String(s%60).padStart(2,'0')} · tap to stop`;};
  paint();clearInterval(_recTick);_recTick=setInterval(paint,500);
  clearTimeout(_recAuto);_recAuto=setTimeout(()=>{toast('stopped at 90s');onStop();},90000);
  try{navigator.vibrate&&navigator.vibrate(30);}catch{}
}
function setRecBusy(label){
  clearInterval(_recTick);clearTimeout(_recAuto);
  if(!_recPill)return;
  _recPill.onclick=null;_recPill.classList.add('show','busy');
  _recPill.innerHTML=`<span class="dot"></span>${label}`;
  try{navigator.vibrate&&navigator.vibrate(20);}catch{}
}
function hideRecIndicator(){
  clearInterval(_recTick);clearTimeout(_recAuto);
  _recPill?.classList.remove('show','busy');
}
if(micBtn&&navigator.mediaDevices&&window.MediaRecorder){
  micBtn.style.display='flex';
  let mediaRecorder=null,recChunks=[],recording=false,recStream=null,micBusy=false;

  async function startRecording(){
    if(micBusy)return;
    micBusy=true;
    const isStandalone=window.navigator.standalone===true||matchMedia('(display-mode: standalone)').matches;
    try{
      recStream=await Promise.race([
        navigator.mediaDevices.getUserMedia({audio:true}),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('mic timeout')),6000))
      ]);
    }catch{
      micBusy=false;
      toast(isStandalone?"voice input doesn't work when added to your Home Screen on iPhone — open in Safari to use it, or just type":'mic permission denied');
      return;
    }
    recChunks=[];
    const mime=['audio/webm','audio/mp4','audio/ogg'].find(t=>MediaRecorder.isTypeSupported(t))||'';
    mediaRecorder=new MediaRecorder(recStream,mime?{mimeType:mime}:undefined);
    mediaRecorder.addEventListener('dataavailable',e=>{if(e.data.size>0)recChunks.push(e.data);});
    mediaRecorder.addEventListener('stop',onRecordingStop);
    mediaRecorder.start();
    recording=true;micBusy=false;micBtn.classList.add('listening');showRecIndicator(stopRecording);
  }
  function stopRecording(){
    if(mediaRecorder&&recording)mediaRecorder.stop();
    recStream?.getTracks().forEach(t=>t.stop());
    recording=false;micBtn.classList.remove('listening');setRecBusy('transcribing…');
  }
  async function onRecordingStop(){
    if(!recChunks.length){hideRecIndicator();toast('didn\'t catch anything — try again');return;}
    const blob=new Blob(recChunks,{type:mediaRecorder.mimeType||'audio/webm'});
    micBtn.classList.add('transcribing');
    const fd=new FormData();
    const _ext=blob.type.includes('mp4')||blob.type.includes('m4a')?'m4a':blob.type.includes('ogg')?'ogg':blob.type.includes('wav')?'wav':'webm';
    fd.append('audio',blob,`voice.${_ext}`);
    try{
      const res=await fetch(API+'/api/transcribe',{method:'POST',body:fd});
      const data=await res.json();
      if(!res.ok||!data.text)throw new Error(data.error||'empty transcript');
      input.value=(input.value?input.value+' ':'')+data.text;
      autoGrow(input);
    }catch{toast('voice capture failed — try again');}
    micBtn.classList.remove('transcribing');hideRecIndicator();
  }
  micBtn.addEventListener('click',()=>{
    if(micBusy)return;
    if(recording){stopRecording();}else{startRecording();}
  });
}

let activeFilter='all'; // 'all' | 'today' | 'overdue' | 'high'
function taskSortDate(task){
  const candidates=[task.due_at, task.remind_at, task.start_at].filter(Boolean).map(v=>new Date(v).getTime()).filter(n=>!Number.isNaN(n));
  return candidates.length ? Math.min(...candidates) : Number.MAX_SAFE_INTEGER;
}
function applyTaskFilter(tasks){
  if(activeFilter==='all')return tasks;
  const now=Date.now();
  const todayStr=new Date().toDateString();
  if(activeFilter==='today')  return tasks.filter(t=>t.remind_at&&new Date(t.remind_at).toDateString()===todayStr);
  if(activeFilter==='overdue')return tasks.filter(t=>{ const d=taskSortDate(t); return d !== Number.MAX_SAFE_INTEGER && d < now; });
  if(activeFilter==='high')   return tasks.filter(t=>t.priority==='high');
  return tasks;
}
function sortOpenTasks(tasks){
  return [...tasks].sort((a,b)=>{
    const priorityOrder={high:0,normal:1,low:2};
    const aPriority=priorityOrder[a.priority] ?? 1;
    const bPriority=priorityOrder[b.priority] ?? 1;
    if(aPriority!==bPriority) return aPriority-bPriority;

    const aDate=taskSortDate(a);
    const bDate=taskSortDate(b);
    const aOverdue=aDate< Date.now();
    const bOverdue=bDate< Date.now();
    if(aOverdue!==bOverdue) return aOverdue?-1:1;

    if(aDate!==bDate) return aDate-bDate;
    return new Date(a.created_at)-new Date(b.created_at);
  });
}
const EMPTY_OPEN_SVG=`<svg class="empty-illustration" width="64" height="64" viewBox="0 0 64 64" fill="none"><path d="M32,6 C45,6 54,15 55,28 C56,40 47,50 33,52 C20,54 9,45 8,32 C7,19 17,7 32,6 Z" stroke="var(--pink)" stroke-width="1.4" stroke-dasharray="4 5" opacity=".5"/><path d="M21 33l7 7 15-16" stroke="var(--pink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none" transform="rotate(-2 32 32)"/></svg>`;
function renderDoneHistory(){
  const done=[...(_tasksCache||[]).filter(t=>t.status==='done')].sort((a,b)=>new Date(b.last_touched_at)-new Date(a.last_touched_at));
  const wrap=document.getElementById('doneHistoryWrap');
  const header=document.getElementById('doneHistoryHeader');
  const toggle=document.getElementById('doneHistoryToggle');
  if(!wrap||!header||!toggle){ return; }
  const hasDone=done.length>0;
  header.style.display=hasDone?'flex':'none';
  if(!hasDone){
    wrap.style.display='none';
    toggle.textContent='show';
    toggle.setAttribute('aria-expanded','false');
    wrap.classList.remove('open');
    return;
  }

  doneList.innerHTML='';
  done.forEach(t=>doneList.appendChild(renderTask(t)));
  const isOpen=wrap.classList.contains('open');
  wrap.style.display=isOpen ? 'block' : 'none';
  toggle.textContent=isOpen ? 'hide' : 'show';
  toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function renderOpenList(){
  const open=sortOpenTasks(((_tasksCache||[])||[]).filter(t=>t.status==='open'));
  const shown=applyTaskFilter(open);

  taskCount.textContent=open.length;
  taskCount.classList.toggle('show',open.length>0);

  document.querySelectorAll('.filter-chip').forEach(c=>c.classList.toggle('active',c.dataset.filter===activeFilter));

  if(!shown.length){
    openList.innerHTML=activeFilter==='all'
      ?`<div class="empty">${EMPTY_OPEN_SVG}nothing open.<br>clean slate, go you 👏</div>`
      :`<div class="empty">nothing matches "${activeFilter}" right now.</div>`;
    return;
  }
  openList.innerHTML='';
  shown.forEach(t=>openList.appendChild(renderTask(t)));
}
async function loadTasks(){
  // Don't blow away an in-progress edit (e.g. task notes) with a background refresh.
  const activeEl=document.activeElement;
  if(activeEl&&activeEl.classList&&activeEl.classList.contains('task-notes-textarea'))return;
  // show skeleton on first load
  if (!openList.children.length || openList.querySelector('.empty')) {
    openList.innerHTML = [
      '<div class="skeleton skel-task" style="--shimmer-delay:0s"></div>',
      '<div class="skeleton skel-task-sm" style="--shimmer-delay:.18s"></div>',
      '<div class="skeleton skel-task" style="--shimmer-delay:.36s"></div>',
    ].join('');
  }
  try{
    const tasks=await fetchTimeout(API+'/api/tasks').then(r=>{if(!r.ok)throw new Error('tasks '+r.status);return r.json();});
    _tasksCache=tasks;
    checkReminders();
    checkAlarms();
    renderOpenList();
    renderDoneHistory();
  }catch{
    openList.innerHTML='<div class="empty">couldn\'t load — check your connection. <button type="button" onclick="loadTasks()" style="text-decoration:underline;background:none;border:none;color:inherit;cursor:pointer">retry</button></div>';
  }
}
document.querySelectorAll('.filter-chip').forEach(chip=>{
  chip.addEventListener('click',()=>{
    activeFilter=chip.dataset.filter;
    renderOpenList();
  });
});

const doneHistoryToggle=document.getElementById('doneHistoryToggle');
const doneHistoryWrap=document.getElementById('doneHistoryWrap');
doneHistoryToggle?.addEventListener('click',()=>{
  if(!doneHistoryWrap) return;
  const open=doneHistoryWrap.classList.toggle('open');
  doneHistoryWrap.style.display=open ? 'block' : 'none';
  doneHistoryToggle.textContent=open ? 'hide' : 'show';
  doneHistoryToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
});

/* ── Pull-to-refresh (all tabs) ─────────────────────────────────────────── */
(function(){
  // What to reload per tab
  const TAB_REFRESH = {
    tasks:    () => Promise.all([loadTasks(), loadMomentum(), loadHeatmap(), loadBrief(), refreshBriefMoney()]),
    finance:  () => loadFinance(),
    calendar: () => { window.CorePACalendar?.refresh(); return Promise.resolve(); },
    chat:     () => loadChatContext(),
    profile:  () => loadProfile(),
  };

  const THRESH   = 72;   // px of drag needed to trigger
  const MAX_DRAG = 110;  // max visual pull distance
  const MIN_SHOW = 18;   // px before the pill appears

  const overlay  = document.getElementById('ptrOverlay');
  const arc      = document.getElementById('ptrArc');
  const label    = document.getElementById('ptrLabel');
  const ARC_FULL = 56.5; // 2π×9

  let startY = 0, dragY = 0, pulling = false, refreshing = false, pointerId = null;

  function activeTab() {
    return document.querySelector('.nav-item.active')?.dataset.tab || 'tasks';
  }
  function setProgress(ratio) {
    // ratio 0→1 fills the arc
    const offset = ARC_FULL * (1 - Math.min(ratio, 1));
    if (arc) arc.style.strokeDashoffset = offset;
  }
  function showOverlay(dragPx) {
    const capped = Math.min(dragPx, MAX_DRAG);
    const ratio  = capped / THRESH;
    // Slide overlay down as finger moves
    overlay.classList.add('pulling');
    overlay.style.transform = 	ranslateY(px);
    if (capped > MIN_SHOW) {
      overlay.classList.add('visible');
    } else {
      overlay.classList.remove('visible');
    }
    overlay.classList.toggle('ready', ratio >= 1);
    setProgress(ratio);
    if (label) label.textContent = ratio >= 1 ? 'release to refresh' : 'pull to refresh';
  }
  function resetOverlay() {
    overlay.classList.remove('pulling', 'ready');
    overlay.style.transform = '';
    overlay.classList.add('visible'); // keep visible during spin
  }
  function hideOverlay() {
    overlay.classList.remove('visible', 'spinning', 'ready', 'pulling');
    overlay.style.transform = '';
    setProgress(0);
    if (label) label.textContent = 'pull to refresh';
  }

  // Listen on document rather than per-panel so we catch fast swipes
  document.addEventListener('pointerdown', e => {
    if (refreshing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (window.scrollY > 4) return;
    // Only fire when at the top of the page
    const tab = activeTab();
    if (!TAB_REFRESH[tab]) return;
    // Don't hijack scroll inside a scrollable inner container
    const el = e.target;
    if (el.closest('.chat-log, .task-ai-thread, .fin-scroll, .cal-scroll')) return;
    pointerId = e.pointerId;
    startY = e.clientY;
    dragY = 0;
    pulling = true;
  }, { passive: true });

  document.addEventListener('pointermove', e => {
    if (!pulling || e.pointerId !== pointerId) return;
    dragY = e.clientY - startY;
    if (dragY <= 0) { hideOverlay(); return; }
    if (window.scrollY > 4) { pulling = false; hideOverlay(); return; }
    showOverlay(dragY);
  }, { passive: true });

  function endPull(e) {
    if (!pulling || (e && e.pointerId !== pointerId)) return;
    pulling = false;
    if (dragY >= THRESH) {
      resetOverlay();
      overlay.classList.add('spinning');
      if (label) label.textContent = 'refreshing…';
      haptic(8);
      refreshing = true;
      const tab = activeTab();
      (TAB_REFRESH[tab] ? TAB_REFRESH[tab]() : Promise.resolve())
        .finally(() => {
          refreshing = false;
          // Brief "done" moment before hiding
          if (label) label.textContent = '✓ done';
          setTimeout(hideOverlay, 600);
        });
    } else {
      hideOverlay();
    }
  }

  document.addEventListener('pointerup', endPull);
  document.addEventListener('pointercancel', endPull);
})();

function popBurst(x,y){
  const n=8;
  for(let i=0;i<n;i++){
    const p=document.createElement('div');
    p.className='pop-particle';
    const angle=(Math.PI*2*i/n)+(Math.random()*.4-.2);
    const dist=26+Math.random()*18;
    p.style.setProperty('--px',Math.cos(angle)*dist+'px');
    p.style.setProperty('--py',Math.sin(angle)*dist+'px');
    p.style.left=x+'px';p.style.top=y+'px';
    document.body.appendChild(p);
    setTimeout(()=>p.remove(),600);
  }
}
function celebrate(msg){
  const n=20;
  for(let i=0;i<n;i++){
    const p=document.createElement('div');
    p.className='pop-particle';
    const angle=Math.random()*Math.PI*2;
    const dist=60+Math.random()*120;
    p.style.setProperty('--px',Math.cos(angle)*dist+'px');
    p.style.setProperty('--py',Math.sin(angle)*dist+'px');
    p.style.left=(window.innerWidth/2)+'px';
    p.style.top='120px';
    p.style.animationDuration='.9s';
    document.body.appendChild(p);
    setTimeout(()=>p.remove(),950);
  }
  toast(msg);
}
async function checkMilestones(){
  try{
    const ctx=await fetch(API+'/api/context').then(r=>r.json());
    const todayKey=new Date().toISOString().slice(0,10);
    if(ctx.openCount===0&&localStorage.getItem('celebrated_clear')!==todayKey){
      localStorage.setItem('celebrated_clear',todayKey);
      celebrate('everything cleared today ✨');
    }else if(ctx.streakDays>0&&ctx.streakDays%7===0){
      const key=`${todayKey}-${ctx.streakDays}`;
      if(localStorage.getItem('celebrated_streak')!==key){
        localStorage.setItem('celebrated_streak',key);
        celebrate(`${ctx.streakDays}-day streak 🔥`);
      }
    }
    loadMomentum();
  }catch{}
}
function renderTask(t){
  const el=document.createElement('div');
  el.className=`task priority-${t.priority} ${t.status==='done'?'done':''}`;
  el.dataset.id=t.id;
  const badges=[];
  if(t.priority==='high')badges.push(`<span class="badge badge-high">high</span>`);
  if(t.recurring)        badges.push(`<span class="badge badge-recurring">↻ ${t.recurring}</span>`);
  const meta=[];
  if(t.remind_at&&t.status==='open')meta.push(`<span class="badge-remind">⏰ ${fmtRemind(t.remind_at)}</span>`);
  if(t.start_at&&t.status==='open')meta.push(`<span class="badge-remind">▶ ${fmtRemind(t.start_at)}</span>`);
  if(t.due_at&&t.status==='open')meta.push(`<span class="badge-remind">⏳ ${fmtRemind(t.due_at)}</span>`);
  const hasMeta=badges.length||meta.length;
  const hasNotes=!!(t.notes&&t.notes.trim());

  el.innerHTML=`
    <div class="task-main">
      <div class="task-select-check" role="checkbox" aria-label="select task" aria-checked="false"></div>
      <div class="check ${t.status==='done'?'done':''}" role="checkbox" aria-checked="${t.status==='done'}" tabindex="0"></div>
      <div class="task-body">
        <div class="task-title">${esc(t.title)}</div>
        ${hasMeta?`<div class="task-meta">
          ${badges.join('')}${badges.length&&meta.length?'<span style="opacity:.3">·</span>':''}
          ${meta.join('<span style="opacity:.3">·</span>')}
        </div>`:''}
      </div>
      <div class="task-actions">
        <button class="task-action-btn ${hasNotes?'has-notes':''}" data-action="note" aria-label="note" title="${hasNotes?'notes':'add note'}">
          <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="task-action-btn" data-action="focus" aria-label="focus mode" title="open in focus mode">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>
        </button>
        <button class="task-action-btn danger" data-action="delete" aria-label="delete">
          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    </div>
    <div class="task-notes-area ${hasNotes?'open':''}">
      ${hasNotes?`<div class="task-notes-text">${esc(t.notes)}</div>`:''}
      <textarea class="task-notes-textarea" placeholder="add context, links, anything useful…">${esc(t.notes||'')}</textarea>
      <div class="task-notes-actions">
        <button class="notes-cancel-btn">cancel</button>
        <button class="notes-save-btn">save</button>
      </div>
    </div>`;

  const check=el.querySelector('.check');
  const doToggle=async()=>{
    const ns=t.status==='open'?'done':'open';
    if(ns==='done'){
      toast('✓ done');
      const r=check.getBoundingClientRect();
      popBurst(r.left+r.width/2,r.top+r.height/2);
      playChime(t.priority==='high');
      haptic(10);
    }
    await fetch(`${API}/api/tasks/${t.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:ns,touch:true})});
    loadTasks();
    if(ns==='done')checkMilestones();
  };
  check.addEventListener('click', () => {
    // Spring pop: shrink then overshoot then settle
    let cancel;
    cancel = springAnimate({ from: 1, to: 0.72, stiffness: 600, damping: 18, onUpdate: s => { check.style.transform = `scale(${s})`; }, onDone: () => {
      cancel = springAnimate({ from: 0.72, to: 1, stiffness: 340, damping: 16, onUpdate: s => { check.style.transform = `scale(${s})`; }, onDone: () => { check.style.transform = ''; } });
    }});
    doToggle();
  });
  check.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')doToggle();});

  const doDelete=()=>{
    if(t.status==='done'){
      toast('completed tasks stay in your history');
      return;
    }
    haptic(14);
    // Measure card height before collapsing
    const h = el.offsetHeight + 9; // 9 = margin-bottom
    el.style.overflow = 'hidden';
    let undone = false;
    springAnimate({ from: 1, to: 0, stiffness: 480, damping: 32, onUpdate: s => {
      el.style.transform = `scale(${0.92 + s * 0.08}) translateX(${(1-s)*18}px)`;
      el.style.opacity = String(s);
    }, onDone: () => {
      if (undone) return;
      el.style.transition = 'max-height .22s cubic-bezier(.4,0,.2,1), margin .22s';
      el.style.maxHeight = h + 'px';
      requestAnimationFrame(() => { el.style.maxHeight = '0'; el.style.marginBottom = '0'; });
      setTimeout(() => { if (!undone) el.style.display = 'none'; }, 230);
    }});
    const del=setTimeout(async()=>{if(undone)return;await fetch(`${API}/api/tasks/${t.id}`,{method:'DELETE'});loadTasks();},4500);
    toast(`deleted "${t.title}"`,()=>{undone=true;el.style.cssText='';el.style.display='';clearTimeout(del);});
  };
  window.CorePATaskAI?.decorate(el,t);
  const deleteBtn=el.querySelector('[data-action="delete"]');
  if(t.status==='done'){
    deleteBtn?.setAttribute('disabled','true');
    deleteBtn?.setAttribute('aria-label','task history is kept');
    deleteBtn?.addEventListener('click',()=>toast('completed tasks stay in your history'));
  } else {
    deleteBtn?.addEventListener('click',doDelete);
  }
  el.querySelector('[data-action="focus"]').addEventListener('click',()=>openFocusForTask(t.id));

  // swipe-to-complete (right) / swipe-to-delete (left), touch only
  const taskMain=el.querySelector('.task-main');
  let swX=0,swDX=0,swiping=false,swFired=false;
  taskMain.addEventListener('touchstart',e=>{
    if(e.touches.length!==1)return;
    swX=e.touches[0].clientX;swDX=0;swiping=true;swFired=false;
    taskMain.style.transition='none';
  },{passive:true});
  taskMain.addEventListener('touchmove',e=>{
    if(!swiping)return;
    swDX=e.touches[0].clientX-swX;
    taskMain.style.transform=`translateX(${swDX}px)`;
    el.style.background=swDX>0?'rgba(var(--pink-rgb),.14)':swDX<0?'rgba(255,70,70,.14)':'';
    el.setAttribute('data-swipe-dir',swDX>20?'right':swDX<-20?'left':'');
    el.setAttribute('data-swipe-label',swDX>20?(t.status==='open'?'complete':''):swDX<-20?'delete':'');
    if(!swFired&&Math.abs(swDX)>76){swFired=true;haptic(6);}
  },{passive:true});
  taskMain.addEventListener('touchend',()=>{
    if(!swiping)return;swiping=false;
    const THRESH=76;
    const W = window.innerWidth;
    if (swDX > THRESH && t.status === 'open') {
      springAnimate({ from: swDX, to: W * 1.2, stiffness: 260, damping: 22, onUpdate: x => { taskMain.style.transform = `translateX(${x}px)`; }});
      doToggle();
    } else if (swDX < -THRESH) {
      springAnimate({ from: swDX, to: -W * 1.2, stiffness: 260, damping: 22, onUpdate: x => { taskMain.style.transform = `translateX(${x}px)`; }});
      doDelete();
    } else {
      springAnimate({ from: swDX, to: 0, stiffness: 380, damping: 28, onUpdate: x => { taskMain.style.transform = `translateX(${x}px)`; }, onDone: () => { taskMain.style.transform = ''; } });
      el.style.background = '';
      el.removeAttribute('data-swipe-dir');
      el.removeAttribute('data-swipe-label');
    }
  });

  // Select mode: tap task-main to toggle selection
  taskMain.addEventListener('click', e => {
    if (!_selectMode) return;
    e.stopPropagation();
    const isSelected = el.classList.toggle('selected');
    const check = el.querySelector('.task-select-check');
    if (check) check.setAttribute('aria-checked', String(isSelected));
    if (isSelected) _selectedIds.add(t.id); else _selectedIds.delete(t.id);
    if (_selectedIds.size === 0) exitSelectMode();
    else _updateBulkBar();
  });

  // Long-press (500ms) on task-main to enter select mode
  let _lpTimer = null;
  taskMain.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    _lpTimer = setTimeout(() => {
      haptic(18);
      enterSelectMode(t.status === 'open' ? t.id : null);
      el.classList.add('selected');
      const check = el.querySelector('.task-select-check');
      if (check) check.setAttribute('aria-checked', 'true');
      _updateBulkBar();
    }, 500);
  });
  taskMain.addEventListener('pointerup',   () => clearTimeout(_lpTimer));
  taskMain.addEventListener('pointerleave',() => clearTimeout(_lpTimer));
  taskMain.addEventListener('pointermove', () => clearTimeout(_lpTimer));

  const noteBtn=el.querySelector('[data-action="note"]');
  const notesArea=el.querySelector('.task-notes-area');
  const notesText=el.querySelector('.task-notes-text');
  const notesTA=el.querySelector('.task-notes-textarea');
  const notesActs=el.querySelector('.task-notes-actions');

  function openEdit(){
    if(notesText)notesText.style.display='none';
    notesTA.style.display='block';notesActs.style.display='flex';
    notesTA.focus();autoGrow(notesTA);
    notesTA.addEventListener('input',()=>autoGrow(notesTA));
  }
  noteBtn.addEventListener('click',()=>{
    if(!notesArea.classList.contains('open')){notesArea.classList.add('open');if(!hasNotes)openEdit();}
    else openEdit();
  });
  if(notesText)notesText.addEventListener('click',openEdit);
  el.querySelector('.notes-cancel-btn').addEventListener('click',()=>{
    notesTA.style.display='none';notesActs.style.display='none';
    if(notesText)notesText.style.display='block';
    if(!hasNotes)notesArea.classList.remove('open');
  });
  el.querySelector('.notes-save-btn').addEventListener('click',async()=>{
    await fetch(`${API}/api/tasks/${t.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:notesTA.value.trim()||null})});
    toast('note saved');loadTasks();
  });
  return el;
}

async function addTask(){
  const title=input.value.trim();if(!title)return;
  sendBtn.disabled=true;
  const notesVal = document.getElementById('notesInput')?.value?.trim()||null;
  const payload={
    title,
    notes: notesVal,
    priority: sheetPriority,
    stale_minutes: sheetNudgeMins,
    recurring: sheetRecurring||null,
    remind_at: sheetRemindAt||null,
  };
  await fetch(API+'/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  input.value='';
  input.style.height='auto';
  // reset sheet state
  sheetRemindAt=null; sheetPriority='normal'; sheetRecurring=''; sheetNudgeMins=4320;
  document.getElementById('remindAt').value='';
  document.getElementById('notesInput').value='';
  document.getElementById('nudgeNum').value='3';
  document.getElementById('nudgeUnit').value='days';
  document.querySelectorAll('[data-priority]').forEach(c=>c.classList.toggle('active',c.dataset.priority==='normal'));
  document.querySelectorAll('[data-recurring]').forEach(c=>c.classList.toggle('active',c.dataset.recurring===''));
  document.getElementById('reminderChip').classList.remove('on');
  document.getElementById('reminderChipLabel').textContent='remind';
  document.getElementById('optionsChip').classList.remove('on');
  sendBtn.disabled=false;
  toast('task added');
  loadTasks();
}
// Core panel on the tasks tab: hide it into a pill, reopen it, or clear it.
// A chat stays reopenable for TASK_AI_KEEP_MS after its last message, then clears itself.
const TASK_AI_KEEP_MS=30*60*1000;
let taskAiExpiry=null;
function taskAiSync(){
  const dock=document.getElementById('taskAiDock'),thread=document.getElementById('taskAiThread'),count=document.getElementById('taskAiCount');
  if(!dock||!thread)return;
  dock.hidden=thread.children.length===0;
  if(count)count.textContent=thread.children.length;
}
function taskAiTouch(){
  document.getElementById('taskAiDock')?.classList.remove('min');
  taskAiSync();
  clearTimeout(taskAiExpiry);
  taskAiExpiry=setTimeout(taskAiClear,TASK_AI_KEEP_MS);
}
function taskAiClear(){
  clearTimeout(taskAiExpiry);
  document.getElementById('taskAiThread')?.replaceChildren();
  taskAiSync();
}
document.getElementById('taskAiMin')?.addEventListener('click',()=>document.getElementById('taskAiDock').classList.add('min'));
document.getElementById('taskAiClose')?.addEventListener('click',taskAiClear);
document.getElementById('taskAiPill')?.addEventListener('click',()=>{
  document.getElementById('taskAiDock').classList.remove('min');
  const t=document.getElementById('taskAiThread');t.scrollTop=t.scrollHeight;
});
function taskAiBubble(role,text){
  const thread=document.getElementById('taskAiThread');
  const el=document.createElement('div');
  el.className='task-ai-msg '+role;
  el.textContent=text;
  thread.appendChild(el);
  // A small section, not a second chat log — the real history lives on the
  // Chat tab. Cap to the last 3 exchanges (6 bubbles) here.
  while(thread.children.length>6)thread.removeChild(thread.firstChild);
  thread.scrollTop=thread.scrollHeight;
  taskAiTouch();
}
async function sendTaskAI(){
  const text=input.value.trim();if(!text)return;
  sendBtn.disabled=true;
  input.value='';input.style.height='auto';
  taskAiBubble('user',text);
  try{
    const res=await fetch(API+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text})});
    const data=await res.json();
    if(res.status===503){taskAiBubble('ai error','no AI provider configured — switch to manual mode for now');}
    else if(!res.ok){taskAiBubble('ai error',data.error||'could not process that — try again');}
    else{
      taskAiBubble('ai',data.reply?cleanAssistantReply(data.reply):'done');
    }
    // Always resync from the server, not just when tasksChanged says to —
    // if the model's response didn't parse cleanly, that flag can read
    // false even when something should have happened. This keeps what's
    // on screen honest no matter what.
    loadTasks();
  }catch{taskAiBubble('ai error','connection error — try again');}
  sendBtn.disabled=false;
}
function handleTaskSend(){
  if(taskInputMode==='ai')sendTaskAI();
  else addTask();
}
sendBtn?.addEventListener('click',handleTaskSend);
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();handleTaskSend();}});

/* ── Finance ──────────────────────────────────────────────────────────────── */
const finIncomeEl=document.getElementById('finIncome'),finExpenseEl=document.getElementById('finExpense'),finNetEl=document.getElementById('finNet');
const finList=document.getElementById('finList'),catBreakdown=document.getElementById('catBreakdown'),finEntriesLabel=document.getElementById('finEntriesLabel');
const finLoadMoreBtn=document.getElementById('finLoadMoreBtn');
let finVisibleEntries=[];
let finRawEntries=[];
let finRenderedCount=0;
const FIN_PAGE_SIZE=15;
const finSortSelect=document.getElementById('finSortSelect');
function applyFinSort(){
  const mode=finSortSelect?.value||'recent';
  const sorted=[...finRawEntries];
  const dateOf=e=>new Date(e.imported_date?e.imported_date+'T00:00:00':e.created_at).getTime();
  if(mode==='oldest')sorted.sort((a,b)=>dateOf(a)-dateOf(b));
  else if(mode==='amount-desc')sorted.sort((a,b)=>parseFloat(b.amount)-parseFloat(a.amount));
  else if(mode==='amount-asc')sorted.sort((a,b)=>parseFloat(a.amount)-parseFloat(b.amount));
  else if(mode==='category')sorted.sort((a,b)=>(a.category||'').localeCompare(b.category||''));
  else sorted.sort((a,b)=>dateOf(b)-dateOf(a));
  finVisibleEntries=sorted;
  finRenderedCount=0;
  finList.innerHTML='';
  renderMoreFinEntries();
}
finSortSelect?.addEventListener('change',applyFinSort);
function renderMoreFinEntries(){
  const next=finVisibleEntries.slice(finRenderedCount,finRenderedCount+FIN_PAGE_SIZE);
  next.forEach(e=>finList.appendChild(renderFinEntry(e)));
  finRenderedCount+=next.length;
  const remaining=finVisibleEntries.length-finRenderedCount;
  if(finLoadMoreBtn){
    finLoadMoreBtn.style.display=remaining>0?'block':'none';
    finLoadMoreBtn.textContent=remaining>0?`load ${Math.min(remaining,FIN_PAGE_SIZE)} more (${remaining} left) →`:'';
  }
}
finLoadMoreBtn?.addEventListener('click',renderMoreFinEntries);
const clearFinanceBtn=document.getElementById('clearFinanceBtn');
const pendingFinDeletes=new Set(); // ids faded out client-side but not yet confirmed deleted server-side

// Keep old refs alive so existing code doesn't crash
const typeExpenseBtn=document.getElementById('typeExpense')||{className:'',addEventListener:()=>{}};
const typeIncomeBtn=document.getElementById('typeIncome')||{className:'',addEventListener:()=>{}};
const finAmount=document.getElementById('finAmount')||{value:'',focus:()=>{}};
const finCategory=document.getElementById('finCategory')||{value:'general'};
const finNote=document.getElementById('finNote')||{value:'',trim:()=>''};
const finAddBtn=document.getElementById('finAddBtn')||{disabled:false,addEventListener:()=>{}};

// ── Spring physics engine ─────────────────────────────────────────────────────
// Drives any value from `from` to `to` with configurable stiffness/damping.
// onUpdate(value) called every rAF frame; returns a cancel function.
// Typical presets: { stiffness:380, damping:28 } = snappy; { stiffness:200, damping:20 } = bouncy
function springAnimate({ from, to, stiffness = 320, damping = 26, mass = 1, onUpdate, onDone }) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onUpdate(to); onDone?.(); return () => {}; }
  let pos = from, vel = 0, rafId;
  const loop = () => {
    const f = -stiffness * (pos - to) - damping * vel;
    vel += (f / mass) * (1 / 60);
    pos += vel;
    onUpdate(pos);
    if (Math.abs(pos - to) < 0.01 && Math.abs(vel) < 0.01) {
      onUpdate(to);
      onDone?.();
      return;
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(rafId);
}

// ── New floating log bar ──────────────────────────────────────────────────
let _finLogType='expense';
let _finLogCat='general';
const finLogBar=document.getElementById('finLogBar');
const finLogAmount=document.getElementById('finLogAmount');
const finLogNote=document.getElementById('finLogNote');
const finLogSend=document.getElementById('finLogSend');
const finLogTypeExp=document.getElementById('finLogTypeExp');
const finLogTypeInc=document.getElementById('finLogTypeInc');

finLogTypeExp?.addEventListener('click',()=>{
  _finLogType='expense';
  finLogTypeExp.className='fin-type-btn active-expense';
  finLogTypeInc.className='fin-type-btn';
});
finLogTypeInc?.addEventListener('click',()=>{
  _finLogType='income';
  finLogTypeInc.className='fin-type-btn active-income';
  finLogTypeExp.className='fin-type-btn';
});

document.getElementById('finLogCats')?.addEventListener('click',e=>{
  const chip=e.target.closest('.fin-cat-chip');
  if(!chip)return;
  _finLogCat=chip.dataset.cat;
  document.querySelectorAll('.fin-cat-chip').forEach(c=>c.classList.toggle('active',c===chip));
});

async function addFinEntryNew(){
  const amount=parseFloat(finLogAmount?.value);
  if(!amount||amount<=0){finLogAmount?.focus();return;}
  if(finLogSend)finLogSend.disabled=true;
  await fetch(API+'/api/finance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    type:_finLogType,amount,category:_finLogCat,note:finLogNote?.value?.trim()||null
  })});
  if(finLogAmount)finLogAmount.value='';
  if(finLogNote)finLogNote.value='';
  if(finLogSend)finLogSend.disabled=false;
  toast(`${_finLogType} logged — R${amount.toFixed(2)}`);
  loadFinance();
}
finLogSend?.addEventListener('click',addFinEntryNew);
finLogAmount?.addEventListener('keydown',e=>{if(e.key==='Enter')addFinEntryNew();});
finLogNote?.addEventListener('keydown',e=>{if(e.key==='Enter')addFinEntryNew();});

// ── Bank pill chips ───────────────────────────────────────────────────────
document.getElementById('bankChips')?.addEventListener('click',e=>{
  const chip=e.target.closest('.bank-chip');
  if(!chip)return;
  const bank=chip.dataset.bank;
  document.querySelectorAll('.bank-chip').forEach(c=>c.classList.toggle('active',c===chip));
  applyBankTheme(bank);
  fetch(API+'/api/finance/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bank})});
});

const BANK_THEMES={capitec:{label:'Capitec',cls:'capitec',sub:'globalone'},fnb:{label:'FNB',cls:'fnb',sub:'easy account'},standardbank:{label:'Standard Bank',cls:'standardbank',sub:'myMobiMoney'},nedbank:{label:'Nedbank',cls:'nedbank',sub:'savvy account'},absa:{label:'Absa',cls:'absa',sub:'transact account'}};
const bankCard=document.getElementById('bankCard'),cardBankName=document.getElementById('cardBankName'),cardSub=document.getElementById('cardSub'),cardMid=document.getElementById('cardMid'),cardHolder=document.getElementById('cardHolder'),cardNetVal=document.getElementById('cardNetVal'),cardLastImport=document.getElementById('cardLastImport'),bankSelect=document.getElementById('bankSelect');
let currentStatementName='';

function applyBankTheme(b){const th=BANK_THEMES[b]||BANK_THEMES.capitec;bankCard.className=`bank-card ${th.cls}`;if(typeof bankBack!=='undefined')bankBack.className=`bank-card bank-card-back ${th.cls}`;cardBankName.textContent=th.label;if(cardSub)cardSub.textContent=th.sub||'';bankSelect.value=b;}
cardMid.textContent='';
cardMid.style.display='none';
function applyCardHolder(name){
  currentStatementName=name||'';
  cardHolder.textContent=currentStatementName?currentStatementName.toUpperCase():'TAP TO ADD NAME';
}
async function editCardName(){
  const input=(prompt('name as it appears on your bank statement:',currentStatementName)||'').trim().slice(0,40);
  if(!input)return;
  applyCardHolder(input);
  try{await fetch(API+'/api/finance/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({statement_name:input})});}
  catch{toast('could not save — try again');}
}
const bankFlip=document.getElementById('bankFlip'),bankBack=document.getElementById('bankBack'),bankCardWrap=document.getElementById('bankCardWrap'),
  cardBackNet=document.getElementById('cardBackNet'),cardBackIn=document.getElementById('cardBackIn'),cardBackOut=document.getElementById('cardBackOut');
function countUpNet(el,target){
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){el.textContent=fmtNet(target);return;}
  const t0=performance.now(),dur=900;
  (function f(now){
    const k=Math.min(1,(now-t0)/dur),e=1-Math.pow(1-k,3);
    el.textContent=fmtNet(target*e);
    if(k<1&&bankFlip.classList.contains('flipped'))requestAnimationFrame(f);else el.textContent=fmtNet(target);
  })(t0);
}
function toggleBankFlip(){
  const on=bankFlip.classList.toggle('flipped');
  bankFlip.setAttribute('aria-pressed',on);
  bankCardWrap.classList.remove('lift');void bankCardWrap.offsetWidth;bankCardWrap.classList.add('lift');
  if(on&&typeof window._monthNet==='number')setTimeout(()=>countUpNet(cardBackNet,window._monthNet),260);
}
bankFlip.addEventListener('click',toggleBankFlip);
bankFlip.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target===bankFlip){e.preventDefault();toggleBankFlip();}});
cardHolder.addEventListener('click',e=>{e.stopPropagation();editCardName();});
document.getElementById('cardEditName').addEventListener('click',e=>{e.stopPropagation();editCardName();});
function requestLocationOnce(){
  if(!navigator.geolocation)return;
  if(localStorage.getItem('locationDeclined')==='1')return;
  if(localStorage.getItem('locationSavedAt'))return; // already have it — refresh happens server-side, no need to re-ask
  navigator.geolocation.getCurrentPosition(
    async pos=>{
      try{
        await fetch(API+'/api/location',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lat:pos.coords.latitude,lon:pos.coords.longitude})});
        localStorage.removeItem('locationDeclined');
        localStorage.setItem('locationSavedAt',Date.now().toString());
        loadBriefingWeather();
      }catch{}
    },
    ()=>{ localStorage.setItem('locationDeclined','1'); },
    {timeout:8000}
  );
}
requestLocationOnce();

async function loadBankSettings(){
  try{
    const s=await fetch(API+'/api/finance/settings').then(r=>r.json());
    if(s.bank){
      applyBankTheme(s.bank);
      // sync pill chips
      document.querySelectorAll('.bank-chip').forEach(c=>c.classList.toggle('active',c.dataset.bank===s.bank));
    }
    applyCardHolder(s.statement_name);
    if(s.last_imported)cardLastImport.textContent=new Date(s.last_imported).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  }catch{}
}
// bank select now driven by pill chips; hidden select kept for compat only

const importZone=document.getElementById('importZone');
const importDockEl=document.getElementById('importDock');
const statementFile=document.getElementById('statementFile');
const importProgress=document.getElementById('importProgress'),importPreview=document.getElementById('importPreview');
const previewCount=document.getElementById('previewCount'),previewRows=document.getElementById('previewRows'),previewConfidence=document.getElementById('previewConfidence');
const importConfirmBtn=document.getElementById('importConfirmBtn'),importCancelBtn=document.getElementById('importCancelBtn');
let pendingTx=[];
let pendingPeriod=null;   // {from, to} from the parsed statement
let pendingReplaceCount=0; // existing entries in that period
// grows as AI-proposed categories (from finance-import's batch categoriser)
// show up in real data — the two <select> builders below always include
// whatever the entry's actual category is, even if it's not one of the six
// defaults, so a custom category never silently falls back to "food" in the UI.
const CATS=['food','transport','bills','subscriptions','entertainment','personal','transfers','income','general'];
let knownCategories=new Set(CATS);
function catOptionsFor(selected){
  const set=new Set(knownCategories);
  if(selected)set.add(selected);
  return [...set].map(c=>`<option value="${esc(c)}" ${c===selected?'selected':''}>${esc(c)}</option>`).join('');
}
// Drag-over on the new dock
if(importDockEl){
  importDockEl.addEventListener('dragover',e=>{e.preventDefault();importDockEl.classList.add('drag-over');});
  importDockEl.addEventListener('dragleave',()=>importDockEl.classList.remove('drag-over'));
  importDockEl.addEventListener('drop',e=>{e.preventDefault();importDockEl.classList.remove('drag-over');const f=e.dataTransfer.files[0];if(f)handleImport(f);});
}
statementFile.addEventListener('change',()=>{if(statementFile.files[0])handleImport(statementFile.files[0]);});

async function handleImport(file){
  if(!file.name.match(/\.(csv|pdf)$/i)){toast('CSV or PDF only');return;}
  importProgress.classList.add('show');importPreview.classList.remove('show');if(importDockEl)importDockEl.style.display='none';
  const fd=new FormData();fd.append('statement',file);
  try{
    const res=await fetch(API+'/api/finance/import/preview',{method:'POST',body:fd});
    const data=await res.json();
    importProgress.classList.remove('show');
    if(!res.ok){if(importDockEl)importDockEl.style.display='flex';toast(`parse failed: ${data.error}`);return;}
    pendingPeriod=data.period||null;
    pendingReplaceCount=data.replaceCount||0;
    pendingTx=data.transactions;renderPreview(data);
    if(data.bank&&BANK_THEMES[data.bank]){applyBankTheme(data.bank);document.querySelectorAll('.bank-chip').forEach(c=>c.classList.toggle('active',c.dataset.bank===data.bank));fetch(API+'/api/finance/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bank:data.bank})}).catch(()=>{});}
    if(data.warnings&&data.warnings.length)toast(data.warnings[0]);
    else if(data.reconciled)toast('✓ totals match your statement');
  }catch{importProgress.classList.remove('show');if(importDockEl)importDockEl.style.display='flex';toast('upload error');}
}
function renderConfidenceStrip(stats){
  if(!stats)return '';
  const confident=(stats.learned||0)+(stats.seed||0)+(stats.bank||0)+(stats.ai||0);
  const fallback=stats.fallback||0;
  const total=confident+fallback;
  if(!total)return '';
  let html=`<b>${confident}/${total}</b> categorised automatically`;
  if(fallback>0)html+=` · <span class="flag">${fallback} need${fallback===1?'s':''} a look</span>`;
  return html;
}
function renderPreview(data){
  const{transactions,totalParsed,duplicatesSkipped,categorisation,replaceCount}=data;
  pendingTx=transactions.map((t,i)=>({...t,_pid:i}));
  pendingTx.forEach(t=>{if(t.category)knownCategories.add(t.category);});
  let c=`${pendingTx.length} transaction${pendingTx.length===1?'':'s'}`;
  if(duplicatesSkipped>0)c+=` · ${duplicatesSkipped} dupes skipped`;
  // If there are existing entries in this period, show replace context
  const rc=replaceCount||pendingReplaceCount||0;
  if(rc>0)c+=` · replaces ${rc} existing`;
  previewCount.textContent=c;
  previewConfidence.innerHTML=renderConfidenceStrip(categorisation);
  // Button label: replace mode when there's overlap, add mode otherwise
  importConfirmBtn.textContent=rc>0?`replace & import`:'import all';
  importConfirmBtn.title=rc>0?`removes ${rc} existing entries in this statement's date range, then adds ${pendingTx.length} from the statement`:'';
  previewRows.innerHTML='';
  pendingTx.forEach(t=>{
    const row=document.createElement('div');row.className='preview-row';
    const opts=catOptionsFor(t.category);
    const sign=t.type==='income'?'+':'−';
    const uncertain=(!t.source||t.source==='fallback')?'<span class="preview-uncertain" title="not sure about this one — check the category"></span>':'';
    row.innerHTML=`<span class="preview-date">${t.importedDate||''}</span><span class="preview-desc" title="${esc(t.description||t.merchant||'')}">${uncertain}${esc(t.description||t.merchant||'')}</span><span class="preview-amount ${t.type}">${sign}R${parseFloat(t.amount).toFixed(2)}</span><span class="preview-cat"><select>${opts}</select></span><button class="preview-remove">×</button>`;
    row.querySelector('select').addEventListener('change',e=>{const tx=pendingTx.find(x=>x._pid===t._pid);if(tx)tx.category=e.target.value;});
    row.querySelector('.preview-remove').addEventListener('click',()=>{
      pendingTx=pendingTx.filter(x=>x._pid!==t._pid);
      row.remove();
      previewCount.textContent=`${pendingTx.length} transaction${pendingTx.length===1?'':'s'}`;
      if(!pendingTx.length)resetImport();
    });
    previewRows.appendChild(row);
  });
  importPreview.classList.add('show');
}
importConfirmBtn.addEventListener('click',async()=>{
  if(!pendingTx.length)return;
  const useReplace=pendingReplaceCount>0&&pendingPeriod;
  importConfirmBtn.disabled=true;
  importConfirmBtn.textContent=useReplace?'replacing…':'importing…';
  try{
    const body={transactions:pendingTx};
    if(useReplace){body.replace=true;body.period=pendingPeriod;}
    const res=await fetch(API+'/api/finance/import/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await res.json();
    if(res.ok){
      await fetch(API+'/api/finance/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({last_imported:new Date().toISOString()})});
      cardLastImport.textContent=new Date().toLocaleDateString(undefined,{month:'short',day:'numeric'});
      const msg=data.replaced>0
        ?`✓ replaced ${data.replaced} entries with ${data.committed} from statement${data.insight?' — '+data.insight:''}`
        :`✓ ${data.committed} imported${data.insight?' — '+data.insight:''}`;
      toast(msg);
      resetImport();loadFinance();
      // Surface recurring charges detected after this import
      fetch(API+'/api/finance/recurring').then(r=>r.json()).then(d=>{
        if(d.recurring&&d.recurring.length){
          const top=d.recurring.slice(0,3).map(r=>`${r.merchant} R${r.amount.toFixed(0)}/mo`).join(', ');
          setTimeout(()=>toast(`↻ recurring detected: ${top}`),1800);
        }
      }).catch(()=>{});
    } else toast(`import failed: ${data.error}`);
  }catch(e){toast('import failed: '+(e.message||'try again'));}
  importConfirmBtn.disabled=false;
  importConfirmBtn.textContent=pendingReplaceCount>0?'replace & import':'import all';
});
importCancelBtn.addEventListener('click',resetImport);
function resetImport(){importPreview.classList.remove('show');if(importDockEl)importDockEl.style.display='flex';statementFile.value='';pendingTx=[];pendingPeriod=null;pendingReplaceCount=0;importConfirmBtn.textContent='import all';previewRows.innerHTML='';}

function renderTrendChart(trend){
  const wrap=document.getElementById('trendChartWrap');if(!wrap||!trend||!trend.length)return;
  const W=320,H=64,pad=4;
  const vals=trend.map(t=>t.net);
  const min=Math.min(0,...vals),max=Math.max(0,...vals,1);
  const range=(max-min)||1;
  const stepX=(W-pad*2)/(trend.length-1);
  const pts=vals.map((v,i)=>[pad+i*stepX, H-pad-((v-min)/range)*(H-pad*2)]);
  let path=`M${pts[0][0]},${pts[0][1]}`;
  for(let i=1;i<pts.length;i++){
    const[x0,y0]=pts[i-1],[x1,y1]=pts[i];
    const mx=(x0+x1)/2;
    path+=` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  const areaPath=`${path} L${pts[pts.length-1][0]},${H-pad} L${pts[0][0]},${H-pad} Z`;
  const zeroY=H-pad-((0-min)/range)*(H-pad*2);
  wrap.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:64px">
    <defs><linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--pink)" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="var(--pink)" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 3"/>
    <path d="${areaPath}" fill="url(#trendGrad)"/>
    <path d="${path}" fill="none" stroke="var(--pink)" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;
}
async function loadFinance(){
  try{
    const{entries,totals,byCategory,trend,prevTotals}=await fetch(API+'/api/finance').then(r=>r.json());
    renderTrendChart(trend);
    // Load recurring charges
    fetch(API+'/api/finance/recurring').then(r=>r.json()).then(d=>{
      const list=document.getElementById('recurringList');
      const label=document.getElementById('recurringLabel');
      if(!list||!label)return;
      if(!d.recurring||!d.recurring.length){label.style.display='none';list.innerHTML='';return;}
      label.style.display='';
      list.innerHTML=d.recurring.map(r=>`<div class="recurring-row"><div><div class="r-merchant">${esc(r.merchant)}</div><div class="r-meta">appears ${r.months} months</div></div><div class="r-amt">R${r.amount.toFixed(0)}/mo</div></div>`).join('');
    }).catch(()=>{});
    const income=totals.find(r=>r.type==='income')?.total||0,expense=totals.find(r=>r.type==='expense')?.total||0,net=income-expense;
    finIncomeEl.textContent=`R${income.toFixed(2)}`;finExpenseEl.textContent=`R${expense.toFixed(2)}`;
    // Hero net
    finNetEl.textContent=`${net>=0?'+':'−'}R${Math.abs(net).toFixed(2)}`;
    finNetEl.className=`fin-hero-amount ${net>=0?'positive':'negative'}`;
    // Month-over-month comparison
    const momEl=document.getElementById('finMoM');
    if(momEl&&prevTotals){
      const pInc=prevTotals.find(r=>r.type==='income')?.total||0;
      const pExp=prevTotals.find(r=>r.type==='expense')?.total||0;
      const pNet=pInc-pExp;
      if(pNet!==0){
        const diff=net-pNet, pct=Math.abs(diff/pNet*100).toFixed(0);
        const dir=diff>=0?'↑':'↓';
        const col=diff>=0?'var(--silver-warm)':'var(--pink)';
        momEl.innerHTML=`<span style="color:${col}">${dir}${pct}% vs last month</span>`;
        momEl.style.display='';
      } else { momEl.style.display='none'; }
    }
    cardNetVal.textContent=`${net>=0?'+':'−'}R${Math.abs(net).toFixed(0)}`;
    window._monthNet=net;
    if(typeof cardBackNet!=='undefined'){
      cardBackNet.textContent=fmtNet(net);cardBackNet.className=`back-net ${net>=0?'positive':'negative'}`;
      cardBackIn.textContent=`R${income.toFixed(0)}`;cardBackOut.textContent=`R${expense.toFixed(0)}`;
    }
    _ctxPromise=null;setBriefMoney(net);
    const expCats=byCategory.filter(r=>r.type==='expense'),maxAmt=expCats.reduce((m,c)=>Math.max(m,c.total),0);
    catBreakdown.innerHTML=expCats.length?expCats.map(c=>`<div class="cat-row"><span class="cat-name">${esc(c.category)}</span><div class="cat-bar-wrap"><div class="cat-bar" style="width:${maxAmt?(c.total/maxAmt*100).toFixed(1):0}%"></div></div><span class="cat-amt">R${c.total.toFixed(2)}</span></div>`).join(''):'<div class="empty" style="padding:20px 0">no spend logged this month.<br>living below the radar 🤙</div>';
    const visibleEntries=entries.filter(e=>!pendingFinDeletes.has(e.id));
    finEntriesLabel.style.display=visibleEntries.length?'flex':'none';
    finRawEntries=visibleEntries;
    applyFinSort();
    // budget "add" dropdown always reflects this month's actual categories
    const budgetAddCategory=document.getElementById('budgetAddCategory');
    const cats=[...new Set(byCategory.map(r=>r.category))];
    cats.forEach(c=>knownCategories.add(c));
    if(budgetAddCategory){
      budgetAddCategory.innerHTML=cats.length?cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join(''):'<option value="general">general</option>';
    }
  }catch{}
}

async function loadBudgets(){
  const budgetList=document.getElementById('budgetList');
  if(!budgetList)return;
  try{
    const{budgets}=await fetch(API+'/api/finance/budgets').then(r=>r.json());
    if(!budgets.length){budgetList.innerHTML='<div class="empty" style="padding:14px 0">no budgets set yet — add one below, or accept a suggestion if you see one.</div>';return;}
    budgetList.innerHTML=budgets.map(b=>{
      const over=b.percentUsed>=100;
      const pct=Math.min(b.percentUsed,100);
      return `<div class="budget-row" data-cat="${esc(b.category)}">
        <div class="budget-row-top">
          <span class="budget-row-name">${esc(b.category)}</span>
          <span class="budget-row-amounts">R${b.spentThisMonth.toFixed(0)} <span class="limit">/ R${b.monthlyLimit.toFixed(0)}</span></span>
        </div>
        <div class="budget-bar-wrap"><div class="budget-bar${over?' over':''}" style="width:${pct}%"></div></div>
        <div class="budget-row-foot">
          <span class="budget-row-remaining${over?' over':''}">${over?`R${Math.abs(b.remaining).toFixed(0)} over`:`R${b.remaining.toFixed(0)} left`}</span>
          <button class="budget-row-del" data-cat="${esc(b.category)}" type="button">remove</button>
        </div>
      </div>`;
    }).join('');
    budgetList.querySelectorAll('.budget-row-del').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        await fetch(`${API}/api/finance/budgets/${encodeURIComponent(btn.dataset.cat)}`,{method:'DELETE'});
        loadBudgets();loadBudgetSuggestions();
      });
    });
  }catch{budgetList.innerHTML='';}
}

async function loadBudgetSuggestions(){
  const banner=document.getElementById('budgetSuggestBanner'),list=document.getElementById('budgetSuggestList');
  if(!banner)return;
  try{
    const{suggestions}=await fetch(API+'/api/finance/budgets/suggest').then(r=>r.json());
    if(!suggestions.length){banner.style.display='none';return;}
    banner.style.display='block';
    list.innerHTML=suggestions.map(s=>`
      <div class="budget-suggest-item" data-cat="${esc(s.category)}" data-amt="${s.suggestedMonthly}">
        <span class="name">${esc(s.category)}</span>
        <span class="amt">R${s.suggestedMonthly}/mo</span>
        <button type="button">use this →</button>
      </div>`).join('');
    list.querySelectorAll('.budget-suggest-item button').forEach(btn=>{
      btn.addEventListener('click',async(e)=>{
        const row=e.target.closest('.budget-suggest-item');
        await fetch(API+'/api/finance/budgets',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({category:row.dataset.cat,monthlyLimit:parseFloat(row.dataset.amt),source:'suggested'}),
        });
        toast(`budget set for ${row.dataset.cat}`);
        loadBudgets();loadBudgetSuggestions();
      });
    });
  }catch{banner.style.display='none';}
}

document.getElementById('budgetAddBtn')?.addEventListener('click',async()=>{
  const cat=document.getElementById('budgetAddCategory').value;
  const amt=parseFloat(document.getElementById('budgetAddAmount').value);
  if(!cat||!amt||amt<=0){toast('enter a valid amount');return;}
  await fetch(API+'/api/finance/budgets',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({category:cat,monthlyLimit:amt,source:'manual'}),
  });
  document.getElementById('budgetAddAmount').value='';
  toast(`budget set for ${cat}`);
  loadBudgets();loadBudgetSuggestions();
});
function renderFinEntry(e){
  const el=document.createElement('div');el.className=`fin-entry ${e.type}-entry`;
  const sign=e.type==='income'?'+':'−';
  const date=e.imported_date?new Date(e.imported_date+'T00:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric'}):new Date(e.created_at).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const srcBadge=e.source==='import'?`<span style="font-size:9px;color:var(--text4);margin-left:4px">import</span>`:'';
  const catOpts=catOptionsFor(e.category);
  el.innerHTML=`<div class="amount fin-entry-amt ${e.type==='income'?'amt-income':'amt-expense'}">${sign}R${parseFloat(e.amount).toFixed(2)}</div><div class="details"><div class="note-text">${esc(e.note||e.merchant||e.category)}</div><div class="cat">${esc(e.category)}${srcBadge} · ${date}<select class="cat-edit" title="correct category">${catOpts}</select></div></div><button class="fin-del" aria-label="delete">×</button>`;
  el.querySelector('.cat-edit').addEventListener('change',async ev=>{el.classList.remove('editing-cat');await fetch(`${API}/api/finance/${e.id}/category`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:ev.target.value})});toast(`learned "${ev.target.value}" for ${e.merchant||'this merchant'}`);loadFinance();});
  el.querySelector('.cat').addEventListener('click',ev=>{
    if(ev.target.closest('.cat-edit'))return;
    el.classList.toggle('editing-cat');
  });
  el.querySelector('.fin-del').addEventListener('click',()=>{
    el.style.cssText+='transition:opacity .18s;opacity:0';
    let undone=false;
    pendingFinDeletes.add(e.id);
    setTimeout(()=>{if(!undone)el.style.display='none';},170);
    const del=setTimeout(async()=>{
      if(undone)return;
      try{
        const res=await fetch(`${API}/api/finance/${e.id}`,{method:'DELETE'});
        if(!res.ok)throw new Error('delete failed');
      }catch{
        pendingFinDeletes.delete(e.id);
        toast('could not delete — try again');
        loadFinance();
        return;
      }
      pendingFinDeletes.delete(e.id);
      loadFinance();
    },4500);
    toast(`deleted "${e.note||e.merchant||e.category}"`,()=>{undone=true;pendingFinDeletes.delete(e.id);clearTimeout(del);el.style.cssText='';el.style.display='';});
  });
  return el;
}
async function addFinEntry(){
  const amount=parseFloat(finAmount.value);if(!amount||amount<=0){finAmount.focus();return;}
  finAddBtn.disabled=true;
  await fetch(API+'/api/finance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:finType,amount,category:finCategory.value,note:finNote.value.trim()||null})});
  finAmount.value='';finNote.value='';finAddBtn.disabled=false;
  toast(`${finType} logged — R${amount.toFixed(2)}`);loadFinance();
}
finAddBtn.addEventListener('click',addFinEntry);
finAmount.addEventListener('keydown',e=>{if(e.key==='Enter')addFinEntry();});

/* ── Chat ─────────────────────────────────────────────────────────────────── */
const chatLog=document.getElementById('chatLog'),chatInput=document.getElementById('chatInput'),chatSendBtn=document.getElementById('chatSendBtn'),chatResetBtn=document.getElementById('chatResetBtn');
// Only auto-scroll when the user is already near the bottom — otherwise a
// streaming reply keeps yanking them back down while they're reading up.
function chatNearBottom(){const s=document.getElementById('tab-chat');return s?s.scrollHeight-s.scrollTop-s.clientHeight<120:true;}
function chatScrollToBottom(force){const s=document.getElementById('tab-chat');if(s&&(force||chatNearBottom()))s.scrollTop=s.scrollHeight;}
const chatImageBtn=document.getElementById('chatImageBtn'),chatImageInput=document.getElementById('chatImageInput'),chatImagePreview=document.getElementById('chatImagePreview');
const MAX_CHAT_IMAGES=6;
let pendingChatImages=[];
chatImageBtn?.addEventListener('click',()=>chatImageInput.click());
chatImageInput?.addEventListener('change',()=>{
  const files=Array.from(chatImageInput.files||[]);
  if(!files.length)return;
  const room=MAX_CHAT_IMAGES-pendingChatImages.length;
  if(room<=0){toast(`max ${MAX_CHAT_IMAGES} images`);chatImageInput.value='';return;}
  if(files.length>room)toast(`only added ${room} — max ${MAX_CHAT_IMAGES} images`);
  pendingChatImages=pendingChatImages.concat(files.slice(0,room));
  chatImageInput.value='';
  renderChatImagePreview();
});
function renderChatImagePreview(){
  chatImagePreview.innerHTML='';
  chatImagePreview.classList.toggle('show',pendingChatImages.length>0);
  pendingChatImages.forEach((f,i)=>{
    const thumb=document.createElement('div');thumb.className='thumb';
    const img=document.createElement('img');img.src=URL.createObjectURL(f);
    const rm=document.createElement('button');rm.type='button';rm.className='thumb-remove';rm.textContent='×';
    rm.addEventListener('click',()=>{pendingChatImages.splice(i,1);renderChatImagePreview();});
    thumb.appendChild(img);thumb.appendChild(rm);
    chatImagePreview.appendChild(thumb);
  });
  chatImageBtn.classList.toggle('listening',pendingChatImages.length>0);
  chatImageBtn.title=pendingChatImages.length?`${pendingChatImages.length} image(s) attached`:'attach image';
}
function clearPendingChatImage(){
  pendingChatImages=[];chatImageInput.value='';
  renderChatImagePreview();
}
const noKeyNotice=document.getElementById('noKeyNotice'),dayBtn=document.getElementById('dayBtn'),chatCtxBar=document.getElementById('chatCtxBar'),chatCtxStats=document.getElementById('chatCtxStats');

// Voice capture for the chat tab — mirrors the tasks-tab mic, writes into chatInput.
const chatVoiceBtn=document.getElementById('chatVoiceBtn');
if(chatVoiceBtn&&navigator.mediaDevices&&window.MediaRecorder){
  chatVoiceBtn.style.display='flex';
  let cvMediaRecorder=null,cvChunks=[],cvRecording=false,cvStream=null,cvBusy=false;
  async function cvStartRecording(){
    if(cvBusy)return;
    cvBusy=true;
    const isStandalone=window.navigator.standalone===true||matchMedia('(display-mode: standalone)').matches;
    try{
      cvStream=await Promise.race([
        navigator.mediaDevices.getUserMedia({audio:true}),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('mic timeout')),6000))
      ]);
    }catch{
      cvBusy=false;
      toast(isStandalone?"voice input doesn't work when added to your Home Screen on iPhone — open in Safari to use it, or just type":'mic permission denied');
      return;
    }
    cvChunks=[];
    const mime=['audio/webm','audio/mp4','audio/ogg'].find(t=>MediaRecorder.isTypeSupported(t))||'';
    cvMediaRecorder=new MediaRecorder(cvStream,mime?{mimeType:mime}:undefined);
    cvMediaRecorder.addEventListener('dataavailable',e=>{if(e.data.size>0)cvChunks.push(e.data);});
    cvMediaRecorder.addEventListener('stop',cvOnRecordingStop);
    cvMediaRecorder.start();
    cvRecording=true;cvBusy=false;chatVoiceBtn.classList.add('listening');showRecIndicator(cvStopRecording);
  }
  function cvStopRecording(){
    if(cvMediaRecorder&&cvRecording)cvMediaRecorder.stop();
    cvStream?.getTracks().forEach(t=>t.stop());
    cvRecording=false;chatVoiceBtn.classList.remove('listening');setRecBusy('transcribing…');
  }
  async function cvOnRecordingStop(){
    if(!cvChunks.length){hideRecIndicator();toast('didn\'t catch anything — try again');return;}
    const blob=new Blob(cvChunks,{type:cvMediaRecorder.mimeType||'audio/webm'});
    chatVoiceBtn.classList.add('transcribing');
    const fd=new FormData();
    const _cvExt=blob.type.includes('mp4')||blob.type.includes('m4a')?'m4a':blob.type.includes('ogg')?'ogg':blob.type.includes('wav')?'wav':'webm';
    fd.append('audio',blob,`voice.${_cvExt}`);
    try{
      const res=await fetch(API+'/api/transcribe',{method:'POST',body:fd});
      const data=await res.json();
      if(!res.ok||!data.text)throw new Error(data.error||'empty transcript');
      chatInput.value=(chatInput.value?chatInput.value+' ':'')+data.text;
      chatInput.style.height='auto';chatInput.style.height=chatInput.scrollHeight+'px';
      chatSendBtn.classList.toggle('ready',chatInput.value.trim().length>0);
    }catch{toast('voice capture failed — try again');}
    chatVoiceBtn.classList.remove('transcribing');hideRecIndicator();
  }
  chatVoiceBtn.addEventListener('click',()=>{
    if(cvBusy)return;
    if(cvRecording){cvStopRecording();}else{cvStartRecording();}
  });
}

chatInput.addEventListener('input',()=>{
  chatInput.style.height='auto';chatInput.style.height=chatInput.scrollHeight+'px';
  chatSendBtn.classList.toggle('ready',chatInput.value.trim().length>0);
});

async function loadChatContext(){
  try{
    const ctx=await fetch(API+'/api/context').then(r=>r.json());
    const{openCount,highCount,urgentTask}=ctx;
    const financeNet=await getMonthNet(ctx.financeNet);
    chatCtxBar.style.display='flex';
    chatCtxStats.innerHTML=[
      `<div class="ctx-stat"><span class="num ${highCount>0?'urgent':''}">${openCount}</span> open</div>`,
      highCount>0?`<div class="ctx-stat"><span class="num urgent">${highCount}</span> urgent</div>`:'',
      typeof financeNet==='number'?`<div class="ctx-stat">net <span class="num ${financeNet<0?'urgent':''}">${fmtNet(financeNet)}</span></div>`:'',
    ].join('');
    const g=greeting().replace(',','');
    let title=`${g}, ${esc(userName)}.`;
    let sub=`i'm Core, your personal assistant. `+(urgentTask&&highCount>0
      ?`<span class="hot">${esc(urgentTask)}</span> is flagged urgent.`
      :openCount>0
        ?`you've got <span class="em">${openCount}</span> thing${openCount===1?'':'s'} open.`
        :`clean slate today.`);
    sub+=`<br>how can I help?`;
    const titleEl=document.getElementById('chatEmptyTitle');
    const subEl=document.getElementById('chatEmptySub');
    if(titleEl)titleEl.textContent=title;
    if(subEl)subEl.innerHTML=sub;
  }catch{
    const titleEl=document.getElementById('chatEmptyTitle');
    if(titleEl)titleEl.textContent='hey.';
    const subEl=document.getElementById('chatEmptySub');
    if(subEl)subEl.textContent="i'm Core, your personal assistant. how can I help?";
  }
}

clearFinanceBtn?.addEventListener('click',()=>{
  openDangerConfirm({
    title:'clear all finance data?',
    message:"this removes all your finance entries. budgets and bank settings stay. this can't be undone.",
    phrase:'CLEAR FINANCE',
    confirmLabel:'clear finance data',
    onConfirm: async ()=>{
      clearFinanceBtn.disabled=true;
      try{
        const response=await fetch(API+'/api/finance',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'CLEAR_FINANCE_DATA'})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok){notify({msg:data.error||'could not clear finance data'});return;}
        notify({msg:`cleared ${data.deleted||0} finance entr${data.deleted===1?'y':'ies'}`});
        loadFinance();
      }catch{notify({msg:'could not clear finance data — try again'});}
      finally{clearFinanceBtn.disabled=false;}
    },
  });
});

/* ── iOS audio unlock ────────────────────────────────────────────────────── */
// iOS Safari blocks .play()/.speak() calls that happen after an async gap
// (e.g. after an awaited fetch), even when the call chain started from a tap.
// Fix: unlock a persistent <audio> element + speechSynthesis once, on the
// very first user interaction, so later async playback is allowed for the
// rest of the session.
const SILENT_WAV='data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAAAAAA==';
let ttsAudioEl=null;
let audioUnlocked=false;
function unlockIOSAudio(){
  if(audioUnlocked)return;
  audioUnlocked=true;
  try{
    ttsAudioEl=new Audio(SILENT_WAV);
    ttsAudioEl.play().catch(()=>{});
  }catch{}
  try{
    if('speechSynthesis' in window){
      const primer=new SpeechSynthesisUtterance('');
      primer.volume=0;
      speechSynthesis.speak(primer);
    }
  }catch{}
}
document.addEventListener('touchstart',unlockIOSAudio,{once:true,passive:true});
document.addEventListener('click',unlockIOSAudio,{once:true});

let speakingBtn=null;
let speechAudio=null;
let speechToken=0;
let speechVoices=[];
function loadSpeechVoices(){
  if(!('speechSynthesis' in window))return [];
  speechVoices=speechSynthesis.getVoices()||[];
  return speechVoices;
}
function chooseSpeechVoice(){
  const voices=loadSpeechVoices();
  const english=voices.filter(v=>/^en(-|_)/i.test(v.lang));
  const pool=english.length?english:voices;
  const british=pool.filter(v=>/^en-GB|^en_GB/i.test(v.lang));
  const maleBritish=/daniel|george|ryan|brian|arthur|google uk english male|microsoft.*(male|ryan|george|guy|oliver)/i;
  const maleEnglish=/alex|david|mark|james|guy|male|daniel|george|ryan|brian|arthur/i;
  return british.find(v=>maleBritish.test(v.name))||
    british.find(v=>/natural|enhanced|online/i.test(v.name))||
    british[0]||pool.find(v=>maleEnglish.test(`${v.name} ${v.lang}`))||
    pool.find(v=>/en-US/i.test(v.lang))||pool[0]||null;
}
if('speechSynthesis' in window){
  loadSpeechVoices();
  speechSynthesis.addEventListener('voiceschanged',loadSpeechVoices);
}
function splitIntoSpeechChunks(text){
  const sentences=text.match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^.!?\n]+$/g)||[text];
  const chunks=[];let cur='';
  for(const s of sentences){
    if(cur&&(cur+s).length>(chunks.length===0?110:280)){chunks.push(cur.trim());cur=s;}
    else cur+=s;
  }
  if(cur.trim())chunks.push(cur.trim());
  return chunks.length?chunks:[text];
}
async function fetchSpeechAudioSrc(text){
  const response=await fetch(API+'/api/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
  if(!response.ok)throw new Error('tts failed');
  const data=await response.json();
  return `data:${data.mimeType};base64,${data.audio}`;
}
function fallbackSpeechChunk(text,done){
  if(!('speechSynthesis' in window)){done();return;}
  const utter=new SpeechSynthesisUtterance(text);
  const voice=chooseSpeechVoice();
  if(voice)utter.voice=voice;
  utter.rate=.96;utter.pitch=1.02;utter.volume=1;
  utter.onend=done;utter.onerror=done;
  speechSynthesis.speak(utter);
}
async function speakMsg(span,btn){
  if(speechAudio){speechAudio.pause();speechAudio.src='';speechAudio=null;}
  if('speechSynthesis' in window)speechSynthesis.cancel();
  const wasSpeaking=speakingBtn;
  if(wasSpeaking)wasSpeaking.classList.remove('speaking');
  speechToken++;const myToken=speechToken;
  speakingBtn=null;
  if(wasSpeaking===btn)return; // tapping the same button again just stops it
  const text=cleanSpeechText(span.textContent);
  if(!text)return;
  speakingBtn=btn;btn.classList.add('speaking');
  unlockIOSAudio(); // no-op after the first tap; covers the case where the speak button itself is that first tap
  const chunks=splitIntoSpeechChunks(text);
  // fire off all chunk requests in parallel so later chunks are ready by the time we need them
  const prefetch=[];
  const startFetch=i=>{if(i<chunks.length&&!prefetch[i])prefetch[i]=fetchSpeechAudioSrc(chunks[i]).catch(()=>null);};
  startFetch(0);startFetch(1);
  let toldFallback=false;
  for(let i=0;i<chunks.length;i++){
    if(speechToken!==myToken)return; // cancelled — a newer speak (or a stop) took over
    startFetch(i+1);startFetch(i+2);
    const src=await prefetch[i];
    if(speechToken!==myToken)return;
    if(src){
      const audioEl=ttsAudioEl||new Audio();
      speechAudio=audioEl;audioEl.src=src;
      try{
        await new Promise((res,rej)=>{audioEl.onended=res;audioEl.onerror=rej;audioEl.play().catch(rej);});
      }catch{
        if(speechToken!==myToken)return;
        await new Promise(res=>fallbackSpeechChunk(chunks[i],res));
      }
    }else{
      if(!toldFallback){toast('Core\'s voice is unavailable right now — using your phone\'s voice instead');toldFallback=true;}
      if(speechToken!==myToken)return;
      await new Promise(res=>fallbackSpeechChunk(chunks[i],res));
    }
  }
  if(speechToken===myToken){btn.classList.remove('speaking');speakingBtn=null;speechAudio=null;}
}
const SPEAK_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
const COPY_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const imgLightbox=document.getElementById('imgLightbox'),imgLightboxImg=document.getElementById('imgLightboxImg');
imgLightbox?.addEventListener('click',()=>imgLightbox.classList.remove('show'));
function openLightbox(src){imgLightboxImg.src=src;imgLightbox.classList.add('show');}
function copyMsg(text,btn){
  navigator.clipboard.writeText(text).then(()=>{
    btn.classList.add('copied');
    const actions=btn.closest('.msg-actions');actions?.classList.add('force-show');
    setTimeout(()=>{btn.classList.remove('copied');actions?.classList.remove('force-show');},1200);
  }).catch(()=>toast('could not copy'));
}
function appendMsg(role,text,imageSrc){
  const empty=chatLog.querySelector('.chat-empty');if(empty)empty.remove();
  // fade particles when real content appears
  const chatTab=document.getElementById('tab-chat');
  if(chatTab&&role!=='thinking')chatTab.classList.add('has-messages');
  if(role!=='thinking'&&typeof _chatParticlesPulse==='function')_chatParticlesPulse();
  const el=document.createElement('div');el.className=`msg ${role}`;
  const imageSrcs=Array.isArray(imageSrc)?imageSrc:(imageSrc?[imageSrc]:[]);
  if(imageSrcs.length){
    const wrap=document.createElement('div');wrap.className='msg-image-group';
    imageSrcs.forEach(src=>{
      const img=document.createElement('img');img.className='msg-image';img.src=src;img.alt='attached image';
      img.addEventListener('click',()=>openLightbox(src));
      wrap.appendChild(img);
    });
    el.appendChild(wrap);
  }
  const span=document.createElement('span');span.className='msg-text';span.textContent=text;
  el.appendChild(span);
  if(role==='assistant'||role==='user'){
    const actions=document.createElement('div');actions.className='msg-actions';
    const copyBtn=document.createElement('button');
    copyBtn.type='button';copyBtn.className='msg-copy';copyBtn.setAttribute('aria-label','copy');copyBtn.title='copy';
    copyBtn.innerHTML=COPY_ICON;
    copyBtn.addEventListener('click',()=>copyMsg(span.textContent,copyBtn));
    actions.appendChild(copyBtn);
    if(role==='assistant'){
      const btn=document.createElement('button');
      btn.type='button';btn.className='msg-speak';btn.setAttribute('aria-label','read aloud');btn.title='read aloud';
      btn.innerHTML=SPEAK_ICON;
      btn.addEventListener('click',()=>speakMsg(span,btn));
      actions.appendChild(btn);
    }
    const time=document.createElement('span');time.className='msg-time';
    time.textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    actions.appendChild(time);
    el.appendChild(actions);
  }
  const prevMsg=chatLog.lastElementChild;
  if(prevMsg&&prevMsg.classList.contains('msg')&&!prevMsg.classList.contains('thinking')&&prevMsg.classList.contains(role)){
    el.classList.add('grp-prev');prevMsg.classList.add('grp-next');
  }
  chatLog.appendChild(el);chatScrollToBottom(role==='user');return el;
}
function cleanAssistantReply(text){
  const value=String(text??'').trim();
  if(!value.startsWith('{'))return formatAssistantReply(value);
  try{
    const parsed=JSON.parse(value);
    if(typeof parsed.reply==='string')return formatAssistantReply(parsed.reply);
  }catch{}
  const key=value.search(/"reply"\s*:/i);
  if(key===-1)return formatAssistantReply(value);
  const start=value.indexOf('"',key+7);
  if(start===-1)return formatAssistantReply(value);
  let escaped=false;
  for(let i=start+1;i<value.length;i++){
    const ch=value[i];
    if(ch==='"'&&!escaped){
      try{return formatAssistantReply(JSON.parse(value.slice(start,i+1)));}catch{return formatAssistantReply(value.slice(start+1,i).replace(/\\n/g,'\n').replace(/\\"/g,'"'));}
    }
    escaped=ch==='\\'&&!escaped;
    if(ch!=='\\')escaped=false;
  }
  return formatAssistantReply(value);
}
function formatAssistantReply(text){
  return String(text??'').replace(/\*\*/g,'').replace(/(^|\s)\*(?=\s|$)/g,'$1').replace(/^#{1,6}\s+/gm,'').trim();
}
function cleanSpeechText(text){
  return formatAssistantReply(text)
    .replace(/https?:\/\/\S+/gi,'link')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'')
    .replace(/\s{2,}/g,' ')
    .trim();
}
function streamMsgText(el,text){
  return new Promise(resolve=>{
    el.classList.add('streaming');
    const span=el.querySelector('.msg-text')||el;
    const tokens=text.split(/(\s+)/); // preserve whitespace so words don't get glued
    let i=0,pending='',rafId=null;
    function flush(){
      rafId=null;
      if(!pending)return;
      span.textContent+=pending;pending='';
      chatScrollToBottom(false);
    }
    (function step(){
      if(i>=tokens.length){
        if(rafId)cancelAnimationFrame(rafId);
        flush();
        el.classList.remove('streaming');resolve();return;
      }
      pending+=tokens[i];i++;
      if(!rafId)rafId=requestAnimationFrame(flush);
      setTimeout(step,tokens[i-1].trim()?16:4); // words take a beat, whitespace is instant
    })();
  });
}
const THINK_LINES=[
  'consulting the spreadsheets…',
  'counting your rands…',
  'reading your tasks. all of them…',
  'warming up the thinking bits…',
  'asking my other brain cell…',
  'shuffling priorities like a deck of cards…',
  'checking it isn\'t load shedding…',
  'pretending this took effort…',
  'arguing with myself. i\'m winning…',
  'looking busy while i work it out…',
  'dusting off the good ideas…',
  'rereading that. twice…'
];
const THINK_SLOW=[
  [8000,'still on it — this one\'s a thinker…'],
  [20000,'okay this is taking a while. i haven\'t forgotten you…'],
  [40000,'the servers are moving at a stroll today…']
];
function showThinking(){
  const empty=chatLog.querySelector('.chat-empty');if(empty)empty.remove();
  const el=document.createElement('div');el.className='msg thinking';
  el.setAttribute('role','status');el.setAttribute('aria-label','Core is thinking');
  el.innerHTML='<span class="tdots"><i></i><i></i><i></i></span><span class="tphrase" aria-hidden="true"></span><span class="tcaret"></span>';
  const out=el.querySelector('.tphrase');
  const order=THINK_LINES.map(v=>[Math.random(),v]).sort((a,b)=>a[0]-b[0]).map(v=>v[1]);
  const reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0=Date.now();
  let idx=0,slowShown=-1,timer=null,dead=false;
  const later=(fn,ms)=>{timer=setTimeout(()=>{if(dead||!el.isConnected)return;fn();},ms);};
  function pick(){
    for(let i=THINK_SLOW.length-1;i>slowShown;i--){
      if(Date.now()-t0>=THINK_SLOW[i][0]){slowShown=i;return THINK_SLOW[i][1];}
    }
    return order[idx++%order.length];
  }
  function erase(line){
    if(reduce){next();return;}
    let n=line.length;
    (function tick(){
      n-=2;out.textContent=line.slice(0,Math.max(n,0));
      if(n>0)later(tick,12);else later(next,180);
    })();
  }
  function typeIn(line){
    if(reduce){out.textContent=line;later(()=>erase(line),2400);return;}
    let n=0,typoed=false;
    (function tick(){
      if(!typoed&&n>4&&n<line.length-3&&Math.random()<.07){
        typoed=true;
        out.textContent=line.slice(0,n)+'qwxz'[Math.floor(Math.random()*4)];
        later(()=>{out.textContent=line.slice(0,n);later(tick,140);},420);
        return;
      }
      n++;out.textContent=line.slice(0,n);
      if(n<line.length)later(tick,24+Math.random()*40);
      else later(()=>erase(line),1600);
    })();
  }
  function next(){typeIn(pick());}
  const rm=el.remove.bind(el);
  el.remove=()=>{dead=true;clearTimeout(timer);rm();};
  chatLog.appendChild(el);chatScrollToBottom(true);
  next();
  return el;
}
async function sendChat(overrideUrl){
  const text=chatInput.value.trim();if(!text&&!overrideUrl&&!pendingChatImages.length)return;
  const imagesToSend=overrideUrl?[]:pendingChatImages.slice();
  const imagePreviewUrls=imagesToSend.map(f=>URL.createObjectURL(f));
  if(!overrideUrl){appendMsg('user',text,imagePreviewUrls);chatInput.value='';chatInput.style.height='auto';clearPendingChatImage();}
  chatSendBtn.disabled=true;if(dayBtn)dayBtn.disabled=true;
  const thinking=showThinking();
  try{
    let res;
    if(imagesToSend.length){
      const fd=new FormData();
      fd.append('message',text);
      imagesToSend.forEach(f=>fd.append('images',f,f.name||'image.jpg'));
      res=await fetch(API+'/api/chat',{method:'POST',body:fd});
    }else{
      res=await fetch(overrideUrl||API+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(overrideUrl?{}:{message:text})});
    }
    const data=await res.json();thinking.remove();
    if(res.status===503){noKeyNotice.style.display='block';appendMsg('assistant','no AI provider is configured right now — add GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY.');}
    else{
      const el=appendMsg('assistant','');
      await streamMsgText(el,res.ok?cleanAssistantReply(data.reply):`core hit a snag there — ${data.error||'try again?'}`);
      if(data.tasksChanged)loadTasks();
    }
  }catch{thinking.remove();appendMsg('assistant','connection error — try again.');}
  chatSendBtn.disabled=false;if(dayBtn)dayBtn.disabled=false;
}
chatSendBtn.addEventListener('click',()=>sendChat());
chatInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}});
dayBtn.addEventListener('click',()=>sendChat(API+'/api/chat/day'));
chatResetBtn.addEventListener('click',async()=>{
  await fetch(API+'/api/chat/reset',{method:'POST'});
  // restore the structured empty state
  chatLog.innerHTML=`
    <div class="chat-empty" id="chatEmpty">
      <img src="/icon-orb.png" class="chat-empty-orb" alt="" aria-hidden="true" width="64" height="64" style="opacity:.75;width:64px;height:64px;object-fit:contain">
      <div class="chat-empty-title" id="chatEmptyTitle">fresh start.</div>
      <div class="chat-empty-sub" id="chatEmptySub">i'm Core, your personal assistant. how can I help?</div>
    </div>`;
  document.getElementById('tab-chat')?.classList.remove('has-messages');
  noKeyNotice.style.display='none';
  loadChatContext();
});

/* ── Account name ─────────────────────────────────────────────────────────── */
const settingsNameInput=document.getElementById('settingsNameInput'),settingsNameSaveBtn=document.getElementById('settingsNameSaveBtn');
settingsNameSaveBtn?.addEventListener('click',async()=>{
  const name=settingsNameInput.value.trim();
  if(!name){toast('enter a name first');return;}
  settingsNameSaveBtn.disabled=true;
  try{
    const res=await fetch(API+'/api/auth/me',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    const data=await res.json();
    if(res.ok){userName=data.name;toast('name updated');loadMomentum();}
    else{toast(data.error||'could not update name');}
  }catch{toast('network error — try again');}
  settingsNameSaveBtn.disabled=false;
});

/* ── Profile ──────────────────────────────────────────────────────────────── */
const profileEditor=document.getElementById('profileEditor'),profileSaveBtn=document.getElementById('profileSaveBtn'),profileSaved=document.getElementById('profileSaved');
async function loadProfile(){
  try{const{content}=await fetch(API+'/api/profile').then(r=>r.json());profileEditor.value=content;autoGrow(profileEditor);}
  catch{profileEditor.value='(could not load profile)';}
}

const AI_CONTEXT_PROMPT=`I use an AI assistant to help manage my tasks, spending, and daily thinking, and I want to give it real context about me instead of starting from nothing.

Based on everything you know about me from our conversation history, write a concise "about me" profile (roughly 250–400 words) I can paste directly into that assistant. Include:
- who I am and what I actually do (work, studies, projects — whatever's real)
- what I'm currently juggling or responsible for
- how I like to communicate and work (direct vs detailed, formal vs casual, etc.)
- recurring goals, priorities, or things I keep coming back to
- anything else that would help an assistant give me genuinely useful, specific help instead of generic advice

Write it as plain, dense description — not a resume, not bullet points, no filler or flattery. Just the facts that would actually change how someone helps me.`;

const aiContextToggle=document.getElementById('aiContextToggle'),
      aiContextBody=document.getElementById('aiContextBody'),
      copyContextPromptBtn=document.getElementById('copyContextPromptBtn');

aiContextToggle?.addEventListener('click',()=>{
  const open=aiContextBody.style.display!=='none';
  aiContextBody.style.display=open?'none':'block';
  aiContextToggle.setAttribute('aria-expanded',String(!open));
});

copyContextPromptBtn?.addEventListener('click',async()=>{
  try{
    await navigator.clipboard.writeText(AI_CONTEXT_PROMPT);
    copyContextPromptBtn.textContent='copied ✓';
    toast('prompt copied — paste it into your AI');
    setTimeout(()=>{ copyContextPromptBtn.textContent='copy the prompt →'; },2200);
  }catch{
    toast('couldn\'t copy — long-press to select manually');
  }
});
profileEditor.addEventListener('input',()=>autoGrow(profileEditor));
profileSaveBtn.addEventListener('click',async()=>{
  profileSaveBtn.disabled=true;
  await fetch(API+'/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:profileEditor.value})});
  profileSaveBtn.disabled=false;profileSaved.classList.add('show');
  setTimeout(()=>profileSaved.classList.remove('show'),2500);toast('profile updated');
});

/* ── Quick add (Cmd/Ctrl+K) ──────────────────────────────────────────────── */
window.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){
    e.preventDefault();
    document.querySelector('.nav-item[data-tab="tasks"]').click();
    input.focus();
    input.scrollIntoView({block:'center',behavior:'smooth'});
  }
});

/* ── Settings panel wiring ───────────────────────────────────────────────── */
// Theme buttons
settingsThemeDark?.addEventListener('click',()=>{applyTheme('dark');syncSettingsThemeBtns();});
settingsThemeLight?.addEventListener('click',()=>{applyTheme('light');syncSettingsThemeBtns();});
syncSettingsThemeBtns();

// Settings sound toggle — mirrors the header sound toggle
const settingsSoundToggle=document.getElementById('settingsSoundToggle');
function applySoundIconSettings(){
  if(settingsSoundToggle)settingsSoundToggle.textContent=localStorage.getItem('sound_off')==='1'?'🔕':'🔔';
}
applySoundIconSettings();
settingsSoundToggle?.addEventListener('click',()=>{
  localStorage.setItem('sound_off',localStorage.getItem('sound_off')==='1'?'0':'1');
  applySoundIconSettings();
  applySoundIcon();
});

/* ── Boot ─────────────────────────────────────────────────────────────────── */
loadStatus();loadTasks();loadMomentum();loadHeatmap();loadPlan();resumePendingPlan();loadNotificationPrefs();loadVoiceSetting();

/* ── First-time onboarding walkthrough — shows once, never again ─────────── */
(function(){
  if(localStorage.getItem('onboardingSeen')==='1')return;
  const overlay=document.getElementById('onboardOverlay');
  if(!overlay)return;
  const steps=[...overlay.querySelectorAll('.onboard-step')];
  const dots=[...overlay.querySelectorAll('.onboard-dot')];
  const nextBtn=document.getElementById('onboardNext');
  const skipBtn=document.getElementById('onboardSkip');
  let i=0;
  function render(){
    steps.forEach((s,idx)=>s.style.display=idx===i?'block':'none');
    dots.forEach((d,idx)=>d.classList.toggle('active',idx===i));
    nextBtn.textContent=i===steps.length-1?"let's go":'next';
  }
  function finish(){
    localStorage.setItem('onboardingSeen','1');
    overlay.style.display='none';
  }
  nextBtn.addEventListener('click',()=>{
    if(i===steps.length-1){finish();return;}
    i++;render();
  });
  skipBtn.addEventListener('click',finish);
  overlay.style.display='flex';
  render();
})();
/* ── First-time onboarding tour — spotlights real features, shows once ───── */
(function(){
  if(localStorage.getItem('onboardingSeen')==='1')return;
  const overlay=null; // retired: replaced by the v2 tour
  if(!overlay)return;
  const spot=document.getElementById('tourSpot');
  const card=document.getElementById('tourCard');
  const titleEl=document.getElementById('tourTitle');
  const textEl=document.getElementById('tourText');
  const countEl=document.getElementById('tourCount');
  const nextBtn=document.getElementById('tourNext');
  const backBtn=document.getElementById('tourBack');
  const skipBtn=document.getElementById('tourSkip');

  const steps=[
    {tab:'tasks',title:'this is Core.',text:"a quick tour of what's in here — tasks, money, and a chat that knows both. about a minute, skip anytime."},
    {tab:'tasks',target:'#tasksHero',title:'your day, at a glance',text:"your streak and activity heatmap live up top, with your open tasks right below. a daily brief (weather, top task, month's net) shows up above when there's something worth flagging."},
    {tab:'tasks',target:'#composeBar',title:'just say it',text:"type what's on your mind in plain language and Core turns it into tasks and reminders. tap the mic if you'd rather say it out loud."},
    {tab:'tasks',target:'#aiModeChip',title:'AI or manual',text:"tap this to switch. AI mode lets Core reason about priority and timing; manual is for quick, no-frills tasks."},
    {tab:'calendar',target:'#tab-calendar .cal-strip',title:'your week, planned',text:"events, dated tasks and AI-built plans in one place. ask Core to plan your day or week, review it, then add it with one tap. you can also sync it to Google or Apple calendar."}, {tab:'finance',target:'#bankCard',title:'your money, one card',text:"this month's net and your last import at a glance. tap the card to flip it and see your net balance. tap the name to edit it."},
    {tab:'finance',target:'#importDock',title:'import a statement',text:"drop in a bank statement and Core reads the transactions, shows you a preview to confirm, then folds them into the same picture as your tasks."},
    {tab:'finance',target:'#budgetList',title:'budgets',text:"set spending limits per category. Core can suggest budgets based on what you actually spend."},
    {tab:'chat',target:'#chatInputRow',title:'talk to Core',text:"this chat knows your tasks and your finances. ask it to plan your day, or what to focus on — you can send photos or use voice too."},
    {tab:'profile',target:'#aiContextCard',title:'teach Core about you',text:"already chat with another AI? this shortcut gives you a prompt to copy so it can write your profile for you. the more Core knows, the better it helps."},
    {tab:'profile',target:'#accentColorPreview',title:'make it yours',text:"pick an accent color, switch dark or light, and choose Core's voice — all in settings."}
  ];

  let i=0,token=0,active=true;

  function goTab(tab){
    const cur=document.querySelector('.nav-item.active')?.dataset.tab;
    if(cur!==tab)document.querySelector('.nav-item[data-tab="'+tab+'"]')?.click();
  }

  function place(s){
    const vw=window.innerWidth,vh=window.innerHeight;
    const cw=card.offsetWidth,ch=card.offsetHeight;
    let r=null;
    const el=s.target?document.querySelector(s.target):null;
    if(el){
      el.scrollIntoView({block:'center'});
      const b=el.getBoundingClientRect();
      if(b.width>=8&&b.height>=8)r=b;
    }
    card.style.left=Math.max(12,(vw-cw)/2)+'px';
    if(!r){
      spot.classList.add('no-target');
      spot.style.top='50%';spot.style.left='50%';spot.style.width='0px';spot.style.height='0px';
      card.style.top=Math.max(12,(vh-ch)/2)+'px';
      return;
    }
    const pad=6;
    const top=Math.max(4,r.top-pad),left=Math.max(4,r.left-pad);
    const w=Math.min(vw-left-4,r.width+pad*2),h=r.height+pad*2;
    spot.classList.remove('no-target');
    spot.style.top=top+'px';spot.style.left=left+'px';
    spot.style.width=w+'px';spot.style.height=h+'px';
    const below=vh-(top+h),above=top;
    let ct;
    if(below>=ch+20)ct=top+h+12;
    else if(above>=ch+20)ct=top-ch-12;
    else ct=vh-ch-12;
    card.style.top=Math.max(12,Math.min(ct,vh-ch-12))+'px';
  }

  function show(){
    const s=steps[i],my=++token;
    titleEl.textContent=s.title;
    textEl.textContent=s.text;
    countEl.textContent=(i+1)+' / '+steps.length;
    backBtn.style.visibility=i?'visible':'hidden';
    nextBtn.textContent=i===steps.length-1?"let's go":'next';
    const cur=document.querySelector('.nav-item.active')?.dataset.tab;
    const delay=s.tab&&s.tab!==cur?380:30; // wait out the tab-switch animation
    if(s.tab)goTab(s.tab);
    setTimeout(()=>{if(my===token&&active)place(s);},delay);
  }

  function onResize(){if(active)place(steps[i]);}

  function finish(){
    active=false;token++;
    localStorage.setItem('onboardingSeen','1');
    window.removeEventListener('resize',onResize);
    overlay.style.display='none';
    goTab('tasks');
    window.scrollTo(0,0);
  }

  nextBtn.addEventListener('click',()=>{
    if(i===steps.length-1){finish();return;}
    i++;show();
  });
  backBtn.addEventListener('click',()=>{if(i>0){i--;show();}});
  skipBtn.addEventListener('click',finish);
  window.addEventListener('resize',onResize);

  overlay.style.display='block';
  show();
})();
/* ── First-time onboarding tour v2 — starts only once the app is open ───── */
(function(){
  const $=id=>document.getElementById(id);
  const steps=[
    {title:'this is Core.',text:"a quick tour of what's in here — tasks, money, and a chat that knows both. about a minute, skip anytime."},
    {tab:'tasks',target:'#tasksHero',title:'your day, at a glance',text:"your streak and activity heatmap live up top, with your open tasks right below. a daily brief (weather, top task, month's net) shows up above when there's something worth flagging."},
    {tab:'tasks',target:'#composeBar',title:'just say it',text:"type what's on your mind in plain language and Core turns it into tasks and reminders. tap the mic if you'd rather say it out loud."},
    {tab:'tasks',target:'#aiModeChip',title:'AI or manual',text:"tap this to switch. AI mode lets Core reason about priority and timing; manual is for quick, no-frills tasks."},
    {tab:'calendar',target:'#tab-calendar .cal-strip',title:'your week, planned',text:"events, dated tasks and AI-built plans in one place. ask Core to plan your day or week, review it, then add it with one tap. you can also sync it to Google or Apple calendar."}, {tab:'finance',target:'#bankCard',title:'your money, one card',text:"this month's net and your last import at a glance. tap the card to flip it and see your net balance. tap the name to edit it."},
    {tab:'finance',target:'#importDock',title:'import a statement',text:"drop in a bank statement and Core reads the transactions, shows you a preview to confirm, then folds them into the same picture as your tasks."},
    {tab:'finance',target:'#budgetAddRow',title:'budgets',text:"set a monthly limit per category here. Core can suggest budgets based on what you actually spend."},
    {tab:'chat',target:'#chatInputRow',title:'talk to Core',text:"this chat knows your tasks and your finances. ask it to plan your day, or what to focus on — you can send photos or use voice too."},
    {tab:'profile',target:'#aiContextCard',title:'teach Core about you',text:"already chat with another AI? this shortcut gives you a prompt to copy so it can write your profile for you. the more Core knows, the better it helps."},
    {tab:'profile',target:'#accentColorPreview',title:'make it yours',text:"pick an accent color, switch dark or light, and choose Core's voice — all in settings."}
  ];
  let i=0,token=0,active=false,started=false;

  function goTab(tab){
    const cur=document.querySelector('.nav-item.active')?.dataset.tab;
    if(cur===tab)return false;
    document.querySelector('.nav-item[data-tab="'+tab+'"]')?.click();
    return true;
  }

  function place(s){
    const ov=$('tourOverlay'),spot=$('tourSpot'),card=$('tourCard');
    if(!active||!ov)return;
    const vw=window.innerWidth,vh=window.innerHeight;
    const cw=card.offsetWidth,ch=card.offsetHeight;
    let r=null;
    const el=s.target?document.querySelector(s.target):null;
    if(el){
      // 'instant' beats the page's CSS smooth-scroll, so we measure the final position
      el.scrollIntoView({block:'center',behavior:'instant'});
      const b=el.getBoundingClientRect();
      if(b.width>=8&&b.height>=8)r=b;
    }
    if(!r){
      spot.classList.add('no-target');
      spot.style.top='50%';spot.style.left='50%';spot.style.width='0px';spot.style.height='0px';
      card.style.left=Math.max(12,(vw-cw)/2)+'px';
      card.style.top=Math.max(12,(vh-ch)/2)+'px';
      return;
    }
    const pad=6;
    const top=Math.max(4,r.top-pad),left=Math.max(4,r.left-pad);
    const w=Math.min(vw-left-4,r.width+pad*2),h=r.height+pad*2;
    spot.classList.remove('no-target');
    spot.style.top=top+'px';spot.style.left=left+'px';
    spot.style.width=w+'px';spot.style.height=h+'px';
    const below=vh-(top+h),above=top;
    let ct;
    if(below>=ch+20)ct=top+h+12;
    else if(above>=ch+20)ct=top-ch-12;
    else ct=vh-ch-12;
    card.style.top=Math.max(12,Math.min(ct,vh-ch-12))+'px';
    card.style.left=Math.max(12,Math.min(left+w/2-cw/2,vw-cw-12))+'px';
  }

  function show(){
    const s=steps[i],my=++token;
    $('tourTitle').textContent=s.title;
    $('tourText').textContent=s.text;
    $('tourCount').textContent=(i+1)+' / '+steps.length;
    $('tourBack').style.visibility=i?'visible':'hidden';
    $('tourNext').textContent=i===steps.length-1?"let's go":'next';
    const switched=s.tab?goTab(s.tab):false;
    // wait out the tab-switch animation, then place, then re-check once it has settled
    setTimeout(()=>{if(my===token)place(s);},switched?460:40);
    setTimeout(()=>{if(my===token)place(s);},switched?800:340);
  }

  function onResize(){if(active)place(steps[i]);}
  function onKey(e){
    if(!active)return;
    if(e.key==='ArrowRight'||e.key==='Enter'){e.preventDefault();$('tourNext').click();}
    else if(e.key==='ArrowLeft'){$('tourBack').click();}
    else if(e.key==='Escape'){finish();}
  }

  function finish(){
    active=false;token++;
    try{localStorage.setItem('onboardingSeen','1');}catch(e){}
    window.removeEventListener('resize',onResize);
    document.removeEventListener('keydown',onKey);
    const ov=$('tourOverlay');if(ov)ov.style.display='none';
    goTab('tasks');
    window.scrollTo({top:0,behavior:'instant'});
  }

  // Called by enterApp() once the app is visible — never runs on the sign-up / start screens.
  window.startCoreTour=function(){
    if(started)return;
    let seen=false;try{seen=localStorage.getItem('onboardingSeen')==='1';}catch(e){}
    if(seen||!$('tourOverlay'))return;
    started=true;active=true;i=0;
    $('tourNext').onclick=()=>{if(i===steps.length-1){finish();return;}i++;show();};
    $('tourBack').onclick=()=>{if(i>0){i--;show();}};
    $('tourSkip').onclick=finish;
    window.addEventListener('resize',onResize);
    document.addEventListener('keydown',onKey);
    $('tourOverlay').style.display='block';
    const switched=goTab('tasks');
    setTimeout(show,switched?460:0);
  };
})();
showInstallBanner();showNotificationBanner();

// Visibility-aware polling — pause all background work when the tab is hidden
let _pollTimer=null;
function _startPolling(){
  if(_pollTimer)return;
  _pollTimer=setInterval(()=>{
    if(document.hidden)return; // extra guard; real pause is via visibilitychange
    loadTasks();loadMomentum();checkAlarms();
  },15000);
}
function _stopPolling(){
  if(_pollTimer){clearInterval(_pollTimer);_pollTimer=null;}
}
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){
    _stopPolling();
    _stopChatParticles();
  } else {
    loadTasks();loadMomentum();_startPolling();
    // restart chat particles if chat tab is active
    const chatPanel=document.getElementById('tab-chat');
    if(chatPanel?.classList.contains('active')){
      requestAnimationFrame(()=>requestAnimationFrame(_startChatParticles));
    }
  }
});
_startPolling();

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/sw.js').catch(err=>console.warn('[sw] registration failed:',err));
  // A tab that was already open keeps running the OLD app shell in memory
  // even after a new service worker installs and claims it — that's exactly
  // the "name doesn't show, tasks never load" symptom after a deploy. Reload
  // once, automatically, the moment a new version actually takes control.
  let swRefreshed=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(swRefreshed)return;
    swRefreshed=true;
    location.reload();
  });
}

// Manual escape hatch in Settings for whenever auto-refresh doesn't catch it
// (e.g. no previous controller yet, or a genuinely wedged cache).
async function hardRefreshApp(){
  try{
    if('serviceWorker' in navigator){
      const regs=await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r=>r.unregister()));
    }
    if('caches' in window){
      const keys=await caches.keys();
      await Promise.all(keys.map(k=>caches.delete(k)));
    }
  }catch(err){console.warn('[refresh] cleanup failed:',err);}
  location.reload();
}
document.getElementById('refreshAppBtn')?.addEventListener('click',hardRefreshApp);