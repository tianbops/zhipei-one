/* home/today.js —— 今日配送三层数据源（latest → 当日历史 → 月度索引）与卡片渲染
   依赖前面全部模块；末尾 loadHome() 自启。
   window.zpHomeMonthlyDataPromise 由 js/home-monthly.js 提供（在 home/*.js 之后加载）。

   本地今日快照（2026-10-30 启动显示优化）：渲染成功后缓存
   {date,dayCount,orders} 到 localStorage；下次启动若快照仍是当天，
   先用快照立即渲染（等待趋近 0），随后正常三层数据源返回后覆盖渲染——
   数据有变则自然纠偏，当日无单/线路切换则走 setEmptyToday() 收敛为空态。
   日期不一致自动失效；退出登录时由 home-bundle-glue.frag 清除，防止换账号串数据。

   同日多单（2026-11-06）：一张卡内按单切页（点 tab / 左右滑动）。
   - 顺序按 uploadedAt 升序（早 → 晚），与 tab、时间轴一致；
   - 选中单记在 sessionStorage（按 id，不按序号），跨天自动失效；
   - 切换只换视图、不重新请求：orders 由 /api/waybills/latest 一次带回；
   - 门店名改为单行省略（简称让名字能一排放下），横向手势让给换单，
     「左滑看全名」只保留在运单详情 / 今日配送独立页（js/ui/store-name-scroll.js）。 */
const TODAY_SNAP_KEY="zp_home_today_v2";
const TODAY_SEL_KEY="zp_home_today_sel";

const zpEsc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const zpAttr=v=>zpEsc(v).replace(/'/g,"&#39;");

function zpTodayKey(){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
}
/* tab 时间取 uploadedAt（与后端「最新一单」排序字段一致）。
   不能用 OCR 时间或计划时间，否则会出现「tab 顺序与默认单不一致」。 */
function zpTodayHM(iso){
  const t=Date.parse(String(iso||""));
  if(!Number.isFinite(t))return "";
  try{return new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit",hour12:false}).format(t)}catch{return ""}
}
function zpTodaySelId(){
  try{
    const s=JSON.parse(sessionStorage.getItem(TODAY_SEL_KEY)||"null");
    if(s&&s.date===zpTodayKey())return String(s.id||"");
  }catch{}
  return "";
}
function zpSetTodaySelId(id){
  try{sessionStorage.setItem(TODAY_SEL_KEY,JSON.stringify({date:zpTodayKey(),id:String(id||"")}))}catch{}
}
function zpReadTodaySnap(){
  try{
    const s=JSON.parse(localStorage.getItem(TODAY_SNAP_KEY)||"null");
    if(s&&s.date===zpTodayKey()&&Array.isArray(s.orders)&&s.orders.length)return s;
  }catch{}
  return null;
}

/* 卡片高度跟随「当前页」：多单行数不同，若不锁高，切换时下面的趋势卡会跟着跳。
   高度瞬时切换、不做动画——高度动画反而会让整页上下移动，观感更乱。
   2026-11-06：改为一屏内滚后，正常版面下高度由 flex 链决定（卡片 100% -
   固定头），这里必须清空内联高度，否则会把卡片顶出屏幕；
   只有降级版面（矮屏/横屏/键盘 → 整页滚动）才按当前页锁高。 */
let zpTodayState={orders:[],idx:0,dayCount:0,go:null};
function zpTodayFallbackLayout(){
  try{
    if(window.matchMedia&&window.matchMedia("(max-height:759px),(orientation:landscape)").matches)return true;
  }catch{}
  try{return !!document.querySelector("main.home-app.is-keyboard")}catch{return false}
}
/* 名单页是否真的能滚：内容溢出才打 .is-scrollable，CSS 据此开
   overscroll-behavior-y:contain。名单不满一屏时保持可连锁，
   否则卡片区域彻底滑不动，下方月度统计就翻不到了。 */
function zpMarkTodayScrollable(){
  if(!todayStoreList)return;
  const pages=todayStoreList.querySelectorAll(".today-page");
  Array.prototype.forEach.call(pages,function(p){
    p.classList.toggle("is-scrollable",p.scrollHeight-p.clientHeight>2);
  });
}
/* 名单内容变了就重算「能不能滚」：数据渲染、切页、克隆行、字体换行都会改变
   溢出量。只用 zpSyncTodayHeight 的调用点不够 —— 行情变化（如简称开关、
   字体就绪后换行）不走那条路径，标记会停在旧值上。 */
let zpScrollMarkTimer=null;
function zpObserveTodayList(){
  if(!todayStoreList||todayStoreList.dataset.zpScrollObs==="1")return;
  todayStoreList.dataset.zpScrollObs="1";
  try{
    new MutationObserver(function(){
      clearTimeout(zpScrollMarkTimer);
      zpScrollMarkTimer=setTimeout(function(){try{zpMarkTodayScrollable()}catch(e){}},60);
    }).observe(todayStoreList,{childList:true,subtree:true});
  }catch{}
}
zpObserveTodayList();

window.zpSyncTodayHeight=function(){
  if(!todayStoreList)return;
  zpMarkTodayScrollable();
  if(todayStoreList.classList.contains("is-empty"))return;
  if(!zpTodayFallbackLayout()){todayStoreList.style.height="";return}
  const page=todayStoreList.querySelector('.today-page[data-i="'+zpTodayState.idx+'"]');
  if(!page)return;
  todayStoreList.style.height=page.offsetHeight+"px";
};
window.addEventListener("resize",function(){try{window.zpSyncTodayHeight()}catch(e){}},{passive:true});

/* 今日卡渲染（tab + 单页列表 + 摘要 + 质量指标）。
   摘要与指标取「当前单」，单量取「全天」——每个数字都能对上，
   不再出现「2单」是全天、「6家」只来自最后一单的错位。 */
function zpRenderToday(orders,dayCount,fromCache){
  const list=(Array.isArray(orders)?orders:[]).filter(o=>o&&typeof o==="object");
  if(!list.length){setEmptyToday();return}
  const total=Number(dayCount)||list.length;
  zpTodayState={orders:list,idx:0,dayCount:total,go:null};

  const navTarget=x=>{try{return window.zpMapNav&&window.zpMapNav.linkAttrs?window.zpMapNav.linkAttrs(x):null}catch{return null}};
  const countOf=o=>{
    const stores=Array.isArray(o.stores)?o.stores:[];
    return Number(o.summary?.finalCount)||Number(o.summary?.total)||stores.length||0;
  };
  const applySummary=o=>{
    todayCount.textContent=countOf(o)+"家";
    // 重量统一 3 位小数（全局口径，见 AGENTS.md「统计口径」）
    todayWeight.textContent=(Math.round((Number(o.totalWeight)||0)*1000)/1000).toFixed(3)+"t";
  };
  const applyMetrics=o=>{
    if(!todayMetrics)return;
    const s=o.summary||{},stores=Array.isArray(o.stores)?o.stores:[],metrics=[];
    if(Number(s.recoveredCount)>0)metrics.push("恢复"+s.recoveredCount+"家");
    if(Number(s.correction)>0)metrics.push("更正"+s.correction+"家");
    if(Number(s.merged)>0)metrics.push("合并"+s.merged+"家");
    if(Number(s.newStores)>0)metrics.push("新增"+s.newStores+"家");
    if(stores.some(x=>x?.pending))metrics.push("待定"+stores.filter(x=>x?.pending).length+"家");
    if(o.quality?.level==="REVIEW")metrics.push("需复核");
    todayMetrics.innerHTML=metrics.map(x=>"<span>"+zpEsc(x)+"</span>").join("");
  };

  const pageHtml=(o,pi)=>{
    const stores=Array.isArray(o.stores)?o.stores:[];
    if(!stores.length)return '<div class="today-page" data-i="'+pi+'"><div class="zp-empty zp-empty--tight">本单暂无配送门店</div></div>';
    return '<div class="today-page" data-i="'+pi+'">'+stores.map((x,i)=>{
      /* 显示名优先取基准库投影的简称（displayName），没有简称时回退运单全名 */
      const rawName=String(x?.displayName||"").trim()||String(x?.name||"").trim()||String(x?.rawName||"").trim()||String(x?.originalName||"").trim()||"未识别门店";
      const t=navTarget(x);
      const body='<span class="today-store-index">'+(i+1)+'</span><span class="zp-store-name">'+zpEsc(rawName)+'</span>';
      if(!t)return '<div class="today-store-row" data-zp-store-row>'+body+'</div>';
      return '<a class="today-store-row" data-zp-store-row href="'+zpAttr(t.url)+'" target="'+t.target+'"'+(t.rel?' rel="'+zpAttr(t.rel)+'"':'')+
        ' data-zp-nav="'+zpAttr(t.kind)+'" data-zp-nav-name="'+zpAttr(rawName)+'"'+
        ' data-zp-nav-payload="'+zpAttr(t.payload||'')+'"'+
        ' aria-label="第'+(i+1)+'家，'+(t.kind==='missing'?'暂无精确定位，请录入':'导航到 '+zpAttr(rawName))+'">'+body+'</a>';
    }).join("")+"</div>";
  };

  todayOrders.textContent=(total>0?total:1)+"单";

  if(todayStoreList){
    try{
      todayStoreList.innerHTML='<div class="today-view"><div class="today-track">'+list.map(pageHtml).join("")+'</div></div>';
    }catch{
      todayStoreList.innerHTML='<div class="zp-empty zp-empty--tight">今日门店明细暂不可用</div>';
    }
  }

  if(todayTabs){
    /* 2026-11-06（用户定稿）：tab 只留「第 N 单」，不再带上传时间。
       两单同屏时时间是干扰项 —— 司机认的是「第几单」，页内顺序就是上传顺序。
       时间仍可从运单详情看到，不在这里重复。 */
    todayTabs.innerHTML=list.length>1?list.map((o,i)=>{
      return '<button type="button" class="today-tab" role="tab" data-i="'+i+'" aria-selected="false">第'+(i+1)+'单</button>';
    }).join(""):"";
    todayTabs.hidden=list.length<2;
  }

  /* 默认单：记住本次会话的选择；没有记录（或那一单已不在列表）则回退到最新一单，
     与「刚上传的新单」这一现实一致——打开首页就能看到新单。 */
  const saved=zpTodaySelId();
  let idx=list.length-1;
  if(saved){
    const k=list.findIndex(o=>String(o.id)===saved);
    if(k>=0)idx=k;
  }

  function go(i,instant){
    i=Math.max(0,Math.min(list.length-1,i));
    zpTodayState.idx=i;
    const track=todayStoreList&&todayStoreList.querySelector(".today-track");
    if(track){
      track.style.transition=instant?"none":"transform 260ms cubic-bezier(.22,.61,.36,1)";
      track.style.transform="translate3d("+(-i*todayStoreList.clientWidth)+"px,0,0)";
    }
    if(todayTabs&&todayTabs.children.length){
      Array.prototype.forEach.call(todayTabs.children,function(b,k){
        const on=k===i;b.setAttribute("aria-selected",on?"true":"false");b.classList.toggle("is-active",on);
      });
      /* ≥4 单时 tab 条会横向溢出：把当前项滚进视野，避免「滑到第 4 单但 tab 停在前面」 */
      const act=todayTabs.children[i];
      if(act&&todayTabs.scrollWidth>todayTabs.clientWidth){
        const left=Math.max(0,act.offsetLeft-(todayTabs.clientWidth-act.offsetWidth)/2);
        try{todayTabs.scrollTo({left:left,behavior:"smooth"})}catch{todayTabs.scrollLeft=left}
      }
    }
    applySummary(list[i]);
    applyMetrics(list[i]);
    zpSetTodaySelId(list[i].id);
    /* 切单/切 tab 一律把浮岛弹回来：否则切完看不到「换成了哪一单」 */
    try{window.zpHeadShow&&window.zpHeadShow()}catch{}
    window.zpSyncTodayHeight();
  }
  zpTodayState.go=go;
  go(idx,true);
  zpBindTodaySwipe();
  /* 中文字体晚于脚本到达时，行高会变、锁定高度就偏小（列表底部被裁）。
     字体就绪后补量一次；窗口尺寸变化由 zpSyncTodayHeight 的 resize 监听兜住。 */
  try{if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){try{window.zpSyncTodayHeight()}catch(e){}})}catch{}

  if(!fromCache){
    try{localStorage.setItem(TODAY_SNAP_KEY,JSON.stringify({date:zpTodayKey(),dayCount:total,orders:list}))}catch{}
  }
}

/* 左右滑动换单（2026-11-06）
   ------------------------------------------------------------------
   手势资源从「左滑看全名」移交给「换单」：简称让名称能一排放下，
   门店名改单行省略后，横向手势不再被占。
   判定：8px 死区 → |dx| > |dy|×1.2 才接管；一旦判为纵向，本次触点不再介入，
   避免「想滚列表却切了单」。屏幕左缘 24px 留给 iOS 返回手势。
   位移 > 18% 卡宽才切页，边界阻尼 0.35、不循环；滑动后吞掉一次 click，
   防止松手时误开导航（门店行是 <a>）。 */
function zpBindTodaySwipe(){
  const box=todayStoreList;
  if(!box||box.dataset.zpSwipe==="1")return;
  box.dataset.zpSwipe="1";
  /* is-swiping 挂在卡片上（摘要与列表是兄弟节点），用来在滑动时把摘要压淡 */
  const card=box.closest(".task-card")||box;
  let sx=0,sy=0,dx=0,lock=null,down=false;
  const trackOf=()=>box.querySelector(".today-track");
  box.addEventListener("pointerdown",function(e){
    if(!trackOf())return;
    if(e.pointerType==="mouse"&&e.button!==0)return;
    if(e.clientX<24)return;
    down=true;lock=null;dx=0;sx=e.clientX;sy=e.clientY;
    const t=trackOf();if(t)t.style.transition="none";
  },{passive:true});
  box.addEventListener("pointermove",function(e){
    if(!down)return;
    const ax=e.clientX-sx,ay=e.clientY-sy;
    if(!lock){
      if(Math.abs(ax)<8&&Math.abs(ay)<8)return;
      lock=Math.abs(ax)>Math.abs(ay)*1.2?"x":"y";
      if(lock==="x"&&zpTodayState.orders.length>1)card.classList.add("is-swiping");
    }
    if(lock!=="x")return;
    const t=trackOf();if(!t)return;
    dx=ax;
    /* 只有 1 单：不产生位移（否则卡片跟着手指滑动再弹回，像「加载失败」），
       但仍算作横向手势 —— 松手时要吞掉 click，不能因为滑了一下就跳地图。 */
    if(zpTodayState.orders.length<2)return;
    const w=box.clientWidth,n=zpTodayState.orders.length;
    let v=dx;
    if((zpTodayState.idx===0&&dx>0)||(zpTodayState.idx===n-1&&dx<0))v=dx*0.35;
    t.style.transform="translate3d("+(-zpTodayState.idx*w+v)+"px,0,0)";
    if(e.cancelable)e.preventDefault();
  },{passive:false});
  function settle(){
    if(!down)return;
    down=false;
    const t=trackOf();if(t)t.style.transition="";
    if(lock==="x"){
      card.classList.remove("is-swiping");
      const w=box.clientWidth,far=Math.abs(dx)>w*0.18,go=zpTodayState.go;
      if(go&&zpTodayState.orders.length>1)go(zpTodayState.idx+(far?(dx<0?1:-1):0));
      if(Math.abs(dx)>8)box.dataset.zpSwiped=String(Date.now());
    }
    lock=null;dx=0;
  }
  box.addEventListener("pointerup",settle);
  box.addEventListener("pointercancel",settle);
  /* 只吞一次：吞完立即清零，下一次正常点击照常生效 */
  window.addEventListener("click",function(e){
    const at=Number(box.dataset.zpSwiped||0);
    if(!at)return;
    if(Date.now()-at>600){box.dataset.zpSwiped="0";return}
    if(box.contains(e.target)){e.preventDefault();e.stopPropagation();box.dataset.zpSwiped="0"}
  },true);
  if(todayTabs){
    todayTabs.addEventListener("click",function(e){
      const b=e.target.closest&&e.target.closest(".today-tab");
      if(!b)return;
      const go=zpTodayState.go;if(go)go(Number(b.dataset.i)||0);
    });
  }
}

/* ===== 顶部浮岛收放（2026-11-06 定稿）=====
   规则：
     · 浏览下方内容（名单向下滚 ≥12px）→ 浮岛收起，列表上移接上；
     · 回看上方（名单向上滚 ≥6px，或滚回顶部）→ 浮岛弹出；
     · 切单 / 切 tab 强制弹出；矮屏 / 横屏 / 键盘（整页滚动）全程跳过。
   为什么收起时要改 scrollTop：
     浮岛占 150px，收起后列表顶部上移 150px。若不动 scrollTop，屏幕上的门店会
     整体上跳 150px（原来第 6 行变成第 2 行）。补偿后内容原地不动，只有底部多
     露出 3.5 行 —— 这才是「收起浮岛腾地方」该有的样子。
   为什么补完要锁 280ms：
     改 scrollTop 会再触发一次 scroll 事件，方向与手势相反，不锁就会立刻被判成
     「上滑」而自行弹出，来回抖成死循环。
   为什么高度不加 CSS 过渡：
     高度变化与 scrollTop 补偿必须同帧完成，否则列表会「先跳上去再被拉回来」。
     视觉上的滑动只由浮岛自己的 transform 承担（180ms），滑出过程正好盖住列表
     的瞬时上移。 */
(function(){
  const main=document.querySelector("main.home-app");
  const island=document.querySelector("main.home-app .zp-head-island");
  const list=document.getElementById("todayStoreList");
  if(!main||!island||!list)return;

  const COLLAPSED=10;   // 收起后留给把手线的高度
  let headH=0,hidden=false,lockUntil=0,lastY=0,downAcc=0,upAcc=0,measureRaf=0;

  function fallback(){
    try{return typeof zpTodayFallbackLayout==="function"?zpTodayFallbackLayout():false}catch{return false}
  }
  function shift(){return Math.max(0,headH-COLLAPSED)}

  /* 量浮岛自然高度：island 高度被 --zp-head-h 钉住，量之前必须临时放开，
     否则量到的是上次的值 —— 单/多单切换（tab 显隐）时会量不出 54px 的差。 */
  function measure(){
    if(fallback())return;
    const prev=island.style.height;
    island.style.height="auto";
    const h=Math.round(island.getBoundingClientRect().height);
    island.style.height=prev;
    if(h>0&&h!==headH){
      headH=h;
      main.style.setProperty("--zp-head-h",h+"px");
    }
  }
  function scheduleMeasure(){
    if(measureRaf)return;
    measureRaf=requestAnimationFrame(function(){measureRaf=0;measure()});
  }

  /* 底栏联动：首页外层不滚，nav.js 的滚动判定收不到名单的 scroll，
     不显式通知的话底栏会一直待在屏幕上，与收起的顶部浮岛打架。 */
  function navSync(hide){
    try{window.zpNavSetHidden&&window.zpNavSetHidden(hide)}catch{}
  }

  function hide(page){
    if(hidden||fallback())return;
    const s=shift();
    // 没滚够就不收：保证补偿后 scrollTop 仍 > 0，不会刚收就被「到顶」弹回来
    if(s<=0||page.scrollTop<=s+8)return;
    hidden=true;
    lockUntil=Date.now()+280;
    main.classList.add("is-head-hidden");
    navSync(true);
    page.scrollTop=page.scrollTop-s;
    lastY=page.scrollTop;downAcc=0;upAcc=0;
  }
  /* compensate=true：当前页内容定位不动（滚动中收/放）；
     切单时传 false：新页通常没滚过，硬加会把内容顶到中间。 */
  function show(page,compensate){
    if(!hidden)return;
    hidden=false;
    lockUntil=Date.now()+280;
    main.classList.remove("is-head-hidden");
    navSync(false);
    const s=shift();
    if(compensate&&page){
      const max=page.scrollHeight-page.clientHeight;
      page.scrollTop=Math.max(0,Math.min(max,page.scrollTop+s));
    }else if(page){
      /* 切单/切 tab：把其它页的 scrollTop 一并补回，切回去时位置不偏 */
      const active=Number(zpTodayState&&zpTodayState.idx);
      Array.prototype.forEach.call(list.querySelectorAll(".today-page"),function(p,i){
        if(i===active||p===page)return;
        const max=p.scrollHeight-p.clientHeight;
        if(max>0&&p.scrollTop>0)p.scrollTop=Math.min(max,p.scrollTop+s);
      });
    }
    lastY=page?page.scrollTop:0;downAcc=0;upAcc=0;
  }
  window.zpHeadShow=function(){
    const page=list.querySelector('.today-page[data-i="'+(zpTodayState.idx||0)+'"]');
    show(page,false);
  };

  /* 把手线：点一下也能展开。34×3 的线本身太细，热区在 CSS 里放大到 44×24；
     展开按「用户自己上滑」处理（compensate=true），内容原地、浮岛盖下来。 */
  const handle=document.querySelector("main.home-app .zp-head-handle");
  if(handle){
    handle.setAttribute("role","button");
    handle.setAttribute("tabindex","0");
    handle.setAttribute("aria-label","展开今日配送");
    const openHead=function(){
      const page=list.querySelector('.today-page[data-i="'+(zpTodayState.idx||0)+'"]');
      show(page,true);
    };
    handle.addEventListener("click",openHead);
    handle.addEventListener("keydown",function(e){
      if(e.key==="Enter"||e.key===" "){e.preventDefault();openHead()}
    });
  }

  list.addEventListener("scroll",function(e){
    const t=e.target;
    if(!t||!t.classList||!t.classList.contains("today-page"))return;
    if(fallback()){if(hidden)show(t,false);return}
    const y=t.scrollTop;
    if(Date.now()<lockUntil){lastY=y;downAcc=0;upAcc=0;return}
    const dy=y-lastY;
    lastY=y;
    if(dy>0){downAcc+=dy;upAcc=0}
    else if(dy<0){upAcc-=dy;downAcc=0}
    if(!hidden){
      if(downAcc>=12)hide(t);
    }else if(upAcc>=6||y<=0){
      show(t,true);
    }
  },{capture:true,passive:true});

  window.addEventListener("resize",function(){
    scheduleMeasure();
    if(fallback()&&hidden)show(null,false);
  },{passive:true});
  if(window.ResizeObserver){
    try{new ResizeObserver(scheduleMeasure).observe(island)}catch{}
  }
  scheduleMeasure();
})();

let zpHomeInitialLoadFailed=false;
let zpHomeRecoveryInFlight=false;

async function loadHome(){
  const perfReadyStartedAt=performance.now();
  // 快照先行：同日快照立即渲染（零网络等待），随后正常数据源返回后覆盖或纠偏
  try{
    const snap=zpReadTodaySnap();
    if(snap){
      zpRenderToday(snap.orders,Number(snap.dayCount)||0,true);
      try{window.zpPerfRecord?.("home-today-ready-cache",200,performance.now()-perfReadyStartedAt,null)}catch{}
    }
  }catch{}
  // 超时由 zpFetch 内部管理，避免把超时误判为调用方取消而跳过安全 GET 重试。
  const fetchJson=async(url,timeoutMs=8000)=>{
    const res=await zpFetch(url,{credentials:"same-origin",cache:"no-store"},{timeoutMs});
    const data=await res.json().catch(()=>({}));
    return {res,data};
  };
  try{
    // 首页依赖「有效线路」而非仅 dispatchRouteId：
    // 已绑定但未选调度线路的业务用户，/api/dispatch 返回 dispatchRoute:null
    // （临时线路仅在「既无 dispatchRouteId 也无 boundRouteId」时才会分配），
    // 此时必须以 boundRouteId 兜底，否则今日配送永远读不到数据。
    // 该问题在 8d4b9b6 重排 loadHome 后暴露：layer1 被 `if(dispatchRouteId)` 跳过，
    // layer2/3 又用 waybill.routeId==="" 过滤，永不命中 → 显示「暂无运单」。
    // 聚合接口：一次往返同时拿「调度线路 + 当前用户」（历史为 /api/dispatch 与
    // /api/me 两次并行请求，两次 currentUser 各 2 次 Redis 往返；合并后鉴权只做一次）
    // 并行发起：原实现是「bootstrap 回来 → 才知道 effectiveRouteId → 才敢发 latest」，
    // 但 latest 是服务端按会话自行解析线路的 GET，压根不需要前端先把 routeId 递过去——
    // routeId 只用于**结果校验**，而校验必然发生在两个响应都齐了之后。
    // 串行那段在中国大陆就直接换算成一次跨境往返（实测 bootstrap 单独就要 ~1.3s），
    // 白白加到首屏数据就绪的关键路径上。现在两者同时起飞。
    // 未 await 时不会静默抛错：末尾 .catch 把失败收敛成 null，layer1 自然降级到 layer2/3。
    const latestPromise=fetchJson("/api/waybills/latest",20000).catch(()=>null);
    const {res,data}=await fetchJson("/api/home-bootstrap");
    // 会话失效：头部守卫之外的兜底（如登录态残留但服务端会话已过期）。清标记并回登录页。
    if(res.status===401){zpHomeInitialLoadFailed=false;if(window.zpAuthFail)window.zpAuthFail("expired");return;}
    if(res.ok)try{sessionStorage.setItem("zpAuth","1")}catch(e){}
    if(!res.ok||!data.success)throw Error(data.error||"当前配送线路读取失败");
    dispatchRouteId=data.dispatchRoute?.id||"";
    boundRouteId=data.user&&data.user.boundRouteId?String(data.user.boundRouteId):(boundRouteId||"");
    renderSubstituteBadge();
    setRouteBadge(data.dispatchRoute||null);
    // 有效线路 = 显式调度线路（含临时线路）优先，其次管理员绑定线路
    const effectiveRouteId=dispatchRouteId||boundRouteId;

    const todayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    let w=null;
    // 当天全部有效单（升序），用于单卡切换；w 仍保留「最后一单」语义，供线路校验兜底。
    let orders=[];
    // 当日该线路的运单数（"X单 X家 Xt" 里的 X）。一个运单覆盖一天一条线路，
    // 但当天可能上午/下午各上传一次，所以它不恒等于 1，必须按数据来。
    let dayOrders=0;
    // 比对键：默认用 effectiveRouteId，但一旦拿到服务端回显的 routeId 就以它为准。
    // 背景：data.dispatchRoute.id 来自 route:<id> 存储体内部的 id 字段，若与
    // Redis 键 id（即会话 dispatchRouteId、运单 routeId）发生数据漂移，前端用
    // dispatchRoute.id 过滤会全部落空（表现为徽标/月度正常、今日配送恒为空）。
    // /api/history 的响应体里回显了服务端实际使用的 routeId，用它比对可免疫漂移。
    let cmpRouteId=effectiveRouteId;

    // 首页“今日配送”以 latest 后端选择结果为唯一权威候选。
    // 历史接口负责列表/统计，不让首页在多张当日运单中自行重新选一张，
    // 避免同日多次上传时出现“刚上传A，首页却显示B”的数据分叉。
    if(effectiveRouteId){
      try{
        // 取的是上面已并发出去的那个请求（此刻通常早已在传输中或已完成）
        const latest=await latestPromise;
        if(latest){
          const {res:lr,data:ld}=latest;
          if(lr.ok&&ld.success){
            /* orders 是当天全部有效单（升序）；旧接口/旧缓存只有 waybill，退回单页模式。
               仍按 routeId + date 复校，避免接口版本漂移时把别的线路的单渲染进来。 */
            const all=Array.isArray(ld.orders)&&ld.orders.length?ld.orders:(ld.waybill?[ld.waybill]:[]);
            const mine=all.filter(x=>x&&x.routeId===cmpRouteId&&x.date===todayKey);
            if(mine.length){orders=mine;w=mine[mine.length-1];dayOrders=Number(ld.dayCount)||mine.length}
          }
        }
      }catch{}
    }

    // latest 异常时才回退到当天历史；回退仍按后端返回的 createdAt 顺序取最后一张。
    if(!w&&effectiveRouteId){
      try{
        const {res,data}=await fetchJson("/api/history?date="+encodeURIComponent(todayKey),20000);
        const list=Array.isArray(data.waybills)?data.waybills:[];
        if(res.ok&&data.success!==false){
          const serverRoute=String(data.routeId||"").trim();
          if(serverRoute)cmpRouteId=serverRoute;
          const usable=list.filter(x=>x&&x.routeId===cmpRouteId&&x.date===todayKey);
          usable.sort((a,b)=>String(a.uploadedAt||a.createdAt||"").localeCompare(String(b.uploadedAt||b.createdAt||"")));
          orders=usable;
          w=usable[usable.length-1]||null;
          dayOrders=usable.length;
        }
      }catch{}
    }

    // 第三层复用月度统计已经成功读取的数据索引。若单日接口异常，
    // 只要月度历史能看到今天，就根据当天运单 ID 再取完整运单，避免出现“月度有数据、今日却为空”。
    if(!w&&effectiveRouteId){
      try{
        // 月度统计脚本通常已在首页并行读取 25 个月历史；优先复用同一响应，
        // 只有共享请求失败/超时才发起原有 13 个月兜底请求。
        let historyData=null;
        const sharedPromise=window.zpHomeMonthlyDataPromise;
        if(sharedPromise){
          let timer;
          try{
            historyData=await Promise.race([
              sharedPromise,
              new Promise(resolve=>{timer=setTimeout(()=>resolve(null),20000)})
            ]);
          }finally{clearTimeout(timer)}
        }
        if(!historyData?.success||!Array.isArray(historyData.history)){
          const {res,data}=await fetchJson("/api/history?months=13",20000);
          if(res.ok&&data.success!==false)historyData=data;
        }
        if(historyData?.success!==false&&Array.isArray(historyData?.history)){
          const serverRoute=String(historyData.routeId||"").trim();
          if(serverRoute)cmpRouteId=serverRoute;
          const todayEntry=historyData.history.find(x=>x?.date===todayKey&&Number(x?.count)>0);
          // 月度索引只给 ID：这里只能补到一张单，降级为单页模式（tab 自动收起）。
          dayOrders=Number(todayEntry?.count)||0;
          const id=Array.isArray(todayEntry?.waybillIds)?todayEntry.waybillIds[todayEntry.waybillIds.length-1]:"";
          if(id){
            const {res:detailRes,data:detail}=await fetchJson("/api/waybills/latest?id="+encodeURIComponent(id),20000);
            if(detailRes.ok&&detail.success&&detail.waybill&&detail.waybill.routeId===cmpRouteId&&detail.waybill.date===todayKey){
              w=detail.waybill;orders=[detail.waybill];
            }
          }
        }
      }catch{}
    }

    // 渲染统一走 zpRenderToday（快照/新数据同一渲染路径，杜绝两份实现漂移）
    if(orders.length){
      zpRenderToday(orders,dayOrders,false);
    }else{
      setEmptyToday();
    }
    zpHomeInitialLoadFailed=false;
    try{window.zpPerfRecord?.("home-today-ready-network",200,performance.now()-perfReadyStartedAt,null)}catch{}
  }catch(e){
    // 所有异常都必须结束 loading 状态，不能让首页永久停留在“加载中…”。
    zpHomeInitialLoadFailed=true;
    console.error("[loadHome] 异常:",e&&e.stack||e);
    setEmptyToday();
  }
}

// 仅在首页首轮数据加载失败后恢复联网时补拉；不整页刷新，也不打断用户操作。
function zpHomeCanAutoRecover(){
  if(!zpHomeInitialLoadFailed)return false;
  try{if(navigator.onLine===false||document.visibilityState==="hidden")return false}catch{}
  try{if(window.zpIsProcessing?.())return false}catch{}
  try{if(document.body?.classList.contains("sheet-open"))return false}catch{}
  const active=document.activeElement;
  if(active&&(/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)||active.isContentEditable))return false;
  const dialog=document.querySelector('[role="dialog"][aria-modal="true"]');
  if(dialog&&!dialog.closest("[hidden]"))return false;
  return true;
}
function zpRecoverHomeAfterNetwork(){
  if(zpHomeRecoveryInFlight||!zpHomeCanAutoRecover())return;
  zpHomeRecoveryInFlight=true;
  loadHome().finally(()=>{zpHomeRecoveryInFlight=false});
}
window.addEventListener("online",zpRecoverHomeAfterNetwork);
window.addEventListener("focus",zpRecoverHomeAfterNetwork);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")zpRecoverHomeAfterNetwork()});
loadHome();