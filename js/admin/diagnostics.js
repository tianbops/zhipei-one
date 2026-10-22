/* admin/diagnostics.js —— 运单诊断：按线路/日期/车牌查询并展示阶段耗时
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
async function renderDiagnostics(){
  const requestId=($("diagRequestId")?.value||"").trim();
  if(requestId){
    $("diagRouteMeta").textContent="按 requestId 查询失败/超时处理票据";
    $("diagnostics").innerHTML='<div class="empty">正在查询处理票据…</div>';
    let d;
    try{d=await api("/api/waybills/diagnostic?requestId="+encodeURIComponent(requestId))}
    catch(e){$("diagnostics").innerHTML='<div class="empty">查询失败：'+esc(e.message)+'</div>';return}
    const t=d.procTicket||{};
    const timing=t.timing&&typeof t.timing==="object"?t.timing:{};
    const timingLabels={ocrSubmitMs:"OCR提交",ocrStatusPollCount:"状态轮询次数",ocrStatusWaitMs:"轮询等待",ocrStatusRequestMs:"状态请求",ocrResultFetchMs:"结果读取",ocrResultFetchAttempts:"结果读取次数",recognizedMs:"识别总计",ocrMs:"OCR总计",baseMs:"基准读取",extractMs:"文本提取",matchMs:"门店匹配",dedupeMs:"去重",planMs:"线路规划",totalMs:"处理总计"};
    const timingLines=Object.entries(timing).filter(([k,v])=>Object.prototype.hasOwnProperty.call(timingLabels,k)&&typeof v==="number"&&Number.isFinite(v)&&v>=0).map(([k,v])=>timingLabels[k]+(k.endsWith("Count")||k.endsWith("Attempts")?"：":"：")+Math.round(v)+(k.endsWith("Count")||k.endsWith("Attempts")?"次":"ms"));
    const copyText=["智配One 失败/超时处理诊断","requestId："+(d.requestId||requestId),"处理阶段："+(t.stage||d.effectiveStage||"-"),"错误详情："+(t.detail||"-"),"线路ID："+(t.routeId||"-"),"创建时间："+(t.createdAt||"-"),"更新时间："+(t.updatedAt||"-"),"提示："+(t.hint||"-"),"阶段耗时："+(timingLines.join(" · ")||"暂无已保存阶段耗时")].join("\n");
    $("diagnostics").innerHTML='<div class="row"><div class="content" style="display:block;width:100%"><div class="main"><strong>处理票据 · '+esc(t.stage||d.effectiveStage||"-")+'</strong></div><div class="meta">requestId：'+esc(d.requestId||requestId)+'</div><div class="meta">线路ID：'+esc(t.routeId||"-")+' · 更新时间：'+esc(t.updatedAt||"-")+'</div><div class="meta">提示：'+esc(t.hint||"-")+'</div><div class="meta">阶段耗时：'+esc(timingLines.join(" · ")||"暂无已保存阶段耗时")+'</div><div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="small-action diag-ticket-copy" type="button">复制诊断</button></div></div></div>';
    const copyBtn=document.querySelector("#diagnostics .diag-ticket-copy");
    if(copyBtn)copyBtn.onclick=async()=>{
      let copied=false;
      try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(copyText);copied=true;}}catch(e){}
      if(!copied){const ta=document.createElement("textarea");ta.value=copyText;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.opacity="0";ta.style.left="-9999px";document.body.appendChild(ta);ta.select();try{copied=document.execCommand("copy")}catch(e){}ta.remove();}
      toast(copied?"诊断结果已复制":"复制失败，请长按文本手动复制");
    };
    return;
  }
  const routeId=($("diagRoute").value||"").trim();
  const selectedRoute=(S.routes||[]).find(r=>String(r.id)===routeId);
  if(!routeId||!selectedRoute){$("diagnostics").innerHTML='<div class="empty">'+(S.routes&&S.routes.length?"请选择一条有效线路":"线路列表尚未加载，或当前没有可选线路")+'</div>';return}
  const date=($("diagDate").value||"").trim(),vehicle=($("diagVehicle").value||"").trim();
  if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)){$("diagnostics").innerHTML='<div class="empty">日期格式无效，请选择有效日期</div>';return}
  $("diagRouteMeta").textContent="线路："+(rn(selectedRoute.name)||selectedRoute.name||routeId)+" · 线路ID："+routeId;
  let q="/api/waybills/diagnostic?routeId="+encodeURIComponent(routeId);
  if(date)q+="&date="+encodeURIComponent(date);
  if(vehicle)q+="&vehicle="+encodeURIComponent(vehicle);
  $("diagnostics").innerHTML='<div class="empty">正在查询运单…</div>';
  let d;try{d=await api(q)}catch(e){$("diagnostics").innerHTML='<div class="empty">查询失败：'+esc(e.message)+'</div>';return}
  const list=d.waybills||[];
  if(!list.length){const scope=(date?"日期 "+date+" · ":"")+(vehicle?"车牌 "+vehicle+" · ":"");$("diagnostics").innerHTML='<div class="empty">'+esc(scope)+(date?"该线路在所选日期没有匹配到运单。":"该线路暂无匹配运单。")+'<br>如确认当天已有运单，可继续检查运单索引一致性。</div>';return}
  const truncHint=(d.truncated&&Number(d.count)>list.length)?'<div class="empty" style="color:#e8b34b">共 '+esc(d.count)+' 张运单，当前仅显示最近 20 张</div>':"";
  const timingNote='<div class="meta" style="margin:6px 2px 10px">阶段计时仅展示记录中已保存的数据；“处理总计”不包含最终保存阶段耗时。</div>';
  $("diagnostics").innerHTML=timingNote+truncHint+list.map(w=>{
    const lvl=(w.quality&&w.quality.level)||"OK";const ql=lvl==="REVIEW"?"review":"ok";
    const flags=(w.quality&&w.quality.flags||[]).join("、")||"正常";
    const evs=(w.events||[]).slice(-8).reverse().map(e=>esc(e.event)+(e.t?" · "+esc(String(e.t).slice(11,19)):"")).join("<br>");
    const t=w.timing&&typeof w.timing==="object"?w.timing:null;
    const timingParts=t?[["识别","recognizedMs"],["OCR","ocrMs"],["提交","ocrSubmitMs"],["轮询次数","ocrStatusPollCount"],["轮询等待","ocrStatusWaitMs"],["状态请求","ocrStatusRequestMs"],["结果读取","ocrResultFetchMs"],["结果读取次数","ocrResultFetchAttempts"],["基准","baseMs"],["提取","extractMs"],["匹配","matchMs"],["去重","dedupeMs"],["规划","planMs"],["处理总计","totalMs"]].filter(x=>typeof t[x[1]]==="number"&&Number.isFinite(t[x[1]])&&t[x[1]]>=0).map(x=>x[0]+" "+Math.round(t[x[1]])+(/次数$/.test(x[0])?"":"ms")):[];
    const timingHtml=timingParts.length?'<div class="meta">耗时：'+esc(timingParts.join(" · "))+'</div>':'<div class="meta">暂无阶段计时记录（可能为旧运单，或该记录未保存计时）</div>';
    const copyLines=[
      "智配One 运单诊断",
      "日期："+(w.date||"-"),
      "车辆："+(w.vehicle||"-"),
      "线路ID："+(w.routeId||"-"),
      "阶段："+(w.stage||"-"),
      "requestId："+(w.requestId||"-"),
      "质量："+lvl+(flags&&flags!=="正常"?" · "+flags:""),
      "耗时："+(timingParts.length?timingParts.join(" · "):"暂无阶段计时记录"),
      "事件："+((w.events||[]).slice(-8).reverse().map(e=>(e.event||"-")+(e.t?" · "+String(e.t).slice(11,19):"")).join("；")||"无")
    ].join("\n");
    return '<div class="row"><div class="content" style="display:block;width:100%"><div class="main"><strong>'+esc(w.date||"-")+' · '+esc(w.vehicle||"-")+'</strong>'
      +'<span class="q-badge '+ql+'">'+esc(ql.toUpperCase())+(w.quality&&w.quality.flags&&w.quality.flags.length?(" · "+esc(flags)):"")+'</span></div>'
      +'<div class="meta">stage='+esc(w.stage||"-")+' · '+esc(w.routeId)+' · requestId '+esc(w.requestId||"-")+'</div>'
      +timingHtml+(evs?'<div class="evt">'+evs+'</div>':'')
      +'<div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="small-action diag-copy" type="button" data-copy="'+encodeURIComponent(copyLines)+'">复制诊断</button></div></div></div>';
  }).join("");
  document.querySelectorAll("#diagnostics .diag-copy").forEach(btn=>btn.onclick=async()=>{
    let copied=false;
    const value=decodeURIComponent(btn.getAttribute("data-copy")||"");
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(value);copied=true;}
    }catch(e){}
    if(!copied){
      const ta=document.createElement("textarea");
      ta.value=value;ta.setAttribute("readonly","");
      ta.style.position="fixed";ta.style.opacity="0";ta.style.left="-9999px";
      document.body.appendChild(ta);ta.select();
      try{copied=document.execCommand("copy")}catch(e){}
      ta.remove();
    }
    toast(copied?"诊断结果已复制":"复制失败，请长按文本手动复制");
  });
}
A.renderDiagnostics=renderDiagnostics;
})(window.ZPAdmin);
