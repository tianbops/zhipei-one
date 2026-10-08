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
  try{
    const [routesRes,dispatchRes]=await Promise.all([
      fetch("/api/routes",{credentials:"same-origin",cache:"no-store"}),
      fetch("/api/dispatch",{credentials:"same-origin",cache:"no-store"})
    ]);
    const routes=await routesRes.json().catch(()=>({}));
    const dispatch=await dispatchRes.json().catch(()=>({}));
    if(!routesRes.ok||!routes.success)throw Error(routes.error||"线路读取失败");
    if(!dispatchRes.ok||!dispatch.success)throw Error(dispatch.error||"当前配送线路读取失败");
    dispatchRouteId=dispatch.dispatchRoute?.id||"";
    renderSubstituteBadge();
    const route=dispatch.dispatchRoute||null;
    const routeName=route?.type==="temporary"?"临时用户":(route?.name||"未选择");
    setRouteBadge(route);
    // 首页“今日配送”与月度统计必须使用同一条按线路/日期的历史数据链路。
    // latest 是单运单快捷接口；当其读不到时不能把“接口空结果”误判为“今天没有运单”。
    const todayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    let w=null;
    try{
      const latestRes=await fetch("/api/waybills/latest",{credentials:"same-origin",cache:"no-store"});
      const latestData=await latestRes.json().catch(()=>({}));
      if(latestRes.ok&&latestData.success&&latestData.waybill)w=latestData.waybill;
    }catch{}
    // 与首页月度统计使用的 /api/history 保持同源：同线路、同日期，取当天最新一单。
    if(!w){
      try{
        const historyRes=await fetch("/api/history?date="+encodeURIComponent(todayKey),{credentials:"same-origin",cache:"no-store"});
        const historyData=await historyRes.json().catch(()=>({}));
        const list=Array.isArray(historyData.waybills)?historyData.waybills:[];
        const usable=list.filter(x=>x&&x.routeId===dispatchRouteId&&x.date===todayKey);
        usable.sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
        w=usable[usable.length-1]||null;
      }catch{}
    }
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
        if(Array.isArray(w.stores)&&w.stores.some(x=>x?.pending))metrics.push("待定"+w.stores.filter(x=>x?.pending).length+"家");
        if(w.quality?.level==="REVIEW")metrics.push("需复核");
        todayMetrics.innerHTML=metrics.map(x=>'<span>'+esc(x)+'</span>').join("");
      }
    }else{
      setEmptyToday();
    }
  }catch(e){
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