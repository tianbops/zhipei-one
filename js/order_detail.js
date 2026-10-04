(function(){
'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const attr=v=>esc(v).replace(/'/g,'&#39;');
const navOf=x=>String(x?.navigation||x?.nav||'').trim();
const params=new URLSearchParams(location.search), id=params.get('id')||'', source=params.get('source')||'', targetDate=params.get('date')||'';
let order=null,menuOpen=false,historyChoices=null;let baseStoreCache=null,baseStoreRoute=null;

function safeUrl(v){try{const raw=String(v??'').trim();if(!raw)return'';const u=new URL(raw,location.origin);return /^(https?:)$/.test(u.protocol)?u.href:''}catch{return''}}
function vehicleText(v){const s=String(v??'').replace(/undefined/gi,'').replace(/\s+/g,'').trim();return s?('车辆 '+s):''}
function cleanVehicle(v){return vehicleText(v).replace(/^车辆\s*/,'')||'车辆待确认'}
function fmtWeight(v){const n=Number(v);return Number.isFinite(n)?(Math.round(n*100)/100).toFixed(2):'0.00'}

function render(){
 if(!order)return;
 if(Array.isArray(historyChoices)&&historyChoices.length>1){
  $('orderDate').textContent=targetDate||'历史运单';
  document.querySelector('.order-shell')?.classList.add('history-multi');
  const totalStores=historyChoices.reduce((n,x)=>n+(Number(x.summary?.total)|| (Array.isArray(x.stores)?x.stores.length:0)),0);
  $('storeCount').textContent=totalStores;
  $('summaryUnit').textContent='家';
  $('totalWeight').textContent=fmtWeight(historyChoices.reduce((n,x)=>n+(Number(x.totalWeight)||0),0));
  $('metrics').innerHTML='';
  $('routeName').textContent=routeText(order.routeName);
  $('menuRoute').textContent=routeText(order.routeName);
  $('vehicle').textContent='';
  $('routeList').innerHTML=historyChoices.map((x,i)=>{
    const s=x.summary||{},confirmed=x.stage==='CONFIRMED';
    // 状态角标可见：此前 stage 只算不用，用户看不出哪张是「待确认」，删除失败时无从判断
    const status='<span class="history-choice-status '+(confirmed?'ok':'wait')+'">'+(confirmed?'已确认':'待确认')+'</span>';
    return '<div class="order-history-swipe-row" data-history-index="'+i+'"><button type="button" class="order-history-choice"><span class="history-choice-index">'+(i+1)+'</span><span class="history-choice-vehicle">'+esc(cleanVehicle(x.vehicle))+'</span><span class="history-choice-main">'+Number(s.total||x.stores?.length||0)+'家 · '+fmtWeight(x.totalWeight)+'t</span>'+status+'</button><button type="button" class="history-choice-delete" aria-label="删除运单">删除</button></div>';
  }).join('');
  $('routeList').querySelectorAll('.order-history-swipe-row').forEach(row=>{
    const b=row.querySelector('.order-history-choice');
    b.onclick=()=>{
      // 行处于展开（露出删除）状态时，点击卡片只收起，避免误进入详情
      if(row.classList.contains('open')){row.classList.remove('open');return}
      const x=historyChoices[Number(row.dataset.historyIndex)];
      historyChoices=null;order=x;render();
    };
    row.querySelector('.history-choice-delete').onclick=async e=>{
      e.stopPropagation();
      const index=Number(row.dataset.historyIndex),x=historyChoices[index];
      // ⚠ 按钮引用必须在 await 之前取：事件派发结束后 e.currentTarget 会被置空，
      // await 之后再读就是 null，btn.disabled=true 直接抛 TypeError，
      // 请求还没发出就整个崩掉（删除"点了没反应"的第二个根因）。
      const btn=e.currentTarget;
      // 缺少运单标识时明确提示，避免"点了没反应"
      if(!x?.id){zpToast('该运单缺少标识，无法删除','error');return}
      if(!(await zpConfirm('删除运单','确定删除这张运单吗？删除后无法恢复。','删除')))return;
      if(!btn)return;
      btn.disabled=true;btn.textContent='删除中…';
      try{
        const date=x.date||targetDate||'';
        // 显式带上 routeId：后端虽能用当前线路兜底，显式传可避免跨线路误判
        const routeId=x.routeId||order?.routeId||'';
        const q='/api/history?date='+encodeURIComponent(date)+'&waybillId='+encodeURIComponent(x.id)+(routeId?'&routeId='+encodeURIComponent(routeId):'');
        const r=await fetch(q,{method:'DELETE',credentials:'same-origin',cache:'no-store'});
        const d=await r.json().catch(()=>({}));
        if(!r.ok||!d.success)throw Error(d.error||'删除失败');
        historyChoices=historyChoices.filter((_,n)=>n!==index);
        if(historyChoices.length>1){render();return}
        if(historyChoices.length===1){order=historyChoices[0];historyChoices=null;render();return}
        historyChoices=null;order=null;
        $('orderDate').textContent=targetDate||'历史运单';
        $('storeCount').textContent='0';$('summaryUnit').textContent='张';$('totalWeight').textContent='0.00';$('metrics').innerHTML='';
        $('routeName').textContent='—';$('vehicle').textContent='—';$('routeList').innerHTML='<div class="order-empty">暂无配送数据</div>';
      }catch(err){btn.disabled=false;btn.textContent='删除';zpToast(err.message||'删除失败','error')}
    };
  });
  const old=$('confirmPendingBtn');if(old)old.remove();
  return;
 }
 document.querySelector('.order-shell')?.classList.remove('history-multi');
 const s=order.summary||{}, stores=Array.isArray(order.stores)?order.stores:[], pending=stores.filter(x=>x?.pending);
 $('orderDate').textContent=order.date||'日期待确认';
 $('pageTitle')?.replaceChildren(document.createTextNode('运单详情'));
 $('storeCount').textContent=Number(s.total)||stores.length||0;
 $('totalWeight').textContent=fmtWeight(order.totalWeight);
 $('routeName').textContent=order.routeName||'—';
 $('menuRoute').textContent=order.routeName||'当前线路';
 $('vehicle').textContent=vehicleText(order.vehicle).replace(/^车辆\s*/,'')||'—';
 const metrics=[];
 if(Number(s.original)&&Number(s.original)!==Number(s.total))metrics.push('原始'+s.original+'家');
 if(Number(s.correction)>0)metrics.push('更正'+s.correction+'家');
 if(Number(s.merged)>0)metrics.push('合并'+s.merged+'家');
 if(Number(s.newStores)>0)metrics.push('新增'+s.newStores+'家');
 if(pending.length)metrics.push('待定'+pending.length+'家');
 $('metrics').innerHTML=metrics.map(x=>'<span>'+esc(x)+'</span>').join('');
 $('routeList').innerHTML=stores.length?stores.map((x,i)=>{
   const name=esc(x.name||x.rawName||'未识别门店'), nav=safeUrl(navOf(x));
   const status=x.pending?'<span class="order-store-status pending">待确认</span>':(x.matchMethod==='confirmed-new'||x.isNew?'<span class="order-store-status">新增</span>':'');
   const nameHtml=nav?'<a class="order-store-name nav" href="'+attr(nav)+'" target="_self">'+name+status+'</a>':'<div class="order-store-name">'+name+status+'</div>';
   // 待定门店：优先展示候选建议及置信度，并说明未自动匹配的原因，便于用户快速判断。
   const REASON_TEXT={no_candidate:'基准库中无相近门店',below_threshold:'相似度不足，请确认',ambiguous:'存在多个相近门店，请选择'};
   let note='';
   if(x.pending){
     const c0=Array.isArray(x.candidates)?x.candidates[0]:null;
     const reason=x.matchDiagnostics?.reason;
     const reasonText=reason?REASON_TEXT[reason]||'': '';
     if(c0&&c0.name){
       note='建议匹配：'+c0.name+(c0.score!=null?'（'+(Math.round(c0.score*100))+'%）':'')+(reasonText?'，'+reasonText:'');
     }else{
       note=reasonText||'无相近门店，请选择合并或新增';
     }
   }else{
     note=x.note||x.remark||'';
   }
   const noteHtml=note?'<span class="order-store-note-inline">（'+esc(note)+'）</span>':'';
   const nameHtmlWithNote=nav?'<a class="order-store-name nav" href="'+attr(nav)+'" target="_self">'+name+noteHtml+status+'</a>':'<div class="order-store-name">'+name+noteHtml+status+'</div>';
   return '<div class="order-store-item"><span class="order-store-index">'+String(i+1).padStart(2,'0')+'</span><div class="order-store-main">'+nameHtmlWithNote+'</div></div>';
 }).join(''):'<div class="order-empty">当日暂无配送数据</div>';
 const old=$('confirmPendingBtn');if(old)old.remove();
 if(pending.length){const b=document.createElement('button');b.id='confirmPendingBtn';b.type='button';b.className='order-pending-fab';b.textContent='待确认'+pending.length+'家';b.onclick=openConfirm;const slot=$('pendingBtnSlot');slot?slot.appendChild(b):document.body.appendChild(b)}
}

function setMenu(open){menuOpen=open;$('menuPanel').hidden=!open;$('menuBtn').setAttribute('aria-expanded',String(open))}
function routeText(v){const s=String(v??'').trim();if(!s)return'—';return /号线$/.test(s)?s:(/^\d+$/.test(s)?s+'号线':s)}
function bindHistoryGestures(){
 const list=$('routeList');if(!list||list._historyGestureBound)return;
 list._historyGestureBound=true;
  let state=null;
  const closeRows=row=>list.querySelectorAll('.order-history-swipe-row.open').forEach(x=>{if(x!==row)x.classList.remove('open')});
  // 与历史列表页（js/history.js）保持一致：点击空白处收起已展开的行
  document.addEventListener('click',e=>{if(!e.target.closest('.order-history-swipe-row'))closeRows(null)});
 list.addEventListener('pointerdown',e=>{
   const r=e.target.closest('.order-history-swipe-row');if(!r)return;
   // 落点在行内按钮（删除）上时完全不介入：既不做手势判定，也绝不捕获指针
   if(e.target.closest('.history-choice-delete')){state=null;return}
   state={row:r,id:e.pointerId,x:e.clientX,y:e.clientY,swiping:false,moved:false};
   // ⚠ 这里不能调 setPointerCapture。一旦在 pointerdown 阶段捕获指针，
   // 浏览器会把后续的 mousedown / mouseup / click 一并重定向到捕获元素（整行），
   // 行内按钮的 onclick 永远收不到 click —— 这正是「删除按钮失效」的根因。
   // 捕获推迟到确认是横向滑动之后再做（见下方 pointermove）。
 },{passive:true});
 list.addEventListener('pointermove',e=>{
   if(!state||e.pointerId!==state.id)return;
   const dx=e.clientX-state.x,dy=e.clientY-state.y;
   if(Math.abs(dx)<6&&Math.abs(dy)<6)return;
   state.moved=true;
   if(Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>10){
     if(!state.swiping){
       state.swiping=true;
       // 仅在判定为横向滑动后才捕获，保证手指滑出行外仍能收到 pointerup
       try{state.row.setPointerCapture?.(e.pointerId)}catch{}
     }
     e.preventDefault();
   }
 },{passive:false});
 list.addEventListener('pointerup',e=>{
   if(!state||e.pointerId!==state.id)return;
   const s=state;state=null;
   const dx=e.clientX-s.x,dy=e.clientY-s.y;
   if(Math.abs(dx)<45||Math.abs(dx)<=Math.abs(dy))return;
   if(dx<0){
     closeRows(s.row);
     s.row.classList.add('open');
     s.row._suppressClick=true;
     setTimeout(()=>{s.row._suppressClick=false},350);
   }else{
     s.row.classList.remove('open');
     s.row._suppressClick=true;
     setTimeout(()=>{s.row._suppressClick=false},350);
   }
 },{passive:true});
 list.addEventListener('pointercancel',()=>{state=null},{passive:true});
 list.addEventListener('click',e=>{
   const row=e.target.closest('.order-history-swipe-row');if(!row)return;
   if(row._suppressClick){e.preventDefault();e.stopImmediatePropagation();}
 },true);
}
async function load(){
 const url=id
  ?'/api/waybills/latest?id='+encodeURIComponent(id)
  :(source==='today'&&targetDate
    ?'/api/history?date='+encodeURIComponent(targetDate)
    :(source==='today'?'/api/waybills/latest?confirmed=1':'/api/waybills/latest'));
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),12000);
 try{
  const r=await fetch(url,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.success||(!d.waybill&&!Array.isArray(d.waybills)))throw Error(d.error||'暂无当日运单');
  if(source==='today'&&targetDate&&Array.isArray(d.waybills)&&d.waybills.length){
    historyChoices=d.waybills;
    order=d.waybills[0];
  }else{
    historyChoices=null;order=d.waybill;
  }
  render();
  bindHistoryGestures();
 }catch(e){
  if(e?.name==='AbortError')throw Error('运单读取超时，请重试');
  throw e;
 }finally{clearTimeout(timer)}
}

// 待定门店的"指定已有门店"入口需要线路基准库；按线路缓存，同一张运单多次打开只读一次
async function loadBaseStores(routeId){
 if(baseStoreCache&&baseStoreRoute===routeId)return baseStoreCache;
 const r=await fetch('/api/base?routeId='+encodeURIComponent(routeId),{credentials:'same-origin',cache:'no-store'});
 const d=await r.json().catch(()=>({}));
 if(!r.ok||!d.success)throw Error(d.error||'线路数据资料读取失败');
 const stores=Array.isArray(d.base?.stores)?d.base.stores:[];
 baseStoreRoute=routeId;baseStoreCache=stores;
 return stores;
}

function openConfirm(){
 const pending=order?.stores?.map((x,i)=>({x,i})).filter(v=>v.x?.pending)||[];
 const list=$('pendingList'), selected=new Map();list.innerHTML='';
 const updateSubmit=()=>{$('submitConfirm').disabled=selected.size!==pending.length;$('submitConfirm').textContent=selected.size===pending.length?'确认':'确认（'+selected.size+'/'+pending.length+'）'};
 // 临时线路（routeId=__temp__:<userId>）不建立线路数据资料，没有"已有门店"可指定，此时只保留「新增」
 const isTempRoute=String(order?.routeId||"").startsWith("__temp__:");
 // 待定原因文案：让用户明白系统为何没有自动匹配，而不是面对无解释的"待确认"
 const REASON_TEXT={no_candidate:'基准库中没有相近门店，请选择新增或指定已有门店',below_threshold:'相似度不足，请确认是否为同一门店',ambiguous:'存在多个相近门店，请人工选择'};
 pending.forEach(({x,i})=>{
   const box=document.createElement('div');box.className='pending-box';
   const title=document.createElement('div');title.className='pending-title';title.textContent='待确认：'+(x.rawName||x.name||'未识别门店');box.appendChild(title);
   const candidates=Array.isArray(x.candidates)?x.candidates:[];
   const reason=x.matchDiagnostics?.reason;
   const hint=document.createElement('div');hint.className='pending-hint';
   if(isTempRoute&&reason==='no_candidate'){
     hint.textContent='临时线路没有线路数据资料，请直接新增该门店。';
   }else if(reason==='no_candidate'){
     hint.textContent='基准库中没有相近门店，请选择新增，或从已有门店中指定。';
   }else if(candidates.length){
     const top=candidates[0];
     const pct=top.score!=null?Math.round(top.score*100)+'%':'';
     hint.textContent='建议合并到「'+(top.name||'')+'」'+(pct?'（相似度 '+pct+'）':'')+'。'+(reason==='ambiguous'?'存在多个相近门店，请仔细选择。':'如确为同一门店请选择合并。');
   }else{
     hint.textContent=REASON_TEXT[reason]||'请选择合并到已有门店，或作为新增门店。';
   }
   box.appendChild(hint);
   const choices=document.createElement('div');choices.className='candidate-list';
   const autoSelectTop=()=>{if(candidates[0]&&!selected.has(i)){selected.set(i,{action:'merge',storeId:candidates[0].storeId,standardName:candidates[0].name});return true}return false};
   const normStore=v=>String(v||'').replace(/[\u3000\s]+/g,'').replace(/[（）()【】\[\]{}<>《》“”"'‘’]/g,'').replace(/[·•、,，。；;:：!！?？\-_—]/g,'').toLowerCase();
   const PICK_LABEL='从已有门店中指定…';
   // 所有选项共用一个"清空选中"逻辑，保证候选 / 新增 / 指定三种入口互斥
   let pickBtn=null;
   const clearChoice=()=>{[...choices.children].forEach(e=>e.classList.remove('selected'));if(pickBtn)pickBtn.textContent=PICK_LABEL};
   candidates.forEach((c,ci)=>{
     const b=document.createElement('button');b.type='button';b.className='choice-btn';
     const pct=c.score!=null?Math.round(c.score*100)+'%':'';
     b.textContent='合并：'+(c.name||c.storeId||'未命名门店')+(pct?' · 相似度 '+pct:'');
     if(ci===0)b.classList.add('recommended');
     b.onclick=()=>{selected.set(i,{action:'merge',storeId:c.storeId,standardName:c.name});clearChoice();b.classList.add('selected');updateSubmit()};
     choices.appendChild(b);
   });
   const pickWrap=document.createElement('div');pickWrap.className='pending-picker';pickWrap.hidden=true;
   const pickOpts=document.createElement('div');pickOpts.className='pending-options';
   // 轻量相似度：完全相等 > 互相包含（子串≥4字，覆盖 OCR 漏字/多前缀）> 双字组重合（Dice）
   const simScore=(a,b)=>{
     if(!a||!b)return 0;
     if(a===b)return 1;
     if((a.includes(b)||b.includes(a))&&Math.min(a.length,b.length)>=4)return .9;
     const bg=s=>{const r=new Set();for(let k=0;k<s.length-1;k++)r.add(s.slice(k,k+2));return r};
     const A=bg(a),B=bg(b);let n=0;A.forEach(g=>{if(B.has(g))n++});
     return A.size&&B.size?2*n/(A.size+B.size):0;
   };
   // 与待确认门店名的匹配度：标准名 / 原始名 / 别名取最高分（归一已忽略空格与断行）
   const pendingName=normStore(x.rawName||x.name||'');
   const storeScore=s=>{
     let best=simScore(pendingName,normStore(s.name));
     best=Math.max(best,simScore(pendingName,normStore(s.originalName)));
     (Array.isArray(s.aliases)?s.aliases:[]).forEach(al=>{best=Math.max(best,simScore(pendingName,normStore(al)))});
     return best;
   };
   const SIM_HOT=.5;// 达到该值的门店标"推荐/最佳匹配"，未达到时保持线路原顺序，避免误导
   // 展开即显示按匹配度排序的门店列表（无搜索框），点一下完成选择
   const renderPickOpts=()=>{
     const scored=(baseStoreCache||[]).map((s,si)=>({s,si,sc:storeScore(s)}));
     // 匹配度最高的排最前；同分保持线路原有顺序
     scored.sort((a,b)=>b.sc-a.sc||a.si-b.si);
     pickOpts.innerHTML='';
     if(!scored.length){const em=document.createElement('div');em.className='pending-empty';em.textContent='本线路暂无门店数据，可改用「新增」';pickOpts.appendChild(em);return}
     scored.slice(0,40).forEach((v,hi)=>{
       const s=v.s,sc=v.sc;
       const nm=s.name||s.originalName||'未命名门店';
       const ob=document.createElement('button');ob.type='button';ob.className='choice-btn';
       if(sc>=SIM_HOT)ob.classList.add('recommended');
       if(hi===0&&sc>=SIM_HOT){const bd=document.createElement('span');bd.className='pick-badge';bd.textContent='最佳匹配';ob.appendChild(bd)}
       const parts=['指定：'+nm];
       if(sc>=SIM_HOT)parts.push('相似度 '+Math.round(sc*100)+'%');
       if(s.routeOrder)parts.push('第'+s.routeOrder+'站');
       ob.appendChild(document.createTextNode(parts.join(' · ')));
       ob.onclick=()=>{clearChoice();pickBtn.classList.add('selected');pickBtn.textContent='指定：'+nm;selected.set(i,{action:'merge',storeId:s.storeId,standardName:nm});pickWrap.hidden=true;updateSubmit()};
       pickOpts.appendChild(ob);
     });
     if(scored.length>40){const more=document.createElement('div');more.className='pending-empty';more.textContent='门店较多，仅显示前 40 家（已按相似度排序）';pickOpts.appendChild(more)}
   };
   pickWrap.appendChild(pickOpts);
   pickBtn=document.createElement('button');pickBtn.type='button';pickBtn.className='choice-btn';pickBtn.textContent=PICK_LABEL;
   pickBtn.onclick=async()=>{
     if(!pickWrap.hidden){pickWrap.hidden=true;return}
     pickWrap.hidden=false;pickBtn.textContent=PICK_LABEL;
     if(baseStoreRoute!==order.routeId||!baseStoreCache){
       pickOpts.innerHTML='';const ld=document.createElement('div');ld.className='pending-empty';ld.textContent='正在读取本线路门店…';pickOpts.appendChild(ld);
       try{await loadBaseStores(order.routeId);renderPickOpts()}
       catch(err){pickOpts.innerHTML='';const er=document.createElement('div');er.className='pending-empty';er.textContent=(err.message||'读取失败')+'，可改用「新增」';pickOpts.appendChild(er)}
       return;
     }
     renderPickOpts();
   };
   const add=document.createElement('button');add.type='button';add.className='choice-btn';add.textContent='新增：'+(x.rawName||x.name||'该门店');
   add.onclick=()=>{selected.set(i,{action:'new',standardName:x.rawName||x.name});clearChoice();add.classList.add('selected');updateSubmit()};
   choices.appendChild(add);
   if(!isTempRoute){choices.appendChild(pickBtn);box.appendChild(pickWrap)}
   box.appendChild(choices);list.appendChild(box);
   // 有唯一且高分建议时预选，用户只需确认；多个候选时不预选，强制人工判断
   if(candidates.length===1&&candidates[0].score!=null&&candidates[0].score>=0.80){
     if(autoSelectTop()){const first=choices.querySelector('.choice-btn');if(first&&!first.classList.contains('selected'))first.classList.add('selected')}
   }
 });
 updateSubmit();$('confirmDialog').hidden=false;
 $('submitConfirm').onclick=async()=>{
   if(selected.size!==pending.length)return;
   const btn=$('submitConfirm');btn.disabled=true;btn.textContent='正在确认…';
   try{
     const confirmations=pending.map(v=>({index:v.i,...selected.get(v.i)}));
     const r=await fetch('/api/waybills/confirm',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({waybillId:order.id,confirmations,confirmRequestId:crypto.randomUUID()})});
     const d=await r.json().catch(()=>({}));if(!r.ok||!d.success)throw Error(d.error||'确认失败');
     order=d.waybill;$('confirmDialog').hidden=true;render();
   }catch(e){btn.disabled=false;btn.textContent='确认';zpToast(e.message||'确认失败','error')}
 };
}

const backToHome=()=>{setMenu(false);location.replace('/home.html')};
const backToPrevious=()=>{
  setMenu(false);
  const ref=document.referrer||"";
  let sameOrigin=false;
  try{sameOrigin=!!ref&&new URL(ref,location.href).origin===location.origin}catch{}
  if(sameOrigin&&history.length>1){history.back();return}
  location.replace('/home.html');
};
if(document.body.dataset.backHome==="true"){
  history.pushState({zhipeiOneOrderDetail:true},'',location.href);
  window.addEventListener('popstate',()=>backToHome());
  $('backBtn').onclick=backToHome;
}else{
  $('backBtn').onclick=backToPrevious;
}
$('menuBtn').onclick=e=>{e.stopPropagation();setMenu(!menuOpen)};
$('editRouteBtn').onclick=()=>location.href='/pages/data.html';
$('shareBtn').onclick=async()=>{
 setMenu(false);if(!order)return;
 const s=order.summary||{},text='智配One\n'+(order.date||'')+'\n'+(order.routeName||'当前线路')+'\n'+(s.total||order.stores?.length||0)+'家 · '+fmtWeight(order.totalWeight)+'t';
 try{if(navigator.share)await navigator.share({title:'当日运单',text});else{await navigator.clipboard?.writeText(text);zpToast('已复制运单摘要','success')}}catch{}
};
$('logoutBtn').onclick=async()=>{setMenu(false);if(!(await zpConfirm('退出登录','确定退出当前账号吗？')))return;try{await fetch('/api/logout',{method:'POST',credentials:'same-origin',cache:'no-store'})}finally{location.replace('/')}};
$('closeConfirm').onclick=()=>$('confirmDialog').hidden=true;
$('cancelConfirm').onclick=()=>$('confirmDialog').hidden=true;
$('confirmDialog').addEventListener('click',e=>{if(e.target===$('confirmDialog'))$('confirmDialog').hidden=true});
document.addEventListener('click',e=>{if(menuOpen&&!$('menuPanel').contains(e.target)&&e.target!==$('menuBtn'))setMenu(false)});
(async()=>{
  try{
    await load();
  }catch(e){
    $('orderDate').textContent='运单读取失败';
    $('storeCount').textContent='0';
    $('summaryUnit').textContent='家';
    $('totalWeight').textContent='0.00';
    $('metrics').innerHTML='';
    $('routeName').textContent=e.message||'暂无当日运单';
    $('vehicle').textContent='—';
    $('routeList').innerHTML='<div class="order-empty">'+esc(e.message||'暂无当日运单')+'</div>';
  }
})();
})();