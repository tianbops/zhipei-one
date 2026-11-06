'use strict';

/* 门店导航目标：见 js/ui/mapnav.js（地图链接直传 / 门店名走高德搜索） */
function navTarget(x){try{return window.zpMapNav&&window.zpMapNav.linkAttrs?window.zpMapNav.linkAttrs(x):null}catch(e){return null}}

function render(){
 if(!order)return;
 if(Array.isArray(historyChoices)&&historyChoices.length>1){
  $('orderDate').textContent=targetDate||'历史运单';
  document.querySelector('.order-shell')?.classList.add('history-multi');
  const totalStores=historyChoices.reduce((n,x)=>n+(Number(x.summary?.finalCount)||Number(x.summary?.total)|| (Array.isArray(x.stores)?x.stores.length:0)),0);
  $('storeCount').textContent=totalStores;
  $('summaryUnit').textContent='家';
  $('totalWeight').textContent=fmtWeight(historyChoices.reduce((n,x)=>n+(Number(x.totalWeight)||0),0));
  $('metrics').innerHTML='';
  $('routeName').textContent=routeText(order.routeName);
  $('vehicle').textContent='';
  $('driver').textContent='';
  $('deliveryPerson').textContent='';
  $('routeList').innerHTML=historyChoices.map((x,i)=>{
    const s=x.summary||{},confirmed=x.stage==='CONFIRMED';
    // 状态角标可见：此前 stage 只算不用，用户看不出哪张是「待确认」，删除失败时无从判断
    const status='<span class="history-choice-status '+(confirmed?'ok':'wait')+'">'+(confirmed?'已确认':'待确认')+'</span>';
    const drv=personName(x.driver),dp=personName(x.deliveryPerson);
    return '<div class="order-history-swipe-row" data-history-index="'+i+'"><button type="button" class="order-history-choice"><span class="history-choice-index">'+(i+1)+'</span><span class="history-choice-vehicle">'+esc(cleanVehicle(x.vehicle))+(drv?' · 司机 '+esc(drv):'')+(dp?' · 送货员 '+esc(dp):'')+'</span><span class="history-choice-main">'+(Number(s.finalCount)||Number(s.total)||(Array.isArray(x.stores)?x.stores.length:0))+'家 · '+fmtWeight(x.totalWeight)+'t</span>'+status+'</button><button type="button" class="history-choice-delete" aria-label="删除运单">删除</button></div>';
  }).join('');
  $('routeList').querySelectorAll('.order-history-swipe-row').forEach(row=>{
    const b=row.querySelector('.order-history-choice');
    if(b)b.onclick=()=>{
      // 行处于展开（露出删除）状态时，点击卡片只收起，避免误进入详情
      if(row.classList.contains('open')){row.classList.remove('open');return}
      const x=historyChoices[Number(row.dataset.historyIndex)];
      historyChoices=null;order=x;render();
    };
    const deleteButton=row.querySelector('.history-choice-delete');
    if(deleteButton)deleteButton.onclick=async e=>{
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
        // 当天运单已删空：此刻按返回不能再回跳到 order_detail?id=<已删除> 或
        // history?date=<已删日期>（只会落到空态/空列表），标记为失效直接回本区根。
        window.zpMarkStale?.();
        $('orderDate').textContent=targetDate||'历史运单';
        $('storeCount').textContent='0';$('summaryUnit').textContent='张';$('totalWeight').textContent='0.000';$('metrics').innerHTML='';
        $('routeName').textContent='—';$('vehicle').textContent='—';$('driver').textContent='—';$('deliveryPerson').textContent='—';$('routeList').innerHTML='<div class="zp-empty">暂无配送数据</div>';
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
 $('storeCount').textContent=Number(s.finalCount)||Number(s.total)||stores.length||0;
 $('totalWeight').textContent=fmtWeight(order.totalWeight);
 $('routeName').textContent=routeText(order.routeName)||'—';
 $('vehicle').textContent=vehicleText(order.vehicle).replace(/^车辆\s*/,'')||'—';
 $('driver').textContent=personName(order.driver)||'—';
 $('deliveryPerson').textContent=personName(order.deliveryPerson)||'—';
 const metrics=[];
 if(Number(s.recoveredCount)>0)metrics.push('恢复'+s.recoveredCount+'家');
 if(Number(s.correction)>0)metrics.push('更正'+s.correction+'家');
 if(Number(s.merged)>0)metrics.push('合并'+s.merged+'家');
 if(Number(s.newStores)>0)metrics.push('新增'+s.newStores+'家');
 if(pending.length)metrics.push('待定'+pending.length+'家');
 // 质量门只做提示不硬阻断；但 REVIEW 不能在详情页被用户误认为“完全正常”。
 if(order.quality?.level==='REVIEW')metrics.push('需复核');
 $('metrics').innerHTML=metrics.map(x=>'<span>'+esc(x)+'</span>').join('');
 $('routeList').innerHTML=stores.length?stores.map((x,i)=>{
   /* 显示名优先取基准库投影的简称（displayName），没有简称时回退运单全名 */
   const rawName=String(x.displayName||'').trim()||String(x.name||'').trim()||String(x.rawName||'').trim()||String(x.originalName||'').trim()||'未识别门店';
   const nav=navTarget(x);
   const status=x.pending?'<span class="order-store-status pending">待确认</span>':(x.matchMethod==='confirmed-new'||x.isNew?'<span class="order-store-status">新增</span>':'');
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
   /* 名称走「单行 + 左滑看全名」：结构样式与交互见 css/ui-base.css、js/ui/store-name-scroll.js。
      状态徽标固定在右侧不随滑动移动；备注（仅待确认）另起一行小字，不挤占名称宽度。 */
   const noteHtml=note?'<span class="order-store-note">'+esc(note)+'</span>':'';
   const lineHtml='<span class="order-store-line">'+window.zpStoreNameHtml(rawName)+status+'</span>'+noteHtml;
   const nameHtmlWithNote=nav?'<a class="order-store-name nav" href="'+attr(nav.url)+'" target="'+nav.target+'"'+(nav.rel?' rel="'+nav.rel+'"':'')+' data-zp-nav="'+attr(nav.kind)+'" data-zp-nav-name="'+attr(rawName)+'" data-zp-nav-payload="'+attr(nav.payload||'')+'">'+lineHtml+'</a>':'<div class="order-store-name">'+lineHtml+'</div>';
   return '<div class="order-store-item" data-zp-store-row><span class="order-store-index">'+String(i+1).padStart(2,'0')+'</span><div class="order-store-main">'+nameHtmlWithNote+'</div></div>';
 }).join(''):'<div class="zp-empty">当日暂无配送数据</div>';
 /* 名称容器每次渲染都是新 DOM：绑定只做一次，标记按实际宽度重算 */
 const storeListEl=$('routeList');
 window.zpBindStoreNameScroll(storeListEl);
 window.zpRefreshStoreNameScroll(storeListEl);
 const old=$('confirmPendingBtn');if(old)old.remove();
 if(pending.length){const b=document.createElement('button');b.id='confirmPendingBtn';b.type='button';b.className='order-pending-fab';b.dataset.zpHaptic='medium';b.textContent='待确认'+pending.length+'家';b.onclick=openConfirm;const slot=$('pendingBtnSlot');slot?slot.appendChild(b):document.body.appendChild(b)}
}
