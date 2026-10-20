/* Local-only performance probe. Enable with ?zpPerf=1. No telemetry is sent. */
(function(){
  let enabled=false;
  try { enabled=new URLSearchParams(location.search).get("zpPerf")==="1"; } catch(e) {}
  if(!enabled) return;

  const started=performance.now();
  const records=[];
  const cleanPath=value=>{
    try {
      const u=new URL(value,location.href);
      if(u.origin!==location.origin || !u.pathname.startsWith("/api/")) return null;
      // Keep endpoint names, but redact path segments that could be record/user identifiers.
      const path=u.pathname.split("/").map((part,i)=>{
        if(i<3 || !part) return part;
        if(/^(\d{4,}|[a-f0-9-]{16,}|[A-Za-z0-9_-]{24,})$/i.test(part)) return ":redacted";
        return part;
      }).join("/");
      return path;
    } catch(e) { return null; }
  };
  const originalFetch=window.fetch;
  window.fetch=function(input,init){
    const raw=typeof input==="string" ? input : (input&&input.url)||"";
    const path=cleanPath(raw);
    if(!path) return originalFetch.apply(this,arguments);
    const t0=performance.now();
    return originalFetch.apply(this,arguments).then(response=>{
      let st=response.headers.get("Server-Timing")||"";
      const row={type:"api",path:path,method:String((init&&init.method)||(input&&input.method)||"GET").toUpperCase(),
        status:response.status,ms:Number((performance.now()-t0).toFixed(1)),serverTiming:st.slice(0,160)};
      records.push(row);
      console.info("[ZP-PERF]",row);
      return response;
    },error=>{
      const row={type:"api",path:path,method:String((init&&init.method)||(input&&input.method)||"GET").toUpperCase(),
        status:"network-error",ms:Number((performance.now()-t0).toFixed(1)),serverTiming:""};
      records.push(row);
      console.warn("[ZP-PERF]",row);
      throw error;
    });
  };
  const report=()=>{
    const nav=performance.getEntriesByType("navigation")[0];
    const result={enabled:true,page:location.pathname,elapsedMs:Number((performance.now()-started).toFixed(1)),
      navigation:nav?{responseMs:Number(nav.responseEnd.toFixed(1)),domContentLoadedMs:Number(nav.domContentLoadedEventEnd.toFixed(1)),
        loadMs:Number(nav.loadEventEnd.toFixed(1)),transferBytes:nav.transferSize||null}:null,
      apiCount:records.length,api:records.slice()};
    window.__zpPerfReport=result;
    console.info("[ZP-PERF-REPORT]",result);
    return result;
  };
  window.__zpPerfReportNow=report;
  window.addEventListener("load",()=>{setTimeout(report,0);});
  window.addEventListener("pagehide",report);
  console.info("[ZP-PERF] 本地诊断已开启；仅记录 API 路径、耗时、状态码与 Server-Timing，不上传数据。执行 __zpPerfReportNow() 可查看报告。");
})();