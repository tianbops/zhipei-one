/* admin/learning.js —— 学习隔离：隔离列表渲染、隔离与恢复
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
async function renderLearningStores(){
  const select=$("learnStoreSelect");if(!select)return;
  const previous=select.value;
  select.innerHTML='<option value="">正在读取门店列表…</option>';
  try{
    const d=await api("/api/admin/global-learning?action=stores");
    const records=Array.isArray(d.records)?d.records:[];
    select.innerHTML='<option value="">选择已有学习门店（'+records.length+'）</option>'+records.map(r=>{
      const status=String(r.status||"");
      const label=(r.standardName||"未命名门店")+(status==="QUARANTINED"?"（已隔离）":status==="CONFLICT"?"（存在冲突）":"");
      return '<option value="'+esc(r.storeId)+'"'+(status==="QUARANTINED"?' disabled':'')+'>'+esc(label)+'</option>';
    }).join("");
    if(records.some(r=>r.storeId===previous&&r.status!=="QUARANTINED"))select.value=previous;
    const hint=$("learnStoreHint");
    if(hint)hint.textContent=d.partial?"门店列表可能不完整，可刷新后重新选择。":"请选择已有学习门店，再设置隔离原因。";
  }catch(e){
    select.innerHTML='<option value="">门店列表读取失败</option>';
    const hint=$("learnStoreHint");if(hint)hint.textContent="读取失败："+e.message+"；请刷新门店列表后重试。";
  }
}
async function renderLearningIsolation(){
  renderLearningStores();
  let d;try{d=await api("/api/admin/global-learning?action=quarantined")}catch(e){$("learnQuarantined").innerHTML='<div class="zp-empty">读取隔离列表失败：'+esc(e.message)+'</div>';return}
  const list=d.records||[];
  if(!list.length){$("learnQuarantined").innerHTML='<div class="zp-empty">暂无被隔离的学习记录</div>';return}
  $("learnQuarantined").innerHTML=list.map(r=>{
    const reason=r.quarantineReason||"";
    return '<div class="row" data-store="'+esc(r.storeId)+'"><div class="content"><div class="main"><strong>'+esc(r.standardName||"未命名门店")+'</strong>'
      +'<span class="q-badge review">已隔离</span></div>'
      +'<div class="meta">'+(reason?'原因：'+esc(reason):'未填写隔离原因')+'</div>'
      +'<div class="meta">隔离人：'+esc(r.quarantinedBy||"-")+' · '+esc((r.quarantinedAt||"").slice(0,19))+'</div></div>'
      +'<button class="small-action learn-restore" data-store="'+esc(r.storeId)+'">恢复</button></div>';
  }).join("");
  document.querySelectorAll(".learn-restore").forEach(b=>b.onclick=()=>learnRestore(b.dataset.store));
}
async function learnIsolate(){
  const storeId=($("learnStoreSelect")?.value||"").trim();
  if(!storeId)return toast("请先从门店列表中选择门店");
  const reasonType=($("learnReasonType")?.value||"").trim();
  const reasonNote=($("learnReasonNote")?.value||"").trim();
  const reason=[reasonType,reasonNote].filter(Boolean).join("：");
  const selected=$("learnStoreSelect")?.selectedOptions?.[0]?.textContent||"所选门店";
  if(!(await window.zpConfirm("确认隔离学习记录","确认隔离所选门店的全局学习记录？\n"+selected+"\n原因："+(reason||"未填写")+"\n隔离会停止该记录参与后续自动匹配，可通过“恢复”撤销。","隔离")))return;
  try{
    await api("/api/admin/global-learning",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"isolate",storeId,reason})});
    toast("已隔离 "+storeId);
    if($("learnReasonType"))$("learnReasonType").value="";
    if($("learnReasonNote"))$("learnReasonNote").value="";
    renderLearningIsolation();
  }catch(e){toast(e.message)}
}
async function learnRestore(storeId){
  try{await api("/api/admin/global-learning",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"restore",storeId})});toast("已恢复 "+storeId);renderLearningIsolation()}catch(e){toast(e.message)}
}
const storeSelect=$("learnStoreSelect");
A.renderLearningStores=renderLearningStores;
A.renderLearningIsolation=renderLearningIsolation;
A.learnIsolate=learnIsolate;
A.learnRestore=learnRestore;
})(window.ZPAdmin);
