'use strict';
function routeText(v){const s=String(v??'').trim();if(!s)return'—';/* 全局标准：文本位置统一「X号线」 */if(window.zpRouteName)return window.zpRouteName(s)||'—';return /号线$/.test(s)?s:(/^\d+$/.test(s)?s+'号线':s)}
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