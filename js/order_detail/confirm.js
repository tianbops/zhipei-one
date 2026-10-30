'use strict';
/* 关闭「待确认」弹窗的唯一入口：提交在途时直接拒绝，只提示不关闭。 */
function closeConfirmDialog(){
  if(confirming){
    try{zpToast("正在保存，请稍候","error")}catch{}
    return;
  }
  $('confirmDialog').hidden=true;
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
   // 丢弃：该条目不是门店（运单号表格等 OCR 噪声、或拍错的残条）。
   // 此前只能「新增/合并」，遇到噪声会被迫建一个假门店或错误合并，只能取消整单。
   const drop=document.createElement('button');drop.type='button';drop.className='choice-btn';drop.textContent='丢弃（不是门店）';
   drop.onclick=()=>{selected.set(i,{action:'discard'});clearChoice();drop.classList.add('selected');updateSubmit();if(window.zpToast)window.zpToast('已标记为丢弃，提交后不会生成门店','info')};
   choices.appendChild(drop);
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
   confirming=true;
   try{
     const confirmations=pending.map(v=>({index:v.i,...selected.get(v.i)}));
     const r=await fetch('/api/waybills/confirm',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({waybillId:order.id,confirmations,confirmRequestId:crypto.randomUUID()})});
     const d=await r.json().catch(()=>({}));if(!r.ok||!d.success)throw Error(d.error||'确认失败');
     order=d.waybill;$('confirmDialog').hidden=true;render();
   }catch(e){btn.disabled=false;btn.textContent='确认';zpToast(e.message||'确认失败','error')}
   finally{confirming=false}
 };
}
