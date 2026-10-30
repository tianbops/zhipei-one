/* home/today.js —— 今日配送三层数据源（latest → 当日历史 → 月度索引）与卡片渲染
   依赖前面全部模块；末尾 loadHome() 自启。
   window.zpHomeMonthlyDataPromise 由 js/home-monthly.js 提供（在 home/*.js 之后加载）。 */

async function loadHome(){
  const fetchJson=async(url,timeoutMs=8000)=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const res=await zpFetch(url,{credentials:"same-origin",cache:"no-store",signal:controller.signal});
      const data=await res.json().catch(()=>({}));
      return {res,data};
    }finally{clearTimeout(timer);}
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
    if(res.status===401){if(window.zpAuthFail)window.zpAuthFail("expired");return;}
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
          if(lr.ok&&ld.success&&ld.waybill&&ld.waybill.routeId===cmpRouteId&&ld.waybill.date===todayKey){
            w=ld.waybill;
            dayOrders=Number(ld.dayCount)||0;
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
          usable.sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
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
          dayOrders=Number(todayEntry?.count)||0;
          const id=Array.isArray(todayEntry?.waybillIds)?todayEntry.waybillIds[todayEntry.waybillIds.length-1]:"";
          if(id){
            const {res:detailRes,data:detail}=await fetchJson("/api/waybills/latest?id="+encodeURIComponent(id),20000);
            if(detailRes.ok&&detail.success&&detail.waybill&&detail.waybill.routeId===cmpRouteId&&detail.waybill.date===todayKey)w=detail.waybill;
          }
        }
      }catch{}
    }

    // 摘要与门店明细分开渲染：stores 异常绝不允许把今日数量/重量卡在“加载中”。
    if(w&&w.routeId===cmpRouteId){
      const stores=Array.isArray(w.stores)?w.stores:[];
      const total=Number(w.summary?.finalCount)||Number(w.summary?.total)||stores.length||0;
      // 渲染辅助函数必须定义在两个渲染块的共享作用域：
      // 此前 esc 等定义在 if(todayStoreList) 块内，todayMetrics 块引用时
      // ReferenceError → 被外层 catch 静默吞掉 → 整卡「暂无运单」。
      // 数量语义已统一：只显示最终门店数及必要的自动恢复数。
      const navOf=x=>String(x?.navigation||x?.nav||"").trim();
      const safeUrl=v=>{try{const u=new URL(String(v||"").trim(),location.origin);return /^(https?:)$/.test(u.protocol)?u.href:""}catch{return""}};
      const esc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
      const attr=v=>esc(v).replace(/'/g,"&#39;");
      if(todayOrders)todayOrders.textContent=(dayOrders>0?dayOrders:1)+"单";
      todayCount.textContent=total+"家";
      // 重量统一 3 位小数（全局口径，见 AGENTS.md「统计口径」）
      todayWeight.textContent=(Math.round((Number(w.totalWeight)||0)*1000)/1000).toFixed(3)+"t";

      if(todayStoreList){
        try{
          todayStoreList.innerHTML=stores.length?stores.map((x,i)=>{
            const name=esc(x?.name||x?.rawName||"未识别门店"),nav=safeUrl(navOf(x));
            const body='<span class="today-store-index">'+(i+1)+'</span><span class="today-store-name">'+name+'</span>';
            return nav?'<a class="today-store-row" href="'+attr(nav)+'" target="_self">'+body+'</a>':'<div class="today-store-row">'+body+'</div>';
          }).join(""):'<div class="zp-empty zp-empty--tight">今日暂无配送门店</div>';
        }catch{
          todayStoreList.innerHTML='<div class="zp-empty zp-empty--tight">今日门店明细暂不可用</div>';
        }
      }

      if(todayMetrics){
        const s=w.summary||{},metrics=[];
        if(Number(s.recoveredCount)>0)metrics.push("恢复"+s.recoveredCount+"家");
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
    // 所有异常都必须结束 loading 状态，不能让首页永久停留在“加载中…”。
    console.error("[loadHome] 异常:",e&&e.stack||e);
    setEmptyToday();
  }
}
loadHome();