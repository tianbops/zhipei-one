/* 智配One · 外观偏好 + 线路名显示标准（原 js/ui-unified.js 拆分 · 2/6）
 * 主题（system/dark/light）与全局字号缩放，外加线路名的全局显示口径。
 * 依赖：无（core.js 只被 nav/back 需要，本模块自洽）。
 */
(function(){
  if(window.zpGetAppearanceTheme)return;

  /* ===== 线路名全局显示标准 =====
     圆点/徽章内（zpRouteShort）→ 只显示线路数字（26px 圆点放不下「6号线」），
     临时线路显示「临」；其它文字位置（zpRouteName）→ 统一「X号线」格式；
     无法归一为「数字+单位」结构的名字原样保留（如「机场线」）。 */
  const routeDigitsOf=value=>{const m=String(value??"").match(/\d+/);return m?m[0]:""};
  window.zpRouteShort=value=>{
    const raw=String(value??"").trim();
    if(!raw)return "—";
    if(/临时/.test(raw))return "临";
    const digits=routeDigitsOf(raw);
    if(digits)return digits;
    return raw.length<=2?raw:raw.slice(0,2);
  };
  window.zpRouteName=value=>{
    const raw=String(value??"").trim();
    if(!raw)return "";
    if(/号线$/.test(raw))return raw;
    const m=raw.match(/^(\d+)\s*(号线路|号线|号|路)$/);
    if(m)return m[1]+"号线";
    if(/^\d+$/.test(raw))return raw+"号线";
    return raw;
  };
  // 用户偏好只保存在当前浏览器，不写入业务账号或服务端数据。
  (function initAppearancePreferences(){
    const root=document.documentElement;
    const THEME_KEY="zp_appearance_theme";
    const SCALE_KEY="zp_appearance_font_scale";
    const validThemes=["system","dark","light"];
    const read=(key,fallback)=>{try{return localStorage.getItem(key)||fallback}catch{return fallback}};
    const applyTheme=theme=>{
      const chosen=validThemes.includes(theme)?theme:"system";
      const resolved=chosen==="system"?(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):chosen;
      root.dataset.zpTheme=resolved;
      root.dataset.zpThemeChoice=chosen;
      const dark=resolved!=="light";
      /* 壳底色与网页主题严格成对：深色 #121826 ↔ 浅色 #F6F7F9。
         映射表是 meta theme-color 与安卓壳状态栏的共同真值来源
         （浅色取映射值，深色取键本身），杜绝两处各写一半对不齐。 */
      const SHELL_BG={"#121826":"#F6F7F9"};
      const bg=dark?"#121826":SHELL_BG["#121826"];
      const meta=document.querySelector('meta[name="theme-color"]');
      if(meta)meta.setAttribute("content",bg);
      // 安卓壳（Capacitor）状态栏同步：壳里此前是「透明状态栏 + 图标跟随系统深浅色」，
      // 于是 App 深色外观 + 系统浅色模式（或反过来）时图标与底色同色，状态栏直接看不见。
      // 这里把网页实际外观回传给壳，由壳把状态栏/导航栏底色设为不透明主题色、
      // 图标明暗按底色取反，两个来源从此只有网页一个真值。浏览器/PWA 里没有该对象，
      // 静默跳过即可（那条路径靠上面的 theme-color 生效）。
      try{
        const native=window.ZhipeiNative;
        if(native&&typeof native.applyTheme==="function")native.applyTheme(bg,dark);
      }catch(e){}
      document.dispatchEvent(new CustomEvent("zp:appearancechange",{detail:{theme:chosen,resolved}}));
    };
    // 全局字号缩放的目标标签：必须覆盖所有可能直接包裹文本的标签。
    // 历史教训：原先漏了 div（及 em/i/b/h5/h6 等文字级标签），导致如
    // .dispatch-message 这类「div 直接包文字」的提示在调字号时完全不变化，
    // 表现为同一页面有的字变大有的不变。新增文字级标签时优先补到这里。
    const textSelector="p,span,a,button,label,input,select,textarea,li,td,th,strong,small,em,i,b,u,s,cite,code,kbd,var,mark,time,figcaption,option,optgroup,dt,dd,blockquote,caption,address,h1,h2,h3,h4,h5,h6,legend,summary,output,div,.summary,.message,.page2-soft,.store-row,.account-row,.page2-row,.page2-label,.topbar,.order-title";
    const collectTextTargets=(rootNode=document)=>{
      const targets=[];
      if(rootNode instanceof Element&&rootNode.matches(textSelector))targets.push(rootNode);
      rootNode.querySelectorAll?.(textSelector).forEach(el=>targets.push(el));
      return targets.filter(el=>!el.closest("svg,script,style"));
    };
    const cacheTextBase=el=>{
      if(el.dataset.zpFontBase)return;
      // 记录原始 inline 字号，恢复到 100% 时不破坏页面自己的行内样式。
      el.dataset.zpFontInline=el.style.getPropertyValue("font-size");
      el.dataset.zpFontInlinePriority=el.style.getPropertyPriority("font-size");
      let size=parseFloat(getComputedStyle(el).fontSize);
      // 动态插入的文本可能继承了已缩放父级的字号；若当前字号就是父级字号，
      // 继承父级的未缩放基准，避免再次乘比例造成层级越深文字越大。
      let parent=el.parentElement;
      while(parent&&parent!==document.documentElement){
        if(parent.dataset?.zpFontBase){
          const parentSize=parseFloat(getComputedStyle(parent).fontSize);
          if(Number.isFinite(parentSize)&&Math.abs(size-parentSize)<0.1){
            size=Number(parent.dataset.zpFontBase);
          }
          break;
        }
        parent=parent.parentElement;
      }
      if(Number.isFinite(size)&&size>0)el.dataset.zpFontBase=String(size);
    };
    const scanText=(rootNode=document)=>{
      const targets=collectTextTargets(rootNode);
      // 两阶段处理：先缓存整个子树的原始计算字号，再统一应用缩放；
      // 不能一边改父元素一边读取子元素，否则首次载入非 100% 字号时会层层叠乘。
      targets.forEach(cacheTextBase);
      const scale=Math.max(0.85,Math.min(1.3,Number(root.style.getPropertyValue("--zp-font-scale"))||1));
      targets.forEach(el=>{
        const base=Number(el.dataset.zpFontBase);
        if(Number.isFinite(base)&&base>0)el.style.setProperty("font-size",(base*scale)+"px","important");
      });
    };
    const resetTextScale=()=>{
      collectTextTargets(document).forEach(el=>{
        if(!el.dataset.zpFontBase)return;
        el.style.removeProperty("font-size");
        const inlineSize=el.dataset.zpFontInline||"";
        const inlinePriority=el.dataset.zpFontInlinePriority||"";
        if(inlineSize)el.style.setProperty("font-size",inlineSize,inlinePriority);
        delete el.dataset.zpFontBase;
        delete el.dataset.zpFontInline;
        delete el.dataset.zpFontInlinePriority;
      });
    };
    let textObserver=null;
    let textScaleActive=false;
    const applyScale=value=>{
      const n=Math.max(0.85,Math.min(1.3,Number(value)||1));
      root.style.setProperty("--zp-font-scale",String(n));
      if(Math.abs(n-1)<0.001){
        if(textObserver){textObserver.disconnect();textObserver=null;}
        // 默认字号不需要逐元素写入同值 !important，也不需要常驻 MutationObserver。
        if(textScaleActive)resetTextScale();
        textScaleActive=false;
      }else{
        scanText();
        textScaleActive=true;
        if(!textObserver&&document.body&&window.MutationObserver){
          textObserver=new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{if(node.nodeType===1)scanText(node)})));
          textObserver.observe(document.body,{childList:true,subtree:true});
        }
      }
      document.dispatchEvent(new CustomEvent("zp:fontscalechange",{detail:{scale:n}}));
    };
    window.zpSetAppearanceTheme=theme=>{const v=validThemes.includes(theme)?theme:"system";try{localStorage.setItem(THEME_KEY,v)}catch{}applyTheme(v)};
    window.zpGetAppearanceTheme=()=>read(THEME_KEY,"system");
    window.zpSetFontScale=value=>{const n=Math.max(.85,Math.min(1.3,Number(value)||1));try{localStorage.setItem(SCALE_KEY,String(n))}catch{}applyScale(n)};
    window.zpGetFontScale=()=>Math.max(.85,Math.min(1.3,Number(read(SCALE_KEY,"1"))||1));
    applyTheme(window.zpGetAppearanceTheme());
    applyScale(window.zpGetFontScale());
    // 首帧后再开启过渡：避免初始渲染从浏览器默认色「闪」到主题色；
    // 此后主题切换与 :active 状态变化的颜色/背景才平滑过渡。
    try{requestAnimationFrame(()=>requestAnimationFrame(()=>root.classList.add("zp-ui-ready")))}catch(e){root.classList.add("zp-ui-ready")}
    if(window.matchMedia){
      const media=window.matchMedia("(prefers-color-scheme: light)");
      const onChange=()=>{if(window.zpGetAppearanceTheme()==="system")applyTheme("system")};
      media.addEventListener?media.addEventListener("change",onChange):media.addListener?.(onChange);
      // 布局断点切换（屏幕旋转/窗口缩放跨过 @media）会改变固定 px 字号的基准；
      // 若用户已开启非 100% 字号缩放，需重算基准，否则缩放值会停留在旧断点基准上。
      ["(max-width:430px)","(max-width:380px)","(max-width:360px)"].forEach(q=>{
        const mq=window.matchMedia(q);
        const onLayoutChange=()=>{if(textScaleActive){resetTextScale();scanText()}};
        mq.addEventListener?mq.addEventListener("change",onLayoutChange):mq.addListener?.(onLayoutChange);
      });
    }
  })();
})();
