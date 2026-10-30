/* admin/requests.js —— 线路审核：待审申请渲染与批准/驳回
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
/* 申请人信息（2026-10-30 新增，选填）。账号名是 tian860 这种，管理员审批时对不上人；
 * 填了姓名就用它当标题，没填退回账号名并在下面注明「未填写姓名」——旧记录不该看起来像坏了。 */
function applicantHead(x){
  const who=x.applicantName?esc(x.applicantName):esc(x.username);
  const bits=[];
  if(!x.applicantName)bits.push("未填写姓名");
  if(x.applicantPhone)bits.push(esc(x.applicantPhone));
  return {who,detail:bits.length?'<div class="meta">'+bits.join(" · ")+'</div>':""};
}
function renderRequests(){$("requests").innerHTML=S.requests.length?S.requests.map(x=>{const h=applicantHead(x);return '<div class="row"><div class="content"><div class="main"><strong>'+h.who+'</strong>'+h.detail+'<div class="meta">'+esc(x.username)+' · '+esc(rn(x.routeName))+' · '+(x.duty==="driver"?"司机":"配送")+'</div></div><div><button class="small-action" data-q="reject" data-id="'+esc(x.id)+'">驳回</button><button class="small-action" data-q="approve" data-id="'+esc(x.id)+'">批准</button></div></div></div>'}).join(""):'<div class="zp-empty">暂无待审核申请</div>';document.querySelectorAll("[data-q]").forEach(b=>b.onclick=()=>{const x=S.requests.find(v=>v.id===b.dataset.id),a=b.dataset.q;
  // 确认弹窗也带姓名：批准不可逆，管理员得能一眼确认批的是谁
  const who=x.applicantName||x.username;
  open(a==="approve"?"批准线路申请":"驳回线路申请","确定"+(a==="approve"?"批准":"驳回")+who+"的\n"+rn(x.routeName)+" · "+(x.duty==="driver"?"司机":"配送")+"申请吗？","","确定",false,async()=>{await api("/api/admin/route-requests",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requestId:x.id,action:a})});close();toast("申请已处理");A.load()})})}
A.renderRequests=renderRequests;
})(window.ZPAdmin);
