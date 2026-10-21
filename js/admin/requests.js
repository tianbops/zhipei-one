/* admin/requests.js —— 线路审核：待审申请渲染与批准/驳回
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
function renderRequests(){$("requests").innerHTML=S.requests.length?S.requests.map(x=>'<div class="row"><div class="content"><div class="main"><strong>'+esc(x.username)+'</strong><div class="meta">'+esc(rn(x.routeName))+' · '+(x.duty==="driver"?"司机":"配送")+'</div></div><div><button class="small-action" data-q="reject" data-id="'+esc(x.id)+'">驳回</button><button class="small-action" data-q="approve" data-id="'+esc(x.id)+'">批准</button></div></div></div>').join(""):'<div class="empty">暂无待审核申请</div>';document.querySelectorAll("[data-q]").forEach(b=>b.onclick=()=>{const x=S.requests.find(v=>v.id===b.dataset.id),a=b.dataset.q;open(a==="approve"?"批准线路申请":"驳回线路申请","确定"+(a==="approve"?"批准":"驳回")+x.username+"的\n"+rn(x.routeName)+" · "+(x.duty==="driver"?"司机":"配送")+"申请吗？","","确定",false,async()=>{await api("/api/admin/route-requests",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requestId:x.id,action:a})});close();toast("申请已处理");A.load()})})}
A.renderRequests=renderRequests;
})(window.ZPAdmin);
