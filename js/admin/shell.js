/* admin/shell.js —— 面板横滑手势与管理员端返回层级钩子
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
/* 面板横滑 4.0：实时跟手 + 8px 方向锁定 + 距离/速度双判定 + 首尾阻尼。
   旧实现三处失效：①阈值 55px 太高 ②要求 |dx|>|dy|*1.35，拇指自然弧度必带
   竖向分量 → 被误判为滚动 ③热区原只挂在 #viewport，屏幕边缘与底部留白收不到
   事件（已改为整块 .shell 可滑 + 面板铺满可用高度，详见上方样式注释）。 */
(function(){
  const vp=$("viewport"),pg=$("pages");
  const W=()=>vp.clientWidth||document.documentElement.clientWidth||360;
  const busy=()=>!$("dlg").hidden||!$("menuBg").hidden;
  let sx=0,sy=0,axis="",live=false,from=0,t0=0,onRow=false;
  function down(e){
    if(busy()||e.touches.length>1){axis="skip";return}
    // 线路已左滑展开后，删除按钮本身必须完全脱离分页/行手势。
    // 否则点击删除时这里先执行 closeSwipes()，按钮会在 click 发生前被收回，
    // 用户看到的就是“点击删除 → 删除按钮向右滑回去 → 无法删除”。
    if(e.target&&e.target.closest&&e.target.closest(".route-delete,.invite")){axis="skip";return}
    if(document.querySelector(".row.open,.route.open")){closeSwipes();axis="skip";return}
    const t=e.touches[0];
    sx=t.clientX;sy=t.clientY;axis="";live=false;from=S.page;t0=e.timeStamp||Date.now();
    onRow=!!(e.target&&e.target.closest&&e.target.closest(".row,.route"));
  }
  function move(e){
    if(axis==="skip"||busy())return;
    const t=e.touches[0],mx=t.clientX-sx,ay=Math.abs(t.clientY-sy);
    if(!axis){
      if(Math.abs(mx)<8&&ay<8)return;                 // 死区：不动就什么都不判定
      if(onRow&&mx<0){axis="skip";return}             // 列表行向左 = 行内操作菜单，让位给 sw()
      axis=Math.abs(mx)>ay?"x":"y";                   // 一次锁定，全程不再摇摆
      if(axis!=="x")return;                           // 竖向 → 交还列表原生滚动
      live=true;
    }
    if(axis!=="x")return;
    let off=mx;
    if((from===0&&off>0)||(from===4&&off<0))off*=0.3; // 首尾面板阻尼，滑到底有回弹感
    pg.style.transition="none";
    pg.style.transform="translateX("+(-from*W()+off)+"px)";
    if(e.cancelable)e.preventDefault();
  }
  function end(e,commit){
    if(axis==="skip"||axis!=="x"||!live){axis="";live=false;return}
    // 浏览器因系统边缘手势、原生滚动或 WebView 仲裁触发 touchcancel 时，
    // 必须把跟手中的面板动画归位；否则会永久停在两页之间（尤其屏幕左右边缘）。
    if(!commit){
      pg.style.transition="";
      pg.style.transform="translateX(-"+from*20+"%)";
      live=false;axis="";
      return;
    }
    const t=e.changedTouches&&e.changedTouches[0];
    const last=t?t.clientX-sx:0;
    const dt=Math.max(1,(e.timeStamp||Date.now())-t0),vel=Math.abs(last)/dt,w=W();
    let to=from;
    // 距离够远 或 甩得够快（快滑哪怕只有 18px 也翻页），两者满足其一即可
    if(commit&&(Math.abs(last)>Math.min(36,w*0.10)||(vel>0.28&&Math.abs(last)>14)))
      to=last<0?from+1:from-1;
    to=Math.max(0,Math.min(4,to));
    pg.style.transition="";live=false;axis="";
    page(to);                                          // 统一收尾：百分比重排 + Tab 高亮 + 收起左滑行
  }
  const host=document.querySelector(".shell")||vp;   // 热区提升到整块面板：含 tabs 与四周留白
  [host].forEach(el=>{if(!el)return;
    el.addEventListener("touchstart",down,{passive:true});
    el.addEventListener("touchmove",move,{passive:false});
    el.addEventListener("touchend",e=>end(e,true),{passive:true});
    el.addEventListener("touchcancel",e=>end(e,false),{passive:true});
  });
})();

/* 管理员端返回层级：表单弹窗 → 系统设置抽屉 → 左滑展开行 → 到顶「两次返回退出」。
   管理员是独立工作区，中央控制器的跨区防火墙已禁止其回落到业务首页/业务页。 */
(window.zpBackHooks=window.zpBackHooks||[]).push(
  {rank:10,probe:()=>$("dlg"),dirty:()=>A.dlgBase!==null&&A.dlgSnapshot()!==A.dlgBase,close:()=>{A.close();return true}},
  {rank:20,probe:()=>$("menuBg"),close:()=>{A.hideMenu();return true}},
  {rank:40,probe:()=>document.querySelector(".row.open,.route.open"),close:()=>{closeSwipes();return true}}
);

})(window.ZPAdmin);
