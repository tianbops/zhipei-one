(function(){
'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const attr=v=>esc(v).replace(/'/g,'&#39;');
const navOf=x=>String(x?.navigation||x?.nav||'').trim();
const params=new URLSearchParams(location.search), id=params.get('id')||'';
let order=null,menuOpen=false;

function safeUrl(v){try{const u=new URL(String(v||''),location.origin);return /^(https?:)$/.test(u.protocol)?u.href:''}catch{return''}}
function fmtWeight(v){const n=Number(v);return Number.isFinite(n)?(Math.round(n*100)/100).toFixed(2):'0.00'}

function render(){
 if(!order)return;
 const s=order.summary||{}, stores=Array.isArray(order.stores)?order.stores:[], pending=stores.filter(x=>x?.pending);
 $('orderDate').textContent=order.date||'日期待确认';
 $('storeCount').textContent=Number(s.total)||stores.length||0;
 $('totalWeight').textContent=fmtWeight(order.totalWeight);
 $('routeName').textContent=order.routeName||order.routeId||'当前线路';
 $('menuRoute').textContent=order.routeName||order.routeId||'当前线路';
 $('vehicle').textContent=order.vehicle?('车辆 '+order.vehicle):'';
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
   const nameHtml=nav?'<a class="order-store-name nav" href="'+attr(nav)+'" target="_blank" rel="noopener">'+name+status+'</a>':'<div class="order-store-name">'+name+status+'</div>';
   const note=x.pending&&Array.isArray(x.candidates)&&x.candidates[0]?.name?'建议匹配：'+x.candidates[0].name:(x.note||x.remark||'');
   return '<div class="order-store-item"><span class="order-store-index">'+String(i+1).padStart(2,'0')+'</span><div class="order-store-main">'+nameHtml+(note?'<div class="order-store-note">'+esc(note)+'</div>':'')+'</div></div>';
 }).join(''):'<div class="order-empty">当日暂无配送数据</div>';
 if(params.get('diagnostic')==='1'){$('diagnostics').hidden=false;$('diagnostics').textContent=JSON.stringify(order.diagnostics||{},null,2)}
 const old=$('confirmPendingBtn');if(old)old.remove();
 if(pending.length){const b=document.createElement('button');b.id='confirmPendingBtn';b.type='button';b.className='order-pending-fab';b.textContent='确认'+pending.length+'家待定门店';b.onclick=openConfirm;document.body.appendChild(b)}
}

function setMenu(open){menuOpen=open;$('menuPanel').hidden=!open;$('menuBtn').setAttribute('aria-expanded',String(open))}
async function load(){
 const url=id?'/api/waybills/latest?id='+encodeURIComponent(id):'/api/waybills/latest';
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),12000);
 try{
  const r=await fetch(url,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.success||!d.waybill)throw Error(d.error||'暂无当日运单');
  order=d.waybill;render();
 }catch(e){
  if(e?.name==='AbortError')throw Error('运单读取超时，请重试');
  throw e;
 }finally{clearTimeout(timer)}
}

function openConfirm(){
 const pending=order?.stores?.map((x,i)=>({x,i})).filter(v=>v.x?.pending)||[];
 const list=$('pendingList'), selected=new Map();list.innerHTML='';
 const updateSubmit=()=>{$('submitConfirm').disabled=selected.size!==pending.length;$('submitConfirm').textContent=selected.size===pending.length?'确认':'请完成全部选择'};
 pending.forEach(({x,i})=>{
   const box=document.createElement('div');box.className='pending-box';
   const title=document.createElement('div');title.className='pending-title';title.textContent='待确认：'+(x.rawName||x.name||'未识别门店');box.appendChild(title);
   const hint=document.createElement('div');hint.className='pending-hint';hint.textContent='请选择合并到已有门店，或作为新增门店。';box.appendChild(hint);
   const choices=document.createElement('div');choices.className='candidate-list';
   (Array.isArray(x.candidates)?x.candidates:[]).forEach(c=>{
     const b=document.createElement('button');b.type='button';b.className='choice-btn';b.textContent='合并：'+(c.name||c.storeId||'未命名门店')+(c.score!=null?' · 相似度 '+c.score:'');
     b.onclick=()=>{selected.set(i,{action:'merge',storeId:c.storeId,standardName:c.name});[...choices.children].forEach(e=>e.classList.remove('selected'));b.classList.add('selected');updateSubmit()};choices.appendChild(b);
   });
   const add=document.createElement('button');add.type='button';add.className='choice-btn';add.textContent='新增：'+(x.rawName||x.name||'该门店');
   add.onclick=()=>{selected.set(i,{action:'new',standardName:x.rawName||x.name});[...choices.children].forEach(e=>e.classList.remove('selected'));add.classList.add('selected');updateSubmit()};
   choices.appendChild(add);box.appendChild(choices);list.appendChild(box);
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
   }catch(e){btn.disabled=false;btn.textContent='确认';alert(e.message||'确认失败')}
 };
}

$('backBtn').onclick=()=>{setMenu(false);if(history.length>1)history.back();else location.replace('/home.html')};
$('menuBtn').onclick=e=>{e.stopPropagation();setMenu(!menuOpen)};
$('editRouteBtn').onclick=()=>location.href='/pages/data.html';
$('shareBtn').onclick=async()=>{
 setMenu(false);if(!order)return;
 const s=order.summary||{},text='智配One\n'+(order.date||'')+'\n'+(order.routeName||order.routeId||'当前线路')+'\n'+(s.total||order.stores?.length||0)+'家 · '+fmtWeight(order.totalWeight)+'t';
 try{if(navigator.share)await navigator.share({title:'当日运单',text});else{await navigator.clipboard?.writeText(text);alert('已复制运单摘要')}}catch{}
};
$('logoutBtn').onclick=async()=>{setMenu(false);if(!confirm('确定退出登录吗？'))return;try{await fetch('/api/logout',{method:'POST',credentials:'same-origin',cache:'no-store'})}finally{location.replace('/')}};
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
    $('totalWeight').textContent='0.00';
    $('metrics').innerHTML='';
    $('routeName').textContent=e.message||'暂无当日运单';
    $('vehicle').textContent='';
    $('routeList').innerHTML='<div class="order-empty">'+esc(e.message||'暂无当日运单')+'</div>';
  }
})();
})();