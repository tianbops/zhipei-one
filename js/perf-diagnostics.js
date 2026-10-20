/* 智配One · 匿名性能遥测
 * 自动记录页面导航与同源 API 的耗时/状态分类；仅传固定枚举和数值，不传 URL、查询参数、正文、身份或凭证。
 * ?zpPerf=1 仅开启本地控制台报告，不改变上传字段。
 */
(function(){
  "use strict";
  var debug=false;
  try{debug=new URLSearchParams(location.search).get("zpPerf")==="1"}catch(e){}
  var page="other";
  var path=location.pathname;
  if(path==="/"||path==="/index.html"||path==="/login")page="login";
  else if(path.indexOf("history")>=0)page="history";
  else if(path.indexOf("dispatch")>=0||path.indexOf("routes")>=0)page="routes";
  else if(path.indexOf("account")>=0||path.indexOf("me")>=0)page="account";
  else if(path==="/home"||path==="/home.html"||path.indexOf("today")>=0)page="home";
  if(page==="other")return;
  var rows=[],started=performance.now(),sent=0;
  var classify=function(url){
    try{
      var u=new URL(url,location.href);
      if(u.origin!==location.origin||!u.pathname.startsWith("/api/")||u.pathname==="/api/perf-event")return null;
      var p=u.pathname;
      if(p.indexOf("/api/home")===0)return "api-home";
      if(p.indexOf("/api/history")===0)return "api-history";
      if(p.indexOf("/api/dispatch")===0||p.indexOf("/api/routes")===0)return "api-routes";
      if(p.indexOf("/api/me")===0||p.indexOf("/api/account")===0)return "api-account";
      if(p.indexOf("/api/waybill")===0||p.indexOf("/api/waybills")===0)return "api-waybills";
      if(p.indexOf("/api/login")===0||p.indexOf("/api/session")===0)return "api-auth";
      return "api-other";
    }catch(e){return null}
  };
  var statusClass=function(status){if(status==="network")return "network";if(status>=500)return "5xx";if(status>=400)return "4xx";if(status>=300)return "3xx";return "2xx"};
  var push=function(endpoint,status,duration,server){
    if(rows.length>=25)return;
    var row={page:page,endpoint:endpoint,status:statusClass(status),duration:Math.max(0,Math.min(120000,Math.round(duration*10)/10)),server:server};
    rows.push(row);
    if(debug)console.info("[ZP-PERF]",row);
  };
  var originalFetch=window.fetch;
  window.fetch=function(input,init){
    var raw=typeof input==="string"?input:(input&&input.url)||"";
    var endpoint=classify(raw);
    if(!endpoint)return originalFetch.apply(this,arguments);
    var t0=performance.now();
    return originalFetch.apply(this,arguments).then(function(response){
      var header=response.headers.get("Server-Timing")||"";
      var match=header.match(/(?:^|[,;\s])app;dur=([\d.]+)/);
      var server=match&&Number.isFinite(Number(match[1]))?Number(match[1]):null;
      push(endpoint,response.status,performance.now()-t0,server);
      return response;
    },function(error){push(endpoint,"network",performance.now()-t0,null);throw error});
  };
  var originalSend=originalFetch.bind(window);
  var flushing=false;
  var flush=function(){
    if(flushing||!rows.length)return;
    flushing=true;
    var batch=rows.splice(0,25);
    try{
      originalSend("/api/perf-event",{method:"POST",credentials:"same-origin",cache:"no-store",keepalive:true,
        headers:{"Content-Type":"application/json"},body:JSON.stringify({events:batch})})
        .then(function(r){if(!r.ok&&debug)console.warn("[ZP-PERF] telemetry rejected",r.status);})
        .catch(function(){})
        .finally(function(){flushing=false;if(rows.length)flush()});
    }catch(e){flushing=false}
  };
  var nav=performance.getEntriesByType("navigation")[0];
  window.addEventListener("load",function(){
    var duration=nav?Math.max(nav.loadEventEnd,nav.domContentLoadedEventEnd,nav.responseEnd):performance.now()-started;
    push("page-load",200,duration,null);
    if(debug)window.__zpPerfReportNow=function(){return {page:page,elapsedMs:Math.round((performance.now()-started)*10)/10,queuedEvents:rows.slice(),sentBatches:sent}};
    setTimeout(flush,3000);
  },{once:true});
  window.addEventListener("pagehide",flush);
  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")flush()});
  setInterval(function(){if(rows.length)flush()},15000);
})();