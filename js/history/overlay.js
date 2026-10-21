'use strict';

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
      html+="<div class='history-trash-item'><div class='history-trash-meta'><strong>"+esc(it.date||"")+"</strong><span>"+esc(window.zpRouteName?window.zpRouteName(it.routeName||""):(it.routeName||""))+" · "+Number(it.storeCount||0)+"家</span><small>剩余约 "+left+" 天</small></div><div class='history-dialog-actions'><button type='button' class='history-trash-restore' data-id='"+esc(it.id)+"'>恢复</button><button type='button' class='history-trash-purge' data-id='"+esc(it.id)+"'>彻底删除</button></div></div>";
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
async function doLookup(t){const inp=document.getElementById("historyLookupInput");const q=(inp?.value||"").trim();const res=document.getElementById("historyLookupResult");if(!q){res.textContent="请输入查询内容";return}res.textContent="查询中…";try{const r=await fetch("/api/history-lookup?q="+encodeURIComponent(q),{credentials:"same-origin",cache:"no-store"});const d=await r.json().catch(()=>null);if(!r.ok||!d?.success)throw new Error(d?.error||"查询失败");if(!d.found){res.innerHTML="<p class='history-overlay-empty'>未找到该客户的历史记录</p>";return}const m=d.match;let html="<div class='history-lookup-card'>";html+="<div class='history-lookup-line'><span>日期</span><b>"+esc(m.date||"")+"</b></div>";html+="<div class='history-lookup-line'><span>线路</span><b>"+esc(window.zpRouteName?window.zpRouteName(m.routeName||""):(m.routeName||""))+"</b></div>";if(m.customerName)html+="<div class='history-lookup-line'><span>客户</span><b>"+esc(m.customerName)+"</b></div>";if(m.phone)html+="<div class='history-lookup-line'><span>电话</span><b>"+esc(m.phone)+"</b></div>";if(m.address)html+="<div class='history-lookup-line'><span>地址</span><b>"+esc(m.address)+"</b></div>";html+="<div class='history-lookup-stores'><strong>门店（"+Number(m.storeCount||0)+"家）</strong>";for(const s of (m.stores||[])){html+="<div class='history-lookup-store'><span>"+esc(s.name||"")+"</span>"+(s.phone?"<small>"+esc(s.phone)+"</small>":"")+(s.address?"<small>"+esc(s.address)+"</small>":"")+"</div>"}html+="</div></div>";if(d.hitCount>1)html+="<p class='history-overlay-hint'>共匹配 "+d.hitCount+" 条，已显示最近一条</p>";res.innerHTML=html}catch(e){res.textContent=e.message||"查询失败"}}
// 统一浮层点击分发
overlayPanel.addEventListener("click",async e=>{const t=e.target;if(t.id==="historyOverlayClose"){closeOverlay();return}if(t.id==="historyExportDo")return doExport(t);if(t.id==="historyLookupDo")return doLookup(t);if(t.classList.contains("history-trash-restore")||t.classList.contains("history-trash-purge"))return doTrashAction(t)});
document.getElementById("historyTrashBtn")?.addEventListener("click",()=>renderTrash().catch(e=>toast(e.message||"回收站打开失败")));
document.getElementById("historyExportBtn")?.addEventListener("click",renderExport);
document.getElementById("historyLookupBtn")?.addEventListener("click",renderLookup);
(window.zpBackHooks=window.zpBackHooks||[]).push({rank:5,probe:()=>overlay,close:()=>{closeOverlay();return true}});