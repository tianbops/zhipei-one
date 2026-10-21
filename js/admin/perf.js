/* admin/perf.js —— 性能监测：/api/perf-report 汇总与接口耗时明细
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
async function renderPerfReport(){
  const summary=$("perfSummary"),endpoints=$("perfEndpoints"),phases=$("perfPhases"),updated=$("perfUpdated");
  window.__zpPerfCopyText="智配One 性能诊断报告\n状态：正在读取数据…";
  summary.innerHTML='<div class="empty">正在读取最近24小时性能数据…</div>';endpoints.innerHTML="";phases.innerHTML="";
  try{
    const d=await api("/api/perf-report?adminView="+Date.now());
    if(!d.success||!d.totals)throw Error("性能报告格式异常");
    const t=d.totals,hours=Array.isArray(t.hours)?t.hours:[],groups=hours.flatMap(h=>Array.isArray(h.groups)?h.groups:[]);
    const failures=Object.entries(t.statuses||{}).filter(([s])=>s==="4xx"||s==="5xx"||s==="network").reduce((n,[,v])=>n+(Number(v)||0),0);
    const reportLines=["智配One 性能诊断报告","生成时间："+(d.generatedAt?new Date(d.generatedAt).toLocaleString():"时间未知"),"统计窗口：最近24小时","请求样本："+Number(t.events||0),"状态统计："+Object.entries(t.statuses||{}).map(([k,v])=>k+"="+v).join("，"),"失败/异常状态："+failures,"","接口耗时（平均 / 峰值 / 服务端平均）"];
    summary.innerHTML='<div class="perf-stat"><strong>'+Number(t.events||0)+'</strong><span>请求样本</span></div><div class="perf-stat"><strong class="'+(failures?'perf-warn':'')+'">'+failures+'</strong><span>失败/异常状态</span></div><div class="perf-stat"><strong>24h</strong><span>统计窗口</span></div>';
    updated.textContent="报告生成："+(d.generatedAt?new Date(d.generatedAt).toLocaleString():"时间未知")+" · 自动匿名汇总";
    const em=new Map();
    for(const g of groups){
      const key=String(g.endpoint||"未知接口"),x=em.get(key)||{count:0,sum:0,max:0,serverCount:0,serverSum:0,failures:0,codes:new Map()};
      const n=Number(g.count)||0;x.count+=n;x.sum+=(Number(g.avgMs)||0)*n;x.max=Math.max(x.max,Number(g.max)||0);
      const sc=Number(g.serverCount)||0;x.serverCount+=sc;x.serverSum+=(Number(g.serverAvgMs)||0)*sc;
      if(["4xx","5xx","network"].includes(g.status))x.failures+=n;
      for(const [code,c] of Object.entries(g.codes||{})){const cn=Number(c.count)||0;const prev=x.codes.get(code)||{count:0,sum:0};prev.count+=cn;prev.sum+=(Number(c.avgMs)||0)*cn;x.codes.set(code,prev);}
      em.set(key,x);
    }
    /* 异常状态码细分：把 4xx/5xx 汇总拆成具体 HTTP 状态码，
     * 便于区分「账户服务真的处理了并返回错误」与「网络层失败」。 */
    const codesText=function(x){const cs=[...x.codes.entries()].sort((a,b)=>b[1].count-a[1].count);return cs.length?"（"+cs.map(([c,v])=>c+"×"+v.count).join("，")+"）":""};
    const top=[...em.entries()].sort((a,b)=>(b[1].count?b[1].sum/b[1].count:0)-(a[1].count?a[1].sum/a[1].count:0)).slice(0,8);
    for(const [name,x] of top)reportLines.push(name+"：样本 "+x.count+"，平均 "+(x.count?Math.round(x.sum/x.count):0)+" ms，峰值 "+Math.round(x.max)+" ms，服务端平均 "+(x.serverCount?Math.round(x.serverSum/x.serverCount)+" ms（"+x.serverCount+"次）":"暂无")+(x.failures?"，异常 "+x.failures+codesText(x):""));
    const codeLines=[];for(const [name,x] of [...em.entries()])if(x.codes.size)codeLines.push(name+"：异常 "+x.failures+" "+codesText(x)+"，平均响应 "+(x.count?Math.round(x.sum/x.count):0)+" ms，服务端平均 "+(x.serverCount?Math.round(x.serverSum/x.serverCount)+" ms":"暂无"));
    if(codeLines.length)reportLines.push("","异常状态码细分（HTTP 状态码×次数，用于区分服务端拒绝与网络失败）",...codeLines);
    endpoints.innerHTML='<div class="perf-list-title">接口耗时 · 按平均耗时排序</div>'+(top.length?top.map(([name,x])=>'<div class="perf-row"><div class="perf-row-top"><span>'+esc(name)+'</span><span>'+(x.count?Math.round(x.sum/x.count):0)+' ms 平均</span></div><div class="perf-row-meta">样本 '+x.count+' · 峰值 '+Math.round(x.max)+' ms · 服务端 '+(x.serverCount?Math.round(x.serverSum/x.serverCount)+' ms 平均（'+x.serverCount+'次）':'暂无服务端计时')+(x.failures?' · 异常 '+x.failures+codesText(x):'')+'</div></div>').join(""):'<div class="empty">最近24小时暂无接口样本</div>');
    const pm=new Map();
    for(const g of groups)for(const [name,p] of Object.entries(g.phases||{})){
      const x=pm.get(name)||{count:0,sum:0,max:0},n=Number(p.count)||0;x.count+=n;x.sum+=(Number(p.avgMs)||0)*n;x.max=Math.max(x.max,Number(p.max)||0);pm.set(name,x);
    }
    const ps=[...pm.entries()].sort((a,b)=>(b[1].count?b[1].sum/b[1].count:0)-(a[1].count?a[1].sum/a[1].count:0));
    reportLines.push("","历史查询阶段耗时（平均 / 峰值）");for(const [name,x] of ps)reportLines.push(name+"：样本 "+x.count+"，平均 "+(x.count?Math.round(x.sum/x.count):0)+" ms，峰值 "+Math.round(x.max)+" ms");reportLines.push("","说明：匿名聚合数据；不同时间段样本不一定可直接比较。");window.__zpPerfCopyText=reportLines.join("\n");
    phases.innerHTML=ps.length?'<div class="perf-list-title">历史查询阶段耗时</div>'+ps.map(([name,x])=>'<div class="perf-row"><div class="perf-row-top"><span>'+esc(name)+'</span><span>'+(x.count?Math.round(x.sum/x.count):0)+' ms 平均</span></div><div class="perf-row-meta">样本 '+x.count+' · 峰值 '+Math.round(x.max)+' ms</div></div>').join(""):"";
  }catch(e){
    updated.textContent="读取失败："+(e.message||"请稍后重试");window.__zpPerfCopyText="智配One 性能诊断报告\n读取失败："+(e.message||"请稍后重试");
    summary.innerHTML='<div class="empty">性能报告暂时不可用。请确认管理员会话有效后重试。</div>';
  }
}
A.renderPerfReport=renderPerfReport;
})(window.ZPAdmin);
