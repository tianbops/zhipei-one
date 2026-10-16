(()=>{"use strict";
const stateEl=document.getElementById("historyState"),listEl=document.getElementById("historyList"),dialog=document.getElementById("historyDialog"),dialogText=document.getElementById("historyDialogText"),cancelBtn=document.getElementById("historyCancel"),confirmBtn=document.getElementById("historyConfirm");
const picker=document.getElementById("historyPicker"),pickerPanel=document.querySelector(".history-picker-panel"),pickerClose=document.getElementById("historyPickerClose"),pickerTitle=document.getElementById("historyPickerTitle"),pickerGrid=document.getElementById("historyPickerGrid"),pickerPrev=document.getElementById("historyPickerPrev"),pickerNext=document.getElementById("historyPickerNext"),pickerBtn=document.getElementById("historyPickerBtn");
let model={history:[],range:null},openRow=null,pendingDelete=null,pickerMonth="";
const focusDate=new URLSearchParams(location.search).get("date")||"";
const searchForm=document.getElementById("historySearchForm"),searchInput=document.getElementById("historySearchInput"),searchMonths=document.getElementById("historySearchMonths"),searchState=document.getElementById("historySearchState"),searchResults=document.getElementById("historySearchResults");
let searchController=null;

const todayCN=()=>{const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const v=Object.fromEntries(p.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return `${v.year}-${v.month}-${v.day}`;};
const monthKey=d=>String(d).slice(0,7),monthLabel=m=>{const [y,mo]=m.split("-");return y+"年"+Number(mo)+"月"},dateLabel=d=>{const [y,m,day]=d.split("-");return Number(m)+"月"+Number(day)+"日"},fmtWeight=v=>(Math.round((Number(v)||0)*100)/100).toFixed(2)+"t",esc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function closeOpen(){if(openRow){openRow.classList.remove("swiped");openRow=null}}
function openSwipe(row){if(openRow&&openRow!==row)openRow.classList.remove("swiped");row.classList.add("swiped");openRow=row}
function bindSwipe(row,onLeft){let sx=0,sy=0,dx=0,dy=0,moving=false;row.addEventListener("touchstart",e=>{const t=e.touches[0];if(!t)return;sx=t.clientX;sy=t.clientY;dx=dy=0;moving=true},{passive:true});row.addEventListener("touchmove",e=>{if(!moving)return;const t=e.touches[0];if(!t)return;dx=t.clientX-sx;dy=t.clientY-sy;if(Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>8){moving=false;return}if(Math.abs(dx)>10)e.preventDefault()},{passive:false});row.addEventListener("touchend",()=>{if(!moving)return;moving=false;if(Math.abs(dx)<50||Math.abs(dx)<=Math.abs(dy))return;if(dx<0)onLeft();else closeOpen()});row.addEventListener("click",e=>{if(e.target.closest(".history-delete"))return;if(row.classList.contains("swiped")){e.preventDefault();closeOpen()}})}
function shell(kind,key){const row=document.createElement("div");row.className="history-swipe-row";row.dataset.kind=kind;row.dataset.key=key;const action=document.createElement("button");action.type="button";action.className="history-delete";action.textContent="删除";const surface=document.createElement("div");surface.className="history-row-surface";row.append(action,surface);bindSwipe(row,()=>openSwipe(row));return{row,surface,action}}
function renderPicker(dir){if(!model.range)return;const start=model.range.start,end=model.range.end,firstMonth=start.slice(0,7),lastMonth=end.slice(0,7);if(pickerMonth<firstMonth)pickerMonth=firstMonth;if(pickerMonth>lastMonth)pickerMonth=lastMonth;pickerTitle.textContent=monthLabel(pickerMonth);pickerPrev.disabled=pickerMonth<=firstMonth;pickerNext.disabled=pickerMonth>=lastMonth;pickerGrid.innerHTML="";const [y,m]=pickerMonth.split("-").map(Number),first=new Date(Date.UTC(y,m-1,1)),offset=first.getUTCDay(),days=new Date(Date.UTC(y,m,0)).getUTCDate(),data=new Map(model.history.map(x=>[x.date,true]));for(let i=0;i<offset;i++){const e=document.createElement("span");e.className="history-calendar-empty";pickerGrid.appendChild(e)}for(let day=1;day<=days;day++){const date=pickerMonth+"-"+String(day).padStart(2,"0"),b=document.createElement("button");b.type="button";b.textContent=day;const inRange=date>=start&&date<=end,has=data.has(date);b.disabled=!inRange||!has;b.className="history-calendar-day"+(has?" has-data":"");if(has)b.onclick=()=>{picker.hidden=true;location.href="/pages/order_detail.html?source=today&from=history&date="+encodeURIComponent(date)};pickerGrid.appendChild(b)}if(dir){const cls=dir<0?"cal-anim-left":"cal-anim-right";for(const el of [pickerTitle,pickerGrid]){el.classList.remove("cal-anim-left","cal-anim-right");void el.offsetWidth;el.classList.add(cls)}}}
function openPicker(){const today=todayCN();if(!model.range){const y=today.slice(0,4);model.range={start:y+"-01-01",end:today}}pickerMonth=focusDate.slice(0,7)||model.history[0]?.date?.slice(0,7)||today.slice(0,7);renderPicker();picker.hidden=false}
function render(){closeOpen();listEl.innerHTML="";const groups=new Map();for(const x of model.history){const m=monthKey(x.date);if(!groups.has(m))groups.set(m,[]);groups.get(m).push(x)}const ordered=[...groups.entries()].sort((a,b)=>b[0].localeCompare(a[0]));if(!ordered.length){stateEl.textContent="暂无历史记录";return}stateEl.textContent="";const now=todayCN(),currentMonth=monthKey(now);
ordered.forEach(([month,items])=>{items.sort((a,b)=>b.date.localeCompare(a.date));const totalWeight=items.reduce((n,x)=>n+(Number(x.totalWeight)||0),0),section=document.createElement("section");section.className="history-month";section.dataset.month=month;const h=shell("month",month),main=document.createElement("button");main.type="button";main.className="history-month-main";main.innerHTML="<span>"+esc(monthLabel(month))+"</span><small>"+items.length+"天 · "+fmtWeight(totalWeight)+"</small>";h.surface.appendChild(main);h.action.onclick=()=>askDelete("month",month,"确定删除"+monthLabel(month)+"全部历史记录吗？删除后可在回收站恢复（7天内）。");const body=document.createElement("div");body.className="history-month-body";section.classList.toggle("expanded",month===currentMonth);
main.onclick=()=>{if(h.row.classList.contains("swiped")){closeOpen();return}section.classList.toggle("expanded")};
items.forEach(item=>{const r=shell("date",item.date),dm=document.createElement("button");dm.type="button";dm.className="history-date-main";dm.innerHTML="<span>"+esc(dateLabel(item.date))+"</span><small>"+(Number(item.count||0)>1?"<b class=\"history-count-highlight\">"+Number(item.count)+"次</b> · ":"")+Number(item.storeCount||0)+"家 · "+fmtWeight(item.totalWeight)+"</small>";r.surface.appendChild(dm);dm.onclick=()=>{if(r.row.classList.contains("swiped")){closeOpen();return}location.href="/pages/order_detail.html?source=today&from=history&date="+encodeURIComponent(item.date)};r.action.onclick=()=>askDelete("date",item.date,"确定删除"+dateLabel(item.date)+"历史记录吗？删除后可在回收站恢复（7天内）。");body.appendChild(r.row)});section.append(h.row,body);listEl.appendChild(section)})}
function renderSearchResults(items,limited){
 searchResults.innerHTML="";
 searchResults.hidden=false;
 if(!items.length){searchResults.textContent="没有找到匹配的历史运单";return}
 const frag=document.createDocumentFragment();
 for(const item of items){
  const b=document.createElement("button");b.type="button";b.className="history-search-result";
  const title=document.createElement("strong");title.textContent=(item.date||"")+(item.routeName?" · "+item.routeName:"");
  const meta=document.createElement("span");meta.textContent=(Number(item.storeCount)||0)+" 家 · "+fmtWeight(item.totalWeight)+(item.vehicle?" · "+item.vehicle:"");
  const names=document.createElement("small");names.textContent=(item.storeNames||[]).join("、");
  b.append(title,meta,names);b.addEventListener("click",()=>{location.href="/pages/order_detail.html?source=today&from=history&date="+encodeURIComponent(item.date)});
  frag.appendChild(b);
 }
 searchResults.appendChild(frag);
 if(limited){const note=document.createElement("p");note.className="history-search-note";note.textContent="结果最多显示 100 条，请缩小关键词或时间范围。";searchResults.appendChild(note)}
}
async function runHistorySearch(event){
 if(event)event.preventDefault();
 const q=String(searchInput?.value||"").trim();
 if(!q){searchState.textContent="请输入姓名、电话、地址、运单号或门店关键词";searchResults.hidden=true;searchInput?.focus();return}
 if(searchController)searchController.abort();
 searchController=new AbortController();
 searchState.textContent="正在搜索…";searchResults.hidden=true;
 try{
  const params=new URLSearchParams({q,months:String(searchMonths?.value||"3")});
  const r=await fetch("/api/history?"+params.toString(),{credentials:"same-origin",cache:"no-store",signal:searchController.signal});
  const d=await r.json().catch(()=>null);
  if(!r.ok||!d?.success)throw new Error(d?.error||"历史搜索失败，请缩小时间范围后重试");
  renderSearchResults(Array.isArray(d.results)?d.results:[],!!d.limited);
  searchState.textContent="找到 "+Number(d.count||0)+" 条匹配记录 · "+(d.range?.start||"")+" 至 "+(d.range?.end||"");
 }catch(e){if(e?.name==="AbortError")return;searchState.textContent=e.message||"搜索失败，请稍后重试";searchResults.hidden=true}
}
searchForm?.addEventListener("submit",runHistorySearch);
searchInput?.addEventListener("input",()=>{if(!searchInput.value.trim()){searchState.textContent="";searchResults.hidden=true}});
async function load(){
 try{
  const r=await fetch("/api/history",{credentials:"same-origin",cache:"no-store"});
  let text=await r.text(),d=null;
  try{d=JSON.parse(text)}catch{throw new Error(r.ok?"历史接口返回数据格式错误":"历史接口异常（HTTP "+r.status+"）")}
  if(!r.ok||!d?.success){const code=String(d?.code||("HTTP_"+r.status));const detail=String(d?.detail||"").trim();throw new Error(code+(detail?"："+detail:"："+(d?.error||"历史记录读取失败")))}
  model={history:Array.isArray(d.history)?d.history:[],range:d.range||null};
  render();
 }catch(e){
  console.error("[history] load failed",e);
  stateEl.textContent=e.message||"历史记录读取失败";
 }
}
function askDelete(type,key,message){closeOpen();pendingDelete={type,key};dialogText.textContent=message;dialog.hidden=false;confirmBtn.disabled=false;confirmBtn.textContent="确定"}
function closeDialog(){dialog.hidden=true;pendingDelete=null}
cancelBtn.onclick=closeDialog;dialog.addEventListener("click",e=>{if(e.target===dialog)closeDialog()});pickerBtn.onclick=openPicker;pickerClose.onclick=()=>{picker.hidden=true};picker.addEventListener("click",e=>{if(e.target===picker)picker.hidden=true});function shiftMonth(delta){if(!model.range)return;const firstMonth=model.range.start.slice(0,7),lastMonth=model.range.end.slice(0,7),[y,m]=pickerMonth.split("-").map(Number),x=new Date(Date.UTC(y,m-1+delta,1));let next=x.toISOString().slice(0,7);if(next<firstMonth)next=firstMonth;if(next>lastMonth)next=lastMonth;if(next===pickerMonth)return;pickerMonth=next;renderPicker(delta)}
// 日历面板左右滑动切换月份：左滑=下一个月，右滑=上一个月；纵向滚动主导时不触发
(function bindPickerSwipe(){const el=pickerPanel;if(!el||el._swipeBound)return;el._swipeBound=true;let sx=0,sy=0,moving=false;el.addEventListener("touchstart",e=>{const t=e.touches[0];if(!t)return;sx=t.clientX;sy=t.clientY;moving=true},{passive:true});el.addEventListener("touchmove",e=>{if(!moving)return;const t=e.touches[0];if(!t)return;if(Math.abs(t.clientY-sy)>Math.abs(t.clientX-sx)&&Math.abs(t.clientY-sy)>10)moving=false},{passive:true});el.addEventListener("touchend",e=>{if(!moving)return;moving=false;const t=e.changedTouches[0];if(!t)return;const dx=t.clientX-sx,dy=t.clientY-sy;if(Math.abs(dx)<50||Math.abs(dx)<=Math.abs(dy))return;if(dx<0)shiftMonth(1);else shiftMonth(-1)},{passive:true})})();
pickerPrev.onclick=()=>shiftMonth(-1);pickerNext.onclick=()=>shiftMonth(1);
async function deleteDate(date){const r=await fetch("/api/history?date="+encodeURIComponent(date),{method:"DELETE",credentials:"same-origin"}),d=await r.json().catch(()=>null);if(!r.ok||!d?.success)throw new Error(d?.error||"删除失败")}
async function deleteMonth(month){const r=await fetch("/api/history?month="+encodeURIComponent(month),{method:"DELETE",credentials:"same-origin"}),d=await r.json().catch(()=>null);if(!r.ok||!d?.success)throw new Error(d?.error||"删除失败")}
confirmBtn.onclick=async()=>{if(!pendingDelete)return;const job=pendingDelete;confirmBtn.disabled=true;confirmBtn.textContent="删除中…";try{if(job.type==="date")await deleteDate(job.key);else await deleteMonth(job.key);closeDialog();await load()}catch(e){confirmBtn.disabled=false;confirmBtn.textContent="确定";dialogText.textContent=e.message||"删除失败，请稍后重试"}};
document.addEventListener("click",e=>{if(!e.target.closest(".history-swipe-row"))closeOpen()});document.addEventListener("scroll",closeOpen,{passive:true});load();
/* 返回层级：删除确认弹窗 / 日历选择器 → 左滑展开行 → 页面导航 */
(window.zpBackHooks=window.zpBackHooks||[]).push(
  {rank:10,probe:()=>picker,close:()=>{picker.hidden=true;return true}},
  {rank:10,probe:()=>dialog,close:()=>{closeDialog();return true}},
  {rank:40,probe:()=>document.querySelector(".history-swipe-row.swiped"),close:()=>{closeOpen();return true}}
);

/* ===== 回收站 / 导出 / 客户快查 浮层（P2-3 软删除回收站 + P2-2 导出 + P0 自动回填） ===== */
const overlay=document.getElementById("historyOverlay"),overlayPanel=document.getElementById("historyOverlayPanel");
const toast=m=>{try{window.zpToast&&window.zpToast(m,"success")}catch(e){}};
function closeOverlay(){overlay.hidden=true;overlayPanel.innerHTML=""}
overlay.addEventListener("click",e=>{if(e.target===overlay)closeOverlay()});
// 删除成功后提示已入回收站
confirmBtn.onclick=async()=>{if(!pendingDelete)return;const job=pendingDelete;confirmBtn.disabled=true;confirmBtn.textContent="删除中…";try{if(job.type==="date")await deleteDate(job.key);else await deleteMonth(job.key);closeDialog();toast("已移入回收站，7天内可在回收站恢复");await load()}catch(e){confirmBtn.disabled=false;confirmBtn.textContent="确定";dialogText.textContent=e.message||"删除失败，请稍后重试"}};
// 回收站
async function renderTrash(){
  const r=await fetch("/api/history-trash",{credentials:"same-origin",cache:"no-store"});
  const d=await r.json().catch(()=>null);
  if(!r.ok||!d?.success)throw new Error(d?.error||"回收站读取失败");
  const items=Array.isArray(d.items)?d.items:[];
  let html="<strong>回收站</strong><p class='history-overlay-hint'>已删除的历史运单在此保留 7 天，到期自动清除。</p>";
  if(!items.length){
    html+="<p class='history-overlay-empty'>回收站为空</p>";
  }else{
    for(const it of items){
      const left=it.ttl>0?Math.max(1,Math.ceil(it.ttl/86400)):0;
      html+="<div class='history-trash-item'><div class='history-trash-meta'><strong>"+esc(it.date||"")+"</strong><span>"+esc(it.routeName||"")+" · "+Number(it.storeCount||0)+"家</span><small>剩余约 "+left+" 天</small></div><div class='history-dialog-actions'><button type='button' class='history-trash-restore' data-id='"+esc(it.id)+"'>恢复</button><button type='button' class='history-trash-purge' data-id='"+esc(it.id)+"'>彻底删除</button></div></div>";
    }
    html+="<div class='history-dialog-actions'><button type='button' id='historyOverlayClose'>关闭</button></div>";
  }
  overlayPanel.innerHTML=html;overlay.hidden=false;
}
async function doTrashAction(t){const id=t.dataset.id,restore=t.classList.contains("history-trash-restore");if(!restore&&!await confirmPurge())return;t.disabled=true;try{const r=await fetch("/api/history-trash?id="+encodeURIComponent(id),{method:restore?"POST":"DELETE",credentials:"same-origin"});const d=await r.json().catch(()=>null);if(!r.ok||!d?.success)throw new Error(d?.error||"操作失败");toast(restore?"已恢复":"已彻底删除");await renderTrash();await load()}catch(e){t.disabled=false;toast(e.message||"操作失败")}}
const confirmPurge=async()=>window.zpConfirm?await window.zpConfirm("彻底删除","彻底删除后将无法找回，确定吗？","彻底删除"):confirm("彻底删除后无法找回，确定吗？");
// 导出
function renderExport(){let html="<strong>导出历史数据</strong><p class='history-overlay-hint'>导出为文件保存到本地，方便对账与备份。</p><div class='history-export-row'><span>格式</span><select id='historyExportFormat'><option value='csv'>CSV（Excel）</option><option value='json'>JSON</option></select></div><div class='history-export-row'><span>范围</span><select id='historyExportMonths'><option value=''>全部</option><option value='1'>当月</option><option value='3'>近3个月</option><option value='6'>近6个月</option><option value='13'>近13个月</option></select></div><div class='history-dialog-actions'><button type='button' id='historyExportDo'>导出</button><button type='button' id='historyOverlayClose'>关闭</button></div>";overlayPanel.innerHTML=html;overlay.hidden=false}
async function doExport(t){const fmt=document.getElementById("historyExportFormat").value,months=document.getElementById("historyExportMonths").value;const params=new URLSearchParams({format:fmt});if(months)params.set("months",months);t.disabled=true;try{const r=await fetch("/api/history-export?"+params.toString(),{credentials:"same-origin",cache:"no-store"});if(!r.ok)throw new Error("导出失败（"+r.status+"）");const blob=await r.blob();const fn=r.headers.get("content-disposition")?.match(/filename=\"?([^\"]+)\"?/)?.[1]||("history-export."+fmt);const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=fn;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast("已开始下载");closeOverlay()}catch(e){t.disabled=false;toast(e.message||"导出失败")}}
// 客户快查（自动回填）
function renderLookup(){let html="<strong>客户快查</strong><p class='history-overlay-hint'>输入手机号、姓名或地址，找回该客户最近一次配送信息。</p><div class='history-lookup-row'><input id='historyLookupInput' type='search' maxlength='80' placeholder='手机号 / 姓名 / 地址' autocomplete='off'><button type='button' id='historyLookupDo'>查</button></div><div id='historyLookupResult' class='history-lookup-result'></div><div class='history-dialog-actions'><button type='button' id='historyOverlayClose'>关闭</button></div>";overlayPanel.innerHTML=html;overlay.hidden=false;const inp=document.getElementById("historyLookupInput");inp?.focus();inp?.addEventListener("keydown",ev=>{if(ev.key==="Enter")document.getElementById("historyLookupDo").click()})}
async function doLookup(t){const inp=document.getElementById("historyLookupInput");const q=(inp?.value||"").trim();const res=document.getElementById("historyLookupResult");if(!q){res.textContent="请输入查询内容";return}res.textContent="查询中…";try{const r=await fetch("/api/history-lookup?q="+encodeURIComponent(q),{credentials:"same-origin",cache:"no-store"});const d=await r.json().catch(()=>null);if(!r.ok||!d?.success)throw new Error(d?.error||"查询失败");if(!d.found){res.innerHTML="<p class='history-overlay-empty'>未找到该客户的历史记录</p>";return}const m=d.match;let html="<div class='history-lookup-card'>";html+="<div class='history-lookup-line'><span>日期</span><b>"+esc(m.date||"")+"</b></div>";html+="<div class='history-lookup-line'><span>线路</span><b>"+esc(m.routeName||"")+"</b></div>";if(m.customerName)html+="<div class='history-lookup-line'><span>客户</span><b>"+esc(m.customerName)+"</b></div>";if(m.phone)html+="<div class='history-lookup-line'><span>电话</span><b>"+esc(m.phone)+"</b></div>";if(m.address)html+="<div class='history-lookup-line'><span>地址</span><b>"+esc(m.address)+"</b></div>";html+="<div class='history-lookup-stores'><strong>门店（"+Number(m.storeCount||0)+"家）</strong>";for(const s of (m.stores||[])){html+="<div class='history-lookup-store'><span>"+esc(s.name||"")+"</span>"+(s.phone?"<small>"+esc(s.phone)+"</small>":"")+(s.address?"<small>"+esc(s.address)+"</small>":"")+"</div>"}html+="</div></div>";if(d.hitCount>1)html+="<p class='history-overlay-hint'>共匹配 "+d.hitCount+" 条，已显示最近一条</p>";res.innerHTML=html}catch(e){res.textContent=e.message||"查询失败"}}
// 统一浮层点击分发
overlayPanel.addEventListener("click",async e=>{const t=e.target;if(t.id==="historyOverlayClose"){closeOverlay();return}if(t.id==="historyExportDo")return doExport(t);if(t.id==="historyLookupDo")return doLookup(t);if(t.classList.contains("history-trash-restore")||t.classList.contains("history-trash-purge"))return doTrashAction(t)});
document.getElementById("historyTrashBtn")?.addEventListener("click",()=>renderTrash().catch(e=>toast(e.message||"回收站打开失败")));
document.getElementById("historyExportBtn")?.addEventListener("click",renderExport);
document.getElementById("historyLookupBtn")?.addEventListener("click",renderLookup);
(window.zpBackHooks=window.zpBackHooks||[]).push({rank:5,probe:()=>overlay,close:()=>{closeOverlay();return true}});
})();