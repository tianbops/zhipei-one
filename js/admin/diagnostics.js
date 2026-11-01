/* admin/diagnostics.js —— 运单诊断：按线路/日期/车牌查询并展示阶段耗时
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
const formatTimingMs=value=>{const n=Number(value);if(!Number.isFinite(n)||n<0)return "-";return n<10?new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(n):String(Math.round(n));};
const formatBeijingTime=(value,explicit)=>{const raw=explicit||value;if(!raw)return "-";const date=new Date(raw);if(!Number.isFinite(date.getTime()))return String(raw);return new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(date)+"（北京时间）";};
const eventText=e=>{const t=e?.timing&&typeof e.timing==="object"?e.timing:null;const attempt=t?[["准备+识别",t.recognizedMs],["OCR",t.ocrMs],["提取",t.extractMs],["匹配",t.matchMs],["去重",t.dedupeMs],["规划",t.planMs],["保存",t.saveStages?.totalMs],["本次总计",t.totalMs]].filter(x=>typeof x[1]==="number"&&Number.isFinite(x[1])&&x[1]>=0).map(x=>x[0]+" "+formatTimingMs(x[1])+"ms").join(" · "):"";return [(e?.event||"-"),(e?.reuse?"复用运单ID："+e.reuse:""),(e?.dedupe?"去重方式："+e.dedupe:""),(attempt?"本次尝试耗时："+attempt:""),(e?.t?formatBeijingTime(e.t,e.tBeijing):"")].filter(Boolean).join(" · ");};
async function renderProcTicket(requestId){
  if(!requestId)return;
  $("diagnostics").innerHTML='<div class="zp-empty">正在读取处理票据…</div>';
  let d;
  try{d=await api("/api/waybills/diagnostic?requestId="+encodeURIComponent(requestId))}
  catch(e){$("diagnostics").innerHTML='<div class="zp-empty">处理票据读取失败：'+esc(e.message)+'</div><button class="small-action" id="diagTicketBack" type="button">返回诊断列表</button>';const back=$("diagTicketBack");if(back)back.onclick=renderDiagnostics;return}
  const t=d.procTicket||{},timing=t.timing&&typeof t.timing==="object"?t.timing:{};
  const timingLabels={ocrImageCount:"OCR图片数",ocrSubmitMs:"OCR提交累计",ocrStatusPollCount:"状态轮询次数",ocrStatusWaitMs:"轮询等待累计",ocrStatusRequestMs:"状态请求累计",ocrResultFetchMs:"结果读取累计",ocrResultRequestMs:"结果响应头等待",ocrResultBodyMs:"正文读取累计",ocrResultParseMs:"结果解析累计",ocrResultChars:"结果字符数",ocrResultFetchWaitMs:"结果重试等待",ocrResultFetchAttempts:"结果读取尝试数",recognizedMs:"识别总计",ocrMs:"OCR墙钟总计",baseMs:"基准读取",extractMs:"文本提取",matchMs:"门店匹配",dedupeMs:"去重",planMs:"线路规划",totalMs:"处理总计"};
  const timingLines=Object.entries(timing).filter(([k,v])=>Object.prototype.hasOwnProperty.call(timingLabels,k)&&typeof v==="number"&&Number.isFinite(v)&&v>=0).map(([k,v])=>timingLabels[k]+"："+formatTimingMs(v)+(k==="ocrImageCount"?"张":k==="ocrResultChars"?"字符":k.endsWith("Count")||k.endsWith("Attempts")?"次":"ms"));
  const copyText=["智配One 失败/超时处理诊断","requestId："+(d.requestId||requestId),"处理阶段："+(t.stage||d.effectiveStage||"-"),"错误详情："+(t.detail||"-"),"线路ID："+(t.routeId||"-"),"创建时间："+formatBeijingTime(t.createdAt,t.createdAtBeijing),"更新时间："+formatBeijingTime(t.updatedAt,t.updatedAtBeijing),"提示："+(t.hint||"-"),"阶段耗时："+(timingLines.join(" · ")||"暂无已保存阶段耗时"),"完整处理票据数据：",JSON.stringify(d,null,2)].join("\n");
  $("diagnostics").innerHTML='<div class="row diag-card"><div class="content"><div class="main"><strong>处理票据 · '+esc(t.stage||d.effectiveStage||"-")+'</strong></div><div class="meta">线路：'+esc(t.routeName||t.routeId||"-")+' · 更新时间：'+esc(formatBeijingTime(t.updatedAt,t.updatedAtBeijing))+'</div><div class="meta">失败详情：'+esc(t.detail||t.hint||"-")+'</div><div class="diag-timing">'+timingLines.map(x=>'<span>'+esc(x)+'</span>').join("")+'</div><div class="diag-actions"><button class="small-action" id="diagTicketCopy" type="button">复制完整诊断</button><button class="small-action" id="diagTicketBack" type="button">返回列表</button></div></div></div>';
  const copy=$("diagTicketCopy");
  if(copy)copy.onclick=async()=>{let copied=false;try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(copyText);copied=true}}catch(e){}if(!copied){const ta=document.createElement("textarea");ta.value=copyText;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.opacity="0";ta.style.left="-9999px";document.body.appendChild(ta);ta.select();try{copied=document.execCommand("copy")}catch(e){}ta.remove()}toast(copied?"诊断结果已复制":"复制失败，请长按文本手动复制")};
  const back=$("diagTicketBack");if(back)back.onclick=renderDiagnostics;
}
async function renderDiagnostics(){
  const routeId=($("diagRoute").value||"").trim();
  const selectedRoute=(S.routes||[]).find(r=>String(r.id)===routeId);
  if(!routeId||!selectedRoute){$("diagnostics").innerHTML='<div class="zp-empty">'+(S.routes&&S.routes.length?"请选择一条有效线路":"线路列表尚未加载，或当前没有可选线路")+'</div>';return}
  const date=($("diagDate").value||"").trim();
  if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)){$("diagnostics").innerHTML='<div class="zp-empty">日期格式无效，请选择有效日期</div>';return}
  $("diagRouteMeta").textContent="当前线路："+(rn(selectedRoute.name)||selectedRoute.name||"未命名线路");
  let q="/api/waybills/diagnostic?routeId="+encodeURIComponent(routeId);
  if(date)q+="&date="+encodeURIComponent(date);

  $("diagnostics").innerHTML='<div class="zp-empty">正在查询运单…</div>';
  let d;try{d=await api(q)}catch(e){$("diagnostics").innerHTML='<div class="zp-empty">查询失败：'+esc(e.message)+'</div>';return}
  const list=d.waybills||[];
  const failures=Array.isArray(d.failures)?d.failures:[];
  if(!list.length&&!failures.length){const scope=date?"日期 "+date+" · ":"";$("diagnostics").innerHTML='<div class="zp-empty">'+esc(scope)+(date?"该线路在所选日期没有匹配到运单。":"该线路暂无匹配运单。")+'<br>如确认当天已有运单，可继续检查运单索引一致性。</div>';return}
  const copyPayloads=[];
  const truncHint=(d.truncated&&Number(d.count)>list.length)?'<div class="zp-empty" class="diag-trunc-hint">共 '+esc(d.count)+' 张运单，当前仅显示最近 20 张</div>':"";
  const timingNote='<details class="diag-details diag-timing-note"><summary>计时口径说明</summary><div class="meta">“准备+识别累计”包含图片暂存与 OCR 阶段；“R2暂存”是其中的子阶段，不要与累计值相加。“OCR墙钟”仅表示 OCR 阶段墙钟耗时。多图 OCR 的提交、状态和结果耗时为各图片累计值，不等于实际等待时间；结果读取累计包含响应头等待、正文读取和解析；“结果响应头等待”仅统计 fetch 收到响应头之前的等待，不含正文传输。计时分辨率会随运行环境显示；若使用 Date.now()，0ms 可能表示低于约 1ms 的计时分辨率。阶段计时仅展示已保存数据，“处理总计”不包含最终保存阶段耗时。</div></details>';
  $("diagnostics").innerHTML=timingNote+truncHint+list.map(w=>{
    const lvl=(w.quality&&w.quality.level)||"OK";const ql=lvl==="REVIEW"?"review":"ok";
    const flags=(w.quality&&w.quality.flags||[]).join("、")||"正常";
    const evs=(w.events||[]).slice(-8).reverse().map(e=>esc(eventText(e))).join("<br>");
    const t=w.timing&&typeof w.timing==="object"?w.timing:null;
    const timingParts=t?[["OCR图片","ocrImageCount"],["准备+识别累计","recognizedMs"],["R2暂存","r2StageMs"],["R2暂存字节","r2StageBytes"],["OCR墙钟","ocrMs"],["提交累计","ocrSubmitMs"],["轮询次数","ocrStatusPollCount"],["轮询等待累计","ocrStatusWaitMs"],["状态请求累计","ocrStatusRequestMs"],["批量状态请求次数","ocrStatusBatchRequestCount"],["单任务回退请求次数","ocrStatusFallbackRequestCount"],["普通单任务请求次数","ocrStatusSingleRequestCount"],["批量响应任务条目数","ocrStatusBatchResponseJobCount"],["批量命中任务数","ocrStatusBatchMatchedJobCount"],["批量缺失任务数","ocrStatusBatchMissingJobCount"],["结果读取累计","ocrResultFetchMs"],["结果请求累计","ocrResultRequestMs"],["正文读取累计","ocrResultBodyMs"],["结果解析累计","ocrResultParseMs"],["结果字符","ocrResultChars"],["结果重试等待","ocrResultFetchWaitMs"],["结果读取尝试","ocrResultFetchAttempts"],["基准","baseMs"],["基准读取","baseLookupMs"],["索引编译","baseIndexMs"],["OCR后等待","baseWaitMs"],["OCR重叠","baseOverlapMs"],["提取","extractMs"],["匹配","matchMs"],["去重","dedupeMs"],["规划","planMs"],["处理总计","totalMs"]].filter(x=>typeof t[x[1]]==="number"&&Number.isFinite(t[x[1]])&&t[x[1]]>=0).map(x=>x[0]+" "+formatTimingMs(t[x[1]])+(x[1]==="r2StageBytes"?" bytes":x[0]==="OCR图片"?"张":x[0]==="结果字符"?"字符":(/次数$|尝试$|任务数$/.test(x[0])?"次":(/条目数$/.test(x[0])?"条":"ms")))):[];
    const compactTimingKeys=["recognizedMs","ocrMs","extractMs","matchMs","dedupeMs","planMs","totalMs"];
    const compactTimingLabels={recognizedMs:"准备+识别累计",ocrMs:"OCR",extractMs:"提取",matchMs:"匹配",dedupeMs:"去重",planMs:"规划",totalMs:"总计"};
    const compactTiming=compactTimingKeys.filter(k=>typeof t?.[k]==="number"&&Number.isFinite(t[k])&&t[k]>=0).map(k=>compactTimingLabels[k]+" "+formatTimingMs(t[k])+"ms");
    const timingHtml=compactTiming.length?'<div class="diag-timing">'+compactTiming.map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>':'<div class="meta">暂无阶段计时</div>';
    const timingResolution=typeof t?.timingResolutionMs==="number"?" · 计时分辨率约 "+formatTimingMs(t.timingResolutionMs)+"ms（"+(t.timingClock==="performance.now"?"高精度单调时钟":"毫秒墙钟回退")+"）":"";
    const detailTimingHtml=timingParts.length?'<div class="meta diag-full-timing">完整阶段耗时：'+esc(timingParts.map(([label,key])=>label+" "+(key==="r2StageBytes"?(Number(t[key])||0)+" bytes":formatTimingMs(t[key])+(key==="ocrImageCount"?"张":key==="ocrResultChars"?"字符":(/次数$|尝试$|任务数$/.test(label)?"次":(/条目数$/.test(label)?"条":"ms"))))).join(" · ")+timingResolution)+'</div>':'<div class="meta">暂无完整阶段计时</div>';
    const imageTimingLines=Array.isArray(t?.ocrImageTimings)?t.ocrImageTimings.map(x=>"图"+(x.imageIndex||"-")+"："+(x.statusMode==="batch"?"批量状态":x.statusMode==="fallback"?"单任务回退":"普通单任务")+" · 提交 "+formatTimingMs(x.submitMs)+"ms · 状态请求 "+formatTimingMs(x.statusRequestMs)+"ms（"+(Number(x.batchStatusRequestCount)||0)+"批量/"+(Number(x.fallbackStatusRequestCount)||0)+"回退） · 结果读取 "+formatTimingMs(x.resultFetchMs)+"ms · 结果字符 "+(Number(x.resultChars)||0)).slice(0,20):[];
    const fieldEvidence=w.ocr&&w.ocr.fieldEvidence&&typeof w.ocr.fieldEvidence==="object"?w.ocr.fieldEvidence:null;
    const ocrLines=Array.isArray(w.ocr?.lineEvidence)?w.ocr.lineEvidence:[];
    const fieldLabels={date:"日期",vehicle:"车牌",driver:"司机",deliveryPerson:"送货员",totalWeight:"总重量"};
    const sourceLabels={ocr:"OCR原文",manual:"人工填写",unavailable:"未关联原文"};
    const fieldEvidenceLines=fieldEvidence&&Array.isArray(fieldEvidence.fields)?fieldEvidence.fields.map(f=>{
      const label=fieldLabels[f.field]||f.field||"字段";
      const refs=(Array.isArray(f.evidence)?f.evidence:[]).map(ref=>{
        const line=ocrLines[Number(ref.lineIndex)];
        if(!line)return null;
        const score=Number.isFinite(line.score)?" · 模型分数 "+line.score.toFixed(3):" · 无模型分数";
        return String(line.text||"").slice(0,120)+score;
      }).filter(Boolean);
      return label+"："+(f.value??"-")+" · "+(sourceLabels[f.source]||"未知来源")+(refs.length?" · "+refs.join("；"):"");
    }):[];
    const allMissingStoreEvidence=fieldEvidence&&Array.isArray(fieldEvidence.stores)?fieldEvidence.stores.filter(s=>s.source==="unavailable").map(s=>s.rawName||s.name||s.storeId||"未命名门店").slice(0,30):[];
    const missingStoreEvidence=allMissingStoreEvidence.slice(0,8);
    const missingStoreEvidenceRemaining=Math.max(0,allMissingStoreEvidence.length-missingStoreEvidence.length);
    const storeEvidenceLines=fieldEvidence&&Array.isArray(fieldEvidence.stores)?fieldEvidence.stores.slice(0,30).map(store=>{
      const refs=(Array.isArray(store.evidence)?store.evidence:[]).map(ref=>{
        const line=ocrLines[Number(ref.lineIndex)];
        if(!line)return null;
        const image=Number.isInteger(line.imageIndex)&&line.imageIndex>0?"图"+line.imageIndex:"图片未知";
        const score=Number.isFinite(line.score)?" · 模型分数 "+line.score.toFixed(3):" · 无模型分数";
        return "["+image+"] "+String(line.text||"").slice(0,120)+score;
      }).filter(Boolean);
      const name=store.rawName||store.name||store.storeId||"未命名门店";
      return "门店#"+(store.index||"-")+"："+name+" · "+(sourceLabels[store.source]||"未知来源")+(refs.length?" · "+refs.join("；"):"");
    }):[];

    const fieldEvidenceSummary=fieldEvidence&&fieldEvidence.summary
      ?"抬头字段 "+(fieldEvidence.summary.fieldsWithEvidence||0)+"/"+(fieldEvidence.summary.fieldCount||0)+" · 门店 "+(fieldEvidence.summary.storesWithEvidence||0)+"/"+(fieldEvidence.stores?.length||0)
      :null;
    const fieldEvidenceHtml=fieldEvidence
      ?'<div class="meta">OCR证据关联：'+esc(fieldEvidenceSummary||"暂无汇总")+'</div>'
        +fieldEvidenceLines.map(line=>'<div class="meta">'+esc(line)+'</div>').join("")
        +(missingStoreEvidence.length?'<div class="meta">门店未关联原文（展示前8条'+(missingStoreEvidenceRemaining?"，另有 "+missingStoreEvidenceRemaining+" 条":"")+(missingStoreEvidenceRemaining?"；复制诊断可查看完整清单":"")+'）：'+esc(missingStoreEvidence.join("、"))+"</div>": "")
      :"";

    const copyLines=[
      "智配One 运单诊断",
      "日期："+(w.date||"-"),
      "车辆："+(w.vehicle||"-"),
      "线路ID："+(w.routeId||"-"),
      "阶段："+(w.stage||"-"),
      "requestId："+(w.requestId||"-"),
      "质量："+lvl+(flags&&flags!=="正常"?" · "+flags:""),
      "耗时："+(timingParts.length?timingParts.join(" · "):"暂无阶段计时记录"),
      "逐图OCR耗时："+(imageTimingLines.join("；")||"暂无逐图计时"),
      "OCR证据关联："+(fieldEvidenceSummary||"暂无"),
      ...fieldEvidenceLines,
      "门店证据摘要（完整数据见JSON）：",
      ...storeEvidenceLines,
      ...(fieldEvidence&&Array.isArray(fieldEvidence.stores)&&fieldEvidence.stores.length>storeEvidenceLines.length?["其余门店证据未导出："+(fieldEvidence.stores.length-storeEvidenceLines.length)+"条"]:[]),
      ...(allMissingStoreEvidence.length?["门店未关联原文："+allMissingStoreEvidence.join("、")]:[]),
      "事件："+((w.events||[]).slice(-8).reverse().map(eventText).join("；")||"无"),
      "",
      "完整诊断数据（JSON）：",
      JSON.stringify(w,null,2)
    ].join("\n");
    const copyIndex=copyPayloads.push(copyLines)-1;
    const detailHtml='<details class="diag-details"><summary>查看完整诊断详情</summary>'+detailTimingHtml+(imageTimingLines.length?'<div class="meta diag-full-timing">逐图OCR耗时：'+esc(imageTimingLines.join("；"))+'</div>':"")+fieldEvidenceHtml+(evs?'<div class="evt">'+evs+'</div>':'')+'</details>';
    return '<div class="row diag-card"><div class="content" style="display:block;width:100%"><div class="main"><strong>'+esc(w.date||"-")+' · '+esc(w.vehicle||"-")+'</strong>'
      +'<span class="q-badge '+ql+'">'+esc(ql.toUpperCase())+(w.quality&&w.quality.flags&&w.quality.flags.length?(" · "+esc(flags)):"")+'</span></div>'
      +'<div class="meta">'+esc(w.stage||"处理阶段未知")+'</div>'
      +timingHtml+detailHtml
      +'<div class="diag-actions"><button class="small-action diag-copy" type="button" data-copy-index="'+copyIndex+'">复制完整诊断</button></div></div></div>';
  }).join("");
  const failureHtml=failures.length?'<div class="meta diag-failure-heading">失败处理记录（'+esc(failures.length)+'）</div>'+failures.map((f,index)=>{
    const o=f.order||{},dg=o.diagnostics||{},v=f.validation||o.validation||{},stores=Array.isArray(dg.finalItems)?dg.finalItems:(Array.isArray(o.stores)?o.stores:[]);
    const label=f.stage==="TIMEOUT"?"处理超时":f.stage==="CANCELLED"?"用户取消":"处理失败";
    const reason=f.detail||f.hint||f.code||"未记录";
    const validationErrors=Array.isArray(v.errors)?v.errors:[];
    return '<div class="row diag-failure-card"><div class="content">'
      +'<div class="main"><strong>'+esc(f.date||"-")+' · '+esc(f.vehicle||"车牌未识别")+'</strong><span class="q-badge review">'+esc(label)+'</span></div>'
      +'<div class="diag-failure-reason"><span class="diag-failure-label">失败原因</span><span class="diag-failure-text">'+esc(reason)+'</span></div>'
      +'<div class="diag-failure-meta">'
      +'<div class="diag-failure-field"><span class="diag-failure-label">上传时间</span><span class="diag-failure-value">'+esc(formatBeijingTime(f.uploadedAt,f.uploadedAtBeijing))+'</span></div>'
      +'<div class="diag-failure-field"><span class="diag-failure-label">错误代码</span><span class="diag-failure-value diag-failure-code">'+esc(f.code||"-")+'</span></div></div>'
      +'<div class="diag-failure-stats">'
      +'<div class="diag-failure-stat"><span>提取门店</span><strong>'+esc(dg.extractCount??"-")+'</strong></div>'
      +'<div class="diag-failure-stat"><span>去重前</span><strong>'+esc(dg.dedupeBefore??"-")+'</strong></div>'
      +'<div class="diag-failure-stat"><span>去重后</span><strong>'+esc(dg.dedupeAfter??"-")+'</strong></div>'
      +'<div class="diag-failure-stat is-final"><span>最终门店</span><strong>'+esc(stores.length)+'</strong></div></div>'
      +(validationErrors.length?'<details class="diag-details diag-failure-details"><summary>查看校验信息（'+esc(validationErrors.length)+'）</summary><div class="meta">'+esc(validationErrors.join("、"))+'</div></details>':"")
      +'<div class="diag-actions">'+(f.requestId?'<button class="small-action diag-ticket-open" data-ticket-index="'+index+'" type="button">查看处理票据</button>':'')+'<button class="small-action diag-failure-copy" type="button">复制完整失败诊断</button></div>'
      +'</div></div>';
  }).join(""):"";
    $("diagnostics").innerHTML += (d.failureQueryError?'<div class="zp-empty">失败记录暂时无法读取，正常运单诊断仍可查看，请稍后刷新。</div>':"") + failureHtml;
  document.querySelectorAll("#diagnostics .diag-ticket-open").forEach(btn=>btn.onclick=()=>{const index=Number(btn.getAttribute("data-ticket-index"));const failure=failures[index];if(failure?.requestId)renderProcTicket(failure.requestId)});
  document.querySelectorAll("#diagnostics .diag-failure-copy").forEach((btn,index)=>btn.onclick=async()=>{
    const value=["智配One 失败运单诊断","完整失败记录（JSON）：",JSON.stringify(failures[index],null,2)].join("\\n");
    let copied=false;
    try{await navigator.clipboard.writeText(value);copied=true;}catch(e){}
    if(!copied){const ta=document.createElement("textarea");ta.value=value;document.body.appendChild(ta);ta.select();try{copied=document.execCommand("copy")}catch(e){}ta.remove();}
    toast(copied?"失败诊断已复制":"复制失败，请长按文本手动复制");
  });
  document.querySelectorAll("#diagnostics .diag-copy").forEach(btn=>btn.onclick=async()=>{
    let copied=false;
    let value="";
    const copyIndex=Number(btn.getAttribute("data-copy-index"));
    if(!Number.isInteger(copyIndex)||copyIndex<0||copyIndex>=copyPayloads.length){try{toast("诊断内容读取失败，请刷新后重试");}catch(e){}return;}
    value=copyPayloads[copyIndex];
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(value);copied=true;}
    }catch(e){}
    if(!copied){
      let ta=null;
      try{
        ta=document.createElement("textarea");
        ta.value=value;ta.setAttribute("readonly","");
        ta.style.position="fixed";ta.style.opacity="0";ta.style.left="-9999px";
        document.body.appendChild(ta);ta.select();
        try{copied=document.execCommand("copy")}catch(e){}
      }catch(e){}
      finally{try{if(ta&&ta.parentNode)ta.parentNode.removeChild(ta);}catch(e){}}
    }
    try{toast(copied?"诊断结果已复制":"复制失败，请长按文本手动复制");}catch(e){}
  });
}
A.renderDiagnostics=renderDiagnostics;
A.renderProcTicket=renderProcTicket;
})(window.ZPAdmin);
