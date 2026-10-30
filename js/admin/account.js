/* admin/account.js —— 系统设置抽屉：开关、改用户名、改密码、清理旧运单
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
/* 系统菜单开关 3.4：菜单作为 rank 20 的返回层级注册（见下方 zpRegisterBackHook），
   返回键/手势由 back.js 的 zpCloseTopLayer 统一收起，**不再压历史记录**。
   旧实现 openMenu 里往历史压一条 zpMenu 记录、hideMenu 里再 back() 撤销，
   看似自洽，实则一遇到「菜单开着直接跳页/自动关闭」就会把那条记录留成孤儿，
   之后连按返回会退回已经离开的页面。层级已由 hook 表达，历史层就是多余的一层。 */
function openMenu(){const mb=$("menuBg");mb.hidden=false}
function hideMenu(){const mb=$("menuBg");if(!mb.hidden)mb.hidden=true}
if(window.zpRegisterBackHook)window.zpRegisterBackHook({rank:20,probe:()=>{const mb=$("menuBg");return mb&&!mb.hidden?mb:null},close:()=>{hideMenu();return true}});
function editUser(){hideMenu();open("修改用户名","保存后需要重新登录",'<div class="field username-field"><label for="nu">新用户名</label><div class="username-control"><input id="nu" autocomplete="username" aria-label="新用户名" placeholder="请输入新的管理员用户名"></div></div>',"保存",false,async()=>{const username=nu.value.trim();if(!username)return toast("请输入新的管理员用户名");await api("/api/admin/manage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"rename",username})});close();toast("用户名已修改，请重新登录");setTimeout(()=>location.replace("/"),700)})}
function editPass(){hideMenu();open("修改密码","修改后需要重新登录",'<div class="field reset-password-field"><label for="op">当前密码</label><input id="op" type="password" autocomplete="current-password" placeholder="请输入当前密码"></div><div class="field reset-password-field"><label for="np">新密码</label><input id="np" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="至少8位"></div><div class="field reset-password-field"><label for="cp">确认新密码</label><input id="cp" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="再次输入新密码"></div>',"保存",false,async()=>{if(!op.value||!np.value||!cp.value)return toast("请完整填写密码");if(np.value.length<8||np.value!==cp.value)return toast("请检查新密码");await api("/api/admin/manage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"password",currentPassword:op.value,password:np.value})});close();toast("密码已修改，请重新登录");setTimeout(()=>location.replace("/"),700)})}
function resetData(){hideMenu();open("清理旧运单数据","只清理旧运单、旧今日索引和旧历史索引，不影响线路、线路基准和账号。此操作无法撤销。",'<div class="field reset-password-field"><label for="rp">管理员密码</label><input id="rp" type="password" autocomplete="current-password" placeholder="请输入管理员密码" aria-describedby="resetPasswordHint"><div id="resetPasswordHint" class="field-hint">验证身份后才会清理旧运单索引</div></div>',"确认清理",true,async()=>{if(!rp.value)return toast("请输入管理员密码");const d=await api("/api/admin/manage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"reset",password:rp.value})});close();toast("旧运单数据已清理："+(d.deleted||0)+"项");load()})}
A.openMenu=openMenu;
A.hideMenu=hideMenu;
A.editUser=editUser;
A.editPass=editPass;
A.resetData=resetData;
})(window.ZPAdmin);
