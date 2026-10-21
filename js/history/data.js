'use strict';
async function load(){
 try{
  const r=await zpFetch("/api/history",{credentials:"same-origin",cache:"no-store"});
  let text=await r.text(),d=null;
  try{d=JSON.parse(text)}catch{throw new Error(r.ok?"历史接口返回数据格式错误":"历史接口异常（HTTP "+r.status+"）")}
  if(!r.ok||!d?.success){const code=String(d?.code||("HTTP_"+r.status));const detail=String(d?.detail||"").trim();throw new Error(code+(detail?"："+detail:"："+(d?.error||"历史记录读取失败")))}
  model={history:Array.isArray(d.history)?d.history:[],range:d.range||null};
  render();
 }catch(e){
  console.error("[history] load failed",e);
  stateEl.textContent=e.message||"历史记录读取失败";
  // 离线时登记「重连后自动重取」（P1-4：只重放幂等 GET 刷新，按 key 去重）
  try{if(navigator.onLine===false&&window.zpOfflineQueue)window.zpOfflineQueue.scheduleRefresh("history",()=>load())}catch(_){}
 }
}
function askDelete(type,key,message){closeOpen();pendingDelete={type,key};dialogText.textContent=message;dialog.hidden=false;confirmBtn.disabled=false;confirmBtn.textContent="确定"}
function closeDialog(){dialog.hidden=true;pendingDelete=null}
cancelBtn.onclick=closeDialog;dialog.addEventListener("click",e=>{if(e.target===dialog)closeDialog()});pickerBtn.onclick=openPicker;pickerClose.onclick=()=>{picker.hidden=true};picker.addEventListener("click",e=>{if(e.target===picker)picker.hidden=true});function shiftMonth(delta){if(!model.range)return;const firstMonth=model.range.start.slice(0,7),lastMonth=model.range.end.slice(0,7),[y,m]=pickerMonth.split("-").map(Number),x=new Date(Date.UTC(y,m-1+delta,1));let next=x.toISOString().slice(0,7);if(next<firstMonth)next=firstMonth;if(next>lastMonth)next=lastMonth;if(next===pickerMonth)return;pickerMonth=next;renderPicker(delta)}
// 日历面板左右滑动切换月份：左滑=下一个月，右滑=上一个月；纵向滚动主导时不触发
(function bindPickerSwipe(){const el=pickerPanel;if(!el||el._swipeBound)return;el._swipeBound=true;let sx=0,sy=0,moving=false;el.addEventListener("touchstart",e=>{const t=e.touches[0];if(!t)return;sx=t.clientX;sy=t.clientY;moving=true},{passive:true});el.addEventListener("touchmove",e=>{if(!moving)return;const t=e.touches[0];if(!t)return;if(Math.abs(t.clientY-sy)>Math.abs(t.clientX-sx)&&Math.abs(t.clientY-sy)>10)moving=false},{passive:true});el.addEventListener("touchend",e=>{if(!moving)return;moving=false;const t=e.changedTouches[0];if(!t)return;const dx=t.clientX-sx,dy=t.clientY-sy;if(Math.abs(dx)<50||Math.abs(dx)<=Math.abs(dy))return;if(dx<0)shiftMonth(1);else shiftMonth(-1)},{passive:true})})();
pickerPrev.onclick=()=>shiftMonth(-1);pickerNext.onclick=()=>shiftMonth(1);
// P1-4b：删除为幂等写操作（按日期/月份；服务端对已删目标返回成功或 404）。
// 网络层失败时登记「重连后自动重放」，不再只能弹窗失败；重放成功后顺带刷新列表。
// 重放器约定：true=完成 / false=暂时性失败保留下次 / throw=业务性失败出队。
function netFail(e){return e instanceof TypeError}
async function replayDeleteDate(date){
 try{
  const r=await fetch("/api/history?date="+encodeURIComponent(date),{method:"DELETE",credentials:"same-origin"}),d=await r.json().catch(()=>null);
  if(!r.ok||!d?.success){if(r.status===404)return true;return false}
  try{window.zpOfflineQueue&&window.zpOfflineQueue.scheduleRefresh("history",()=>load())}catch(_){}
  return true;
 }catch(e){return false}
}
async function replayDeleteMonth(month){
 try{
  const r=await fetch("/api/history?month="+encodeURIComponent(month),{method:"DELETE",credentials:"same-origin"}),d=await r.json().catch(()=>null);
  if(!r.ok||!d?.success){if(r.status===404)return true;return false}
  try{window.zpOfflineQueue&&window.zpOfflineQueue.scheduleRefresh("history",()=>load())}catch(_){}
  return true;
 }catch(e){return false}
}
async function deleteDate(date){
 try{
  const r=await fetch("/api/history?date="+encodeURIComponent(date),{method:"DELETE",credentials:"same-origin"}),d=await r.json().catch(()=>null);
  if(!r.ok||!d?.success)throw new Error(d?.error||"删除失败");
 }catch(e){
  if(netFail(e)&&window.zpOfflineQueue&&window.zpOfflineQueue.scheduleWrite){
   window.zpOfflineQueue.scheduleWrite("history:delete:date:"+date,()=>replayDeleteDate(date));
   throw Object.assign(new Error("当前无网络，已登记联网后自动删除"),{offlineQueued:true});
  }
  throw e;
 }
}
async function deleteMonth(month){
 try{
  const r=await fetch("/api/history?month="+encodeURIComponent(month),{method:"DELETE",credentials:"same-origin"}),d=await r.json().catch(()=>null);
  if(!r.ok||!d?.success)throw new Error(d?.error||"删除失败");
 }catch(e){
  if(netFail(e)&&window.zpOfflineQueue&&window.zpOfflineQueue.scheduleWrite){
   window.zpOfflineQueue.scheduleWrite("history:delete:month:"+month,()=>replayDeleteMonth(month));
   throw Object.assign(new Error("当前无网络，已登记联网后自动删除"),{offlineQueued:true});
  }
  throw e;
 }
}
document.addEventListener("click",e=>{if(!e.target.closest(".history-swipe-row"))closeOpen()});(document.querySelector(".zp-scroll")||document).addEventListener("scroll",closeOpen,{passive:true});load();
/* 返回层级：删除确认弹窗 / 日历选择器 → 左滑展开行 → 页面导航 */
(window.zpBackHooks=window.zpBackHooks||[]).push(
  {rank:10,probe:()=>picker,close:()=>{picker.hidden=true;return true}},
  {rank:10,probe:()=>dialog,close:()=>{closeDialog();return true}},
  {rank:40,probe:()=>document.querySelector(".history-swipe-row.swiped"),close:()=>{closeOpen();return true}}
);