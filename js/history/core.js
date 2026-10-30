"use strict";
const stateEl=document.getElementById("historyState"),listEl=document.getElementById("historyList"),dialog=document.getElementById("historyDialog"),dialogText=document.getElementById("historyDialogText"),cancelBtn=document.getElementById("historyCancel"),confirmBtn=document.getElementById("historyConfirm");
const picker=document.getElementById("historyPicker"),pickerPanel=document.querySelector(".history-picker-panel"),pickerClose=document.getElementById("historyPickerClose"),pickerTitle=document.getElementById("historyPickerTitle"),pickerGrid=document.getElementById("historyPickerGrid"),pickerPrev=document.getElementById("historyPickerPrev"),pickerNext=document.getElementById("historyPickerNext"),pickerBtn=document.getElementById("historyPickerBtn");
let model={history:[],range:null},openRow=null,pendingDelete=null,pickerMonth="";
/* 月份分组默认全部收起，且**同时只展开一个月**（手风琴）：点 10 月展开 → 点 9 月则收起 10 月、展开 9 月。
   展开的月份记在这里而不是 DOM 的 class 上：render() 会因删除 / 回收站恢复整体重绘，
   挂在 DOM 上的状态会丢（用户删一条记录，列表整个塌下去）。空串 = 全收起。 */
let expandedMonth="";
const focusDate=new URLSearchParams(location.search).get("date")||"";

const todayCN=()=>{const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const v=Object.fromEntries(p.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return `${v.year}-${v.month}-${v.day}`;};
const monthKey=d=>String(d).slice(0,7),monthLabel=m=>{const [y,mo]=m.split("-");return y+"年"+Number(mo)+"月"},dateLabel=d=>{const [y,m,day]=d.split("-");return Number(m)+"月"+Number(day)+"日"},fmtWeight=v=>(Math.round((Number(v)||0)*1000)/1000).toFixed(3)+"t",esc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function closeOpen(){if(openRow){openRow.classList.remove("swiped");const s=openRow.querySelector(".history-row-surface");if(s){s.style.transition="";s.style.transform=""}openRow=null}}
function openSwipe(row){if(openRow&&openRow!==row){openRow.classList.remove("swiped");const s=openRow.querySelector(".history-row-surface");if(s){s.style.transition="";s.style.transform=""}}row.classList.add("swiped");openRow=row}
const SWIPE_W=84;
function bindSwipe(row,onLeft){
 const surf=row.querySelector(".history-row-surface");
 let sx=0,sy=0,dx=0,dy=0,vx=0,base=0,moving=false,decided=false,dragged=false,painted=false,suppressUntil=0,t0=0;
 const clamp=v=>v>0?Math.min(24,v*.35):(v<-SWIPE_W?-SWIPE_W+(v+SWIPE_W)*.45:v);
 const paint=v=>{painted=true;surf.style.transition="none";surf.style.transform="translate3d("+v+"px,0,0)"};
 const clear=()=>{if(!painted)return;painted=false;surf.style.transition="";surf.style.transform=""};
 row.addEventListener("touchstart",e=>{
  if(e.touches.length>1){moving=false;dragged=false;clear();return}
  const t=e.touches[0];if(!t)return;
  sx=t.clientX;sy=t.clientY;dx=dy=vx=0;base=row.classList.contains("swiped")?-SWIPE_W:0;
  moving=true;decided=false;dragged=false;t0=Date.now();
 },{passive:true});
 row.addEventListener("touchmove",e=>{
  if(!moving)return;
  if(e.touches.length>1){moving=false;dragged=false;clear();return}
  const t=e.touches[0];if(!t)return;
  dx=t.clientX-sx;dy=t.clientY-sy;
  if(!decided){
   if(Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>8){moving=false;clear();return}
   if(Math.abs(dx)<10)return;
   decided=true;dragged=true;suppressUntil=Date.now()+400;
  }
  e.preventDefault();
  vx=dx/Math.max(1,Date.now()-t0);
  paint(clamp(base+dx));
 },{passive:false});
 const finish=e=>{
  if(!moving)return;
  if(e&&e.touches&&e.touches.length>0){moving=false;dragged=false;clear();return}
  moving=false;dragged=false;
  const far=decided&&(dx<-SWIPE_W*.5||(dx<-14&&vx<-.35));
  clear();
  if(far)onLeft();else{row.classList.remove("swiped");if(openRow===row)openRow=null}
 };
 row.addEventListener("touchend",finish);
 row.addEventListener("touchcancel",()=>{moving=false;dragged=false;clear()});
 row.addEventListener("click",e=>{
  if(e.target.closest(".history-delete"))return;
  if(Date.now()<suppressUntil){e.preventDefault();e.stopPropagation();closeOpen();return}
  if(row.classList.contains("swiped")){e.preventDefault();e.stopPropagation();closeOpen()}
 },true)
}