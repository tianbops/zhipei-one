'use strict';
// 顶部返回 与 Android 系统返回统一由 ui-unified.js 的 zpHandleBack() 处理，
// 这里只注册本页的返回层级：待确认子选择器 → 确认弹窗，由页面自身逻辑关闭。
(window.zpBackHooks=window.zpBackHooks||[]).push(
  {rank:10,probe:()=>document.querySelector('.pending-picker'),close:()=>{const p=document.querySelector('.pending-picker');if(p)p.hidden=true;return true}},
  // 待确认弹窗本身就是编辑态：有已选项未提交时，返回需先确认放弃
  {rank:10,probe:()=>$('confirmDialog'),dirty:()=>!!document.querySelector('#confirmDialog .choice-btn.selected'),close:()=>{closeConfirmDialog();return true}},
);
if($('shareBtn'))$('shareBtn').onclick=async()=>{
 if(!order)return;
 const s=order.summary||{},list=Array.isArray(order.stores)?order.stores:[];
 // 分享必须带完整门店清单：只发「N家·Xt」汇总，接收方看不到当天到底配送哪些店。
 // 门店没有单店重量字段（重量只有整单 totalWeight），故重量只出现在汇总行。
 const lines=['智配One',order.date||'',routeText(order.routeName||'当前线路'),(Number(s.finalCount)||Number(s.total)||list.length||0)+'家 · '+fmtWeight(order.totalWeight)+'t',''];
 list.forEach((x,i)=>{
  const name=String(x?.name||x?.rawName||'未识别门店').trim();
  lines.push(String(i+1).padStart(2,'0')+'  '+name+(x?.pending?'（待确认）':''));
 });
 const text=lines.join('\n');
 try{if(navigator.share)await navigator.share({title:'当日运单',text});else{await navigator.clipboard?.writeText(text);zpToast('已复制运单清单','success')}}catch{}
};
if($('closeConfirm'))$('closeConfirm').onclick=()=>closeConfirmDialog();
if($('cancelConfirm'))$('cancelConfirm').onclick=()=>closeConfirmDialog();
$('confirmDialog')?.addEventListener('click',e=>{if(e.target===$('confirmDialog'))closeConfirmDialog()});
(async()=>{
  try{
    await load();
  }catch(e){
    $('orderDate').textContent='运单读取失败';
    $('storeCount').textContent='0';
    $('summaryUnit').textContent='家';
    $('totalWeight').textContent='0.000';
    $('metrics').innerHTML='';
    $('routeName').textContent=e.message||'暂无当日运单';
    $('vehicle').textContent='—';
    $('routeList').innerHTML='<div class="zp-empty">'+esc(e.message||'暂无当日运单')+'</div>';
  }
})();