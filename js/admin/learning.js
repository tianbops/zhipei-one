/* admin/learning.js —— 学习隔离：隔离列表渲染、隔离与恢复
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
async function renderLearningIsolation(){
  let d;try{d=await api("/api/admin/global-learning?action=quarantined")}catch(e){$("learnQuarantined").innerHTML='<div class="empty">读取隔离列表失败：'+esc(e.message)+'</div>';return}
  const list=d.records||[];
  if(!list.length){$("learnQuarantined").innerHTML='<div class="empty">暂无被隔离的学习记录</div>';return}
  $("learnQuarantined").innerHTML=list.map(r=>{
    const reason=r.quarantineReason||"";
    return '<div class="row" data-store="'+esc(r.storeId)+'"><div class="content"><div class="main"><strong>'+esc(r.storeId)+'</strong>'
      +'<span class="q-badge review">QUARANTINED</span></div>'
      +'<div class="meta">标准名：'+esc(r.standardName||"-")+(reason?' · 原因：'+esc(reason):'')+'</div>'
      +'<div class="meta">隔离人：'+esc(r.quarantinedBy||"-")+' · '+esc((r.quarantinedAt||"").slice(0,19))+'</div></div>'
      +'<button class="small-action learn-restore" data-store="'+esc(r.storeId)+'">恢复</button></div>';
  }).join("");
  document.querySelectorAll(".learn-restore").forEach(b=>b.onclick=()=>learnRestore(b.dataset.store));
}
async function learnIsolate(){
  const storeId=($("learnStoreId").value||"").trim();
  if(!storeId)return toast("请输入门店ID");
  const reason=($("learnReason").value||"").trim();
  try{await api("/api/admin/global-learning",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"isolate",storeId,reason})});toast("已隔离 "+storeId);renderLearningIsolation()}catch(e){toast(e.message)}
}
async function learnRestore(storeId){
  try{await api("/api/admin/global-learning",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"restore",storeId})});toast("已恢复 "+storeId);renderLearningIsolation()}catch(e){toast(e.message)}
}
A.renderLearningIsolation=renderLearningIsolation;
A.learnIsolate=learnIsolate;
A.learnRestore=learnRestore;
})(window.ZPAdmin);
