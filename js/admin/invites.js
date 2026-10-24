/* admin/invites.js —— 邀请码：列表渲染、左滑、生成/停用/启用/删除
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
function renderInvites(){
  const list=S.invites||[];
  $("invites").innerHTML=list.length?list.map(c=>{
    const used=Number(c.usedCount||0),max=Number(c.maxUses||0),expired=!!c.expired,exhausted=!!c.exhausted,disabled=c.enabled===false;
    const status=disabled?"已停用":expired?"已过期":exhausted?"已用完":"可使用";
    const statusClass=disabled||expired||exhausted?"review":"ok";
    const left=max>0?Math.max(0,max-used)+"次":"不限";
    const actions=(disabled
      ? '<button class="small-action" data-invite-action="enable" data-id="'+esc(c.id)+'">启用</button>'
      : '<button class="small-action" data-invite-action="disable" data-id="'+esc(c.id)+'">停用</button>')
      +'<button class="small-action danger" data-invite-action="remove" data-id="'+esc(c.id)+'">删除</button>';
    return '<div class="invite"><div class="invite-actions">'+actions+'</div><div class="invite-content"><div class="invite-head"><span class="code">'+esc(c.code)+'</span><span class="q-badge '+statusClass+'">'+status+'</span><button class="copy" data-c="'+esc(c.code)+'" aria-label="复制邀请码"><span class="copy-i"></span></button></div><div class="meta">已用 '+used+'次 · 剩余 '+left+' · '+(c.expiresAt?new Date(c.expiresAt).toLocaleDateString():"永久")+'</div></div></div>';
  }).join(""):'<div class="empty">暂无邀请码</div>';
  document.querySelectorAll("#invites [data-c]").forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.c);toast("已复制")}catch{toast("复制失败")}});
  document.querySelectorAll("#invites .invite").forEach(swInvite);
  document.querySelectorAll("#invites [data-invite-action]").forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();inviteAct(b.dataset.id,b.dataset.inviteAction)});
}
function swInvite(el){
  let x=0,y=0,active=false;
  el.addEventListener("touchstart",e=>{
    if(!dlg.hidden||!menuBg.hidden||e.target.closest(".invite-actions"))return;
    const t=e.touches[0];x=t.clientX;y=t.clientY;active=true
  },{passive:true});
  el.addEventListener("touchend",e=>{
    if(!active||!dlg.hidden||!menuBg.hidden){active=false;return}
    if(e.target.closest(".invite-actions")){e.stopPropagation();active=false;return}
    const t=e.changedTouches[0],dx=t.clientX-x,dy=t.clientY-y;active=false;
    if(Math.abs(dx)>34&&Math.abs(dx)>Math.abs(dy)*1.05){
      e.stopPropagation();closeSwipes();
      if(dx<0)el.classList.add("open")
    }
  },{passive:true});
  el.addEventListener("touchcancel",()=>{active=false},{passive:true})
}

async function inviteAct(id,action){
  const c=(S.invites||[]).find(x=>x.id===id);if(!c)return;
  if(action==="remove"){
    return open("删除邀请码","确定永久删除「"+c.code+"」吗？\n删除后邀请码立即失效且不可恢复。","", "删除", true, async()=>{
      await api("/api/invite-codes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"remove",id})});
      close();toast("邀请码已删除");A.load();
    });
  }
  const title=action==="disable"?"停用邀请码":"启用邀请码";
  const msg=action==="disable"?"停用后该邀请码将立即失效，之后仍可重新启用。":"确认重新启用该邀请码吗？如果已过期或已用完，启用后仍不能使用。";
  return open(title,msg,"",action==="disable"?"停用":"启用",false,async()=>{
    await api("/api/invite-codes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,id})});
    close();toast(action==="disable"?"邀请码已停用":"邀请码已启用");A.load();
  });
}
function addInvite(){
  const uses=[["1","1次"],["5","5次"],["10","10次"],["0","不限"]];
  const days=[["30","30天"],["7","7天"],["90","90天"],["0","永久"]];
  const picker=(id,label,options,initial)=>'<div class="field zp-admin-picker" data-picker="'+id+'"><label>'+label+'</label><input id="'+id+'" type="hidden" value="'+initial+'"><button type="button" class="zp-picker-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="'+label+'">'+options.find(x=>x[0]===initial)[1]+'<span aria-hidden="true">⌄</span></button><div class="zp-picker-options" role="listbox" aria-label="'+label+'" hidden>'+options.map(x=>'<button type="button" role="option" data-value="'+x[0]+'" aria-selected="'+(x[0]===initial?'true':'false')+'">'+x[1]+'</button>').join("")+'</div></div>';
  open("生成邀请码","设置使用次数和有效期",picker("iu","使用次数",uses,"1")+picker("id","有效期",days,"30")+'<div class="field"><label>生成数量</label><input id="ic" type="number" min="1" max="100" value="1"></div>',"生成",false,async()=>{
    const n=Math.max(1,Math.min(100,Number(ic.value)||1)),d=Number(id.value),e=d?new Date(Date.now()+d*86400000).toISOString():null;
    for(let k=0;k<n;k++)await api("/api/invite-codes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"create",maxUses:Number(iu.value),expiresAt:e})});
    close();toast("邀请码已生成");A.load()
  });
  db.querySelectorAll(".zp-admin-picker").forEach(group=>{
    const trigger=group.querySelector(".zp-picker-trigger"),menu=group.querySelector(".zp-picker-options"),value=group.querySelector("input[type=hidden]");
    const shut=()=>{menu.hidden=true;trigger.setAttribute("aria-expanded","false")};
    trigger.addEventListener("click",()=>{const opening=menu.hidden;db.querySelectorAll(".zp-picker-options").forEach(m=>m.hidden=true);db.querySelectorAll(".zp-picker-trigger").forEach(b=>b.setAttribute("aria-expanded","false"));menu.hidden=!opening;trigger.setAttribute("aria-expanded",String(opening));if(opening){const selected=menu.querySelector('[aria-selected="true"]');if(selected)selected.focus()}});
    const options=()=>[...menu.querySelectorAll('[role="option"]')];
    const selectOption=option=>{value.value=option.dataset.value;trigger.firstChild.textContent=option.textContent;options().forEach(o=>o.setAttribute("aria-selected",String(o===option)));shut();trigger.focus()};
    options().forEach(option=>option.addEventListener("click",()=>selectOption(option)));
    trigger.addEventListener("keydown",e=>{
      if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();if(menu.hidden)trigger.click();const items=options();if(items.length)items[e.key==="ArrowDown"?0:items.length-1].focus()}
      else if(e.key==="Escape"&&!menu.hidden){e.preventDefault();shut()}
    });
    group.addEventListener("keydown",e=>{
      if(menu.hidden)return;
      const items=options(),index=items.indexOf(document.activeElement);
      let next=-1;
      if(e.key==="Escape"){e.preventDefault();shut();trigger.focus();return}
      if(e.key==="ArrowDown")next=(index+1)%items.length;
      else if(e.key==="ArrowUp")next=(index-1+items.length)%items.length;
      else if(e.key==="Home")next=0;
      else if(e.key==="End")next=items.length-1;
      else if(e.key==="Tab"){shut();return}
      else if(e.key==="Enter"||e.key===" "){if(index>=0){e.preventDefault();selectOption(items[index])}return}
      if(next>=0){e.preventDefault();items[next].focus()}
    });
  });
}
A.renderInvites=renderInvites;
A.swInvite=swInvite;
A.inviteAct=inviteAct;
A.addInvite=addInvite;
})(window.ZPAdmin);
