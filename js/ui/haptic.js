/* 智配One · 触感反馈层（js/ui/haptic.js）
 * ----------------------------------------------------------------------------
 * 统一入口 window.zpHaptic(kind)：让「手指按下去」有一次物理确认。
 *
 * 为什么要单独一层，而不是各处直接写 navigator.vibrate：
 *   1) App 内是 Capacitor WebView，Vibration API 在 WebView 里不可用——没声明
 *      VIBRATE 权限时 navigator.vibrate 恒返回 false，声明了在部分内核上也不通。
 *      壳内唯一可靠的路径是原生桥 window.ZhipeiNative.haptic()（MainActivity 里
 *      用 View.performHapticFeedback 实现，不申请任何权限）。
 *   2) 浏览器端相反：Android Chrome 只有 navigator.vibrate；iOS Safari 两者都没有。
 *   3) 上层只该表达「轻 / 中 / 成功 / 警示」四种语义，走哪条通道、震多久属于平台细节。
 *
 * 平台优先级：ZhipeiNative.haptic（壳内） > navigator.vibrate（浏览器） > 静默跳过。
 * 没有振动马达、用户关掉系统「触摸振动」时，「不震」就是正确结果——
 * 这里不打印任何提示，也不做「触感不可用」的降级 UI。
 *
 * 依赖：无（可独立加载，不依赖 core.js）。
 * 被依赖：nav.js 的底部导航、页面里带 data-zp-haptic 的按钮。
 */
(function(){
  if(window.zpHaptic)return;

  /* 只接受这四种语义；未知值一律按 light 处理，
     避免调用方写错 kind 时静默不震（更难排查）。 */
  const KINDS={light:1,medium:1,success:1,warn:1};

  /* 浏览器兜底参数（毫秒 / [震,停,震]）。壳内不用这些值——强度由系统
     HapticFeedbackConstants 决定，各厂商马达的标定由 ROM 负责，比手写时长更稳。 */
  const VIBRATE={light:10,medium:16,success:20,warn:[12,60,12]};

  /* 原生桥。属性访问成本可忽略，每次调用现探——
     壳的注入时机早于页面脚本，但 WebView 重建（如崩溃恢复）后会换实例，
     缓存住就会拿到失效对象。 */
  function bridge(){
    const n=window.ZhipeiNative;
    return n&&typeof n.haptic==="function"?n:null;
  }

  function nowMs(){
    return (typeof performance!=="undefined"&&performance.now)?performance.now():Date.now();
  }

  /* 节流。两个阈值解决两类抖动：
       - 同一 kind 120ms 内合并：底栏连点两下，不该震出「嗞嗞」两声；
       - 不同 kind 至少隔 60ms：确认框「取消→确定」这种极快的连击，
         不该把两次轻震叠成一次长震。
     静默丢弃而不是排队——触感的时效性只有几毫秒，延后补震反而是错的。 */
  let lastAt=0,lastKind="";
  function allow(kind){
    const now=nowMs();
    if(now-lastAt<(kind===lastKind?120:60))return false;
    lastAt=now;lastKind=kind;
    return true;
  }

  function zpHaptic(kind){
    const k=KINDS[kind]?kind:"light";
    if(!allow(k))return false;
    const b=bridge();
    if(b){
      try{ b.haptic(k); return true; }
      catch(e){/* 桥抛错（旧壳方法签名不符等）就当没有，继续走浏览器兜底 */}
    }
    const nav=window.navigator;
    if(nav&&typeof nav.vibrate==="function"){
      try{ return nav.vibrate(VIBRATE[k]); }catch(e){/* 无用户手势时 Chrome 会抛，忽略 */}
    }
    return false;
  }
  window.zpHaptic=zpHaptic;

  /* ===== 触发点 =====
     统一绑 click，不用 pointerdown/touchstart：
       - 手指按下后在按钮上滑走（滚动列表时的常见动作）不该有震动，
         只有「确实点在按钮上并抬起」才算一次操作——这也是系统控件的口径。
       - click 在现代浏览器没有 300ms 延迟，按下反馈由按钮自身的 :active 负责，
         触感补的是「这一下生效了」的确认感，时机正好。
  /* 绑在 capture 阶段：业务 handler 里的 stopPropagation/preventDefault 都吞不掉它
     （底栏「处理中离开」守卫就是先 stopPropagation 再弹确认框的）。

     ⚠ 选择器必须同时覆盖 <a> 和 <button>（2026-10-30 线上回归）：
     底栏项**不是同一种元素**。首页中央加号是 <button id="uploadAction">（点了就地开
     上传面板，不跳转），其他页的加号是 <a href="/home?openUpload=1">；管理端整条
     底栏全是 <button class="nav-item">。第一版只写了 `.zp-nav a`，于是
     「在别的页点加号有触感 → 跳到首页后，同一个加号变成按钮 → 再点就没感觉了」。
     只写 a 的版本会让一半底栏静默失效，且没有任何报错。 */
  const SEL=".zp-nav a,.zp-nav button,.admin-nav a,.admin-nav button,[data-zp-haptic]";
  document.addEventListener("click",e=>{
    const t=e.target;
    const el=t&&typeof t.closest==="function"?t.closest(SEL):null;
    if(!el)return;
    // data-zp-haptic 可取值 medium/success/warn；不写值或空串按轻触感处理。
    zpHaptic(el.getAttribute("data-zp-haptic")||"light");
  },true);
})();
