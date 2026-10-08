      }
      throw e;
    }
  }catch(e){
    // 优先展示服务端友好 message（与 code 不同时）；纯 code 场景走映射表
    showProcessingError(e?.message&&e.message!==e.code?e.message:(e?.code||"PROCESS_FAILED"), e?.hint, e?.action, e?.recoverable, e?.requestId);
  }finally{
    stopProcessingClock();
    document.querySelectorAll(".source-option").forEach(b=>b.disabled=false);
    processingFile=false;
    const wasCancelled=processingCancelled;
    processingController=null;
    if(wasCancelled){
      closeUpload();
      try{window.zpToast?.("已取消处理","success")}catch{}
    }
  }
}
["cameraInput","photoInput","documentInput"].forEach(id=>$(id)?.addEventListener("change",e=>processSelectedFiles(Array.from(e.target.files||[]))));

async function loadHome(){
  const fetchJson=async(url,timeoutMs=8000)=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const res=await fetch(url,{credentials:"same-origin",cache:"no-store",signal:controller.signal});
      const data=await res.json().catch(()=>({}));
      return {res,data};
    }finally{clearTimeout(timer);}
  };
  try{
    // 首页只依赖当前调度线路，不再先读取整套线路列表。
    // /api/routes 是线路管理/展示接口，首页读取它会把大量无关 Redis 读取放进今日配送关键路径。
    const {res:dispatchRes,data:dispatch}=await fetchJson("/api/dispatch");
    if(!dispatchRes.ok||!dispatch.success)throw Error(dispatch.error||"当前配送线路读取失败");
    dispatchRouteId=dispatch.dispatchRoute?.id||"";
    renderSubstituteBadge();
    const route=dispatch.dispatchRoute||null;
    setRouteBadge(route);

    const todayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    let w=null;

    // 第一层：快捷读取最新运单。它失败/超时不能阻塞首页。
    try{
      const {res,data}=await fetchJson("/api/waybills/latest");
      if(res.ok&&data.success&&data.waybill)w=data.waybill;
    }catch{}

    // 第二层：按线路+日期读取历史。这里既作为 latest 的兜底，也作为门店明细的可靠数据源。
    if(!w&&dispatchRouteId){
      try{
        const {res,data}=await fetchJson("/api/history?date="+encodeURIComponent(todayKey));
        const list=Array.isArray(data.waybills)?data.waybills:[];
        if(res.ok&&data.success!==false){
          const usable=list.filter(x=>x&&x.routeId===dispatchRouteId&&x.date===todayKey);
          usable.sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
          w=usable[usable.length-1]||null;
        }
      }catch{}
    }

    // 数字摘要与门店列表解耦：即使 stores 明细缺失，今日数量/重量仍必须正常结束渲染。
    if(w&&w.routeId===dispatchRouteId){
      const stores=Array.isArray(w.stores)?w.stores:[];
      const total=Number(w.summary?.total)||stores.length||0;
      todayCount.textContent=total+"家";
      todayWeight.textContent=(Math.round((Number(w.totalWeight)||0)*100)/100).toFixed(2)+"t";

      if(todayStoreList){
        const navOf=x=>String(x?.navigation||x?.nav||"").trim();
        const safeUrl=v=>{try{const u=new URL(String(v||"").trim(),location.origin);return /^(https?:)$/.test(u.protocol)?u.href:""}catch{return""}};
        const esc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
        const attr=v=>esc(v).replace(/'/g,"&#39;");
        todayStoreList.innerHTML=stores.length?stores.map((x,i)=>{
          const name=esc(x?.name||x?.rawName||"未识别门店"),nav=safeUrl(navOf(x));
          const body='<span class="today-store-index">'+(i+1)+'</span><span class="today-store-name">'+name+'</span>';
          return nav?'<a class="today-store-row" href="'+attr(nav)+'" target="_self">'+body+'</a>':'<div class="today-store-row">'+body+'</div>';
        }).join(""):'<div class="today-store-empty">今日暂无配送门店</div>';
      }

      if(todayMetrics){
        const s=w.summary||{},metrics=[];
        if(Number(s.original)&&Number(s.original)!==Number(s.total))metrics.push("原始"+s.original+"家");
        if(Number(s.correction)>0)metrics.push("更正"+s.correction+"家");
        if(Number(s.merged)>0)metrics.push("合并"+s.merged+"家");
        if(Number(s.newStores)>0)metrics.push("新增"+s.newStores+"家");
        if(stores.some(x=>x?.pending))metrics.push("待定"+stores.filter(x=>x?.pending).length+"家");
        if(w.quality?.level==="REVIEW")metrics.push("需复核");
        todayMetrics.innerHTML=metrics.map(x=>'<span>'+esc(x)+'</span>').join("");
      }
    }else{
      setEmptyToday();
    }
  }catch(e){
    // 任一今日数据请求异常都必须结束 loading 状态，绝不让首页永久停在“加载中…”。
    setEmptyToday();
  }
}
loadHome();

/* 三横菜单「账号设置」右侧显示当前用户名：用户打开菜单即可直接确认登录身份。
   静默失败不阻塞首页，读不到就保持骨架占位（样式与「当前线路」数值一致）。 */
(async()=>{
  try{
    // 带时间戳参数：与登录页/管理端同一防缓存策略，任何按 URL 缓存的中间层
    // 都无法用旧会话时代的 /api/me 响应冒充当前登录身份（2026-10-05 事故加固）。
    const r=await fetch("/api/me?homeMe="+Date.now(),{credentials:"same-origin",cache:"no-store"});
    const d=await r.json().catch(()=>({}));
    const name=d&&d.user&&d.user.username?String(d.user.username):"";
    boundRouteId=d&&d.user&&d.user.boundRouteId?String(d.user.boundRouteId):"";
    renderSubstituteBadge();

  }catch{}