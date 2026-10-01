const $=id=>document.getElementById(id);
const menuButton=$("menuButton"),menuPanel=$("menuPanel");
menuButton?.addEventListener("click",e=>{e.stopPropagation();const open=menuPanel.hidden;menuPanel.hidden=!open;menuButton.setAttribute("aria-expanded",String(open))});
document.addEventListener("click",e=>{if(menuPanel&&!menuPanel.hidden&&!menuPanel.contains(e.target)&&e.target!==menuButton){menuPanel.hidden=true;menuButton.setAttribute("aria-expanded","false")}});

const overlay=$("uploadArea"),cancel=$("sourceCancel");
const todayCount=$("todayCount"),todayWeight=$("todayWeight"),menuRouteValue=$("currentRouteMenuValue"),dot=$("statusDot");
let dispatchRouteId="";
const setEmptyToday=()=>{todayCount.textContent="暂无运单";todayWeight.textContent=""};
const setRouteBadge=(route)=>{if(!dot)return;const type=route?.type||"";const name=String(route?.name||"").trim();const badge=type==="temporary"||/临时/.test(name)?"临":(name.replace(/\s+/g,"").replace(/路$/,"" )||"—");dot.textContent=badge;dot.hidden=false};

const processingPanel=$("uploadProcessing"),processingError=$("uploadProcessingError"),processingErrorMessage=$("processingErrorMessage"),processingRetry=$("processingRetry"),sourceMenu=$("uploadSourceMenu"),processingPercent=$("processingPercent"),processingProgress=$("processingProgressDot");
let processingProgressValue=0;
function renderProcessingProgress(value){
  processingProgressValue=Math.max(0,Math.min(100,Math.round(Number(value)||0)));
  if(processingPercent)processingPercent.textContent=processingProgressValue+"%";
  const line=processingProgress?.closest(".processing-progress-line");
  if(line)line.style.setProperty("--progress",processingProgressValue+"%");
  const bar=processingProgress?.closest(".processing-progress");
  if(bar)bar.setAttribute("aria-valuenow",String(processingProgressValue));
}
function resetProcessingUI(){
  if(!processingPanel||!sourceMenu)return;
  if(overlay)overlay.classList.remove("processing-error-state");
  if(processingError)processingError.hidden=true;
  sourceMenu.hidden=false;processingPanel.hidden=true;
  renderProcessingProgress(0);
}
function showProcessingError(message){
  if(processingPanel)processingPanel.hidden=true;
  if(sourceMenu)sourceMenu.hidden=true;
  if(overlay)overlay.classList.add("processing-error-state");
  if(processingErrorMessage)processingErrorMessage.textContent=message||"处理失败，请重试";
  if(processingError)processingError.hidden=false;
}
function showProcessingUI(){
  if(!processingPanel||!sourceMenu)return;
  if(overlay)overlay.classList.remove("processing-error-state");
  if(processingError)processingError.hidden=true;
  sourceMenu.hidden=true;processingPanel.hidden=false;
  renderProcessingProgress(0);
}
function closeUpload(){
  if(processingFile)return;
  if(overlay){overlay.hidden=true;overlay.setAttribute("aria-hidden","true");document.body.classList.remove("sheet-open");resetProcessingUI()}
}
function openUpload(){
  if(overlay){resetProcessingUI();overlay.hidden=false;overlay.setAttribute("aria-hidden","false");document.body.classList.add("sheet-open")}
}
$("uploadAction")?.addEventListener("click",openUpload);
cancel?.addEventListener("click",closeUpload);
processingRetry?.addEventListener("click",()=>{if(processingFile)return;closeUpload();});
overlay?.addEventListener("click",e=>{if(e.target===overlay)closeUpload()});

async function ensureDispatchRoute(){
  if(dispatchRouteId)return true;
  try{
    const r=await fetch("/api/dispatch",{credentials:"same-origin",cache:"no-store"});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.success&&d.dispatchRoute?.id){
      dispatchRouteId=d.dispatchRoute.id;
      return true;
    }
  }catch{}
  return false;
}

function chooseFile(source){
  const input=source==="camera"?$("cameraInput"):source==="photo"?$("photoInput"):$("documentInput");
  if(!input)return;
  input.value="";
  input.click();
}
document.querySelectorAll(".source-option").forEach(btn=>btn.addEventListener("click",()=>chooseFile(btn.dataset.source)));

let processingFile=false;
async function processSelectedFile(file){
  if(!file||processingFile)return;
  processingFile=true;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),60000);
  try{
    if(!(await ensureDispatchRoute())){
      showProcessingError("DISPATCH_ROUTE_MISSING");
      return;
    }
    showProcessingUI();
    document.querySelectorAll(".source-option").forEach(b=>b.disabled=true);
    const fd=new FormData();
    fd.append("file",file);
    fd.append("routeId",dispatchRouteId);
    renderProcessingProgress(3);
    let r;
    try{
      r=await fetch("/api/waybills/process?stream=1",{method:"POST",body:fd,credentials:"same-origin",signal:controller.signal});
      if(!r.ok){
        const httpError=new Error("运单处理服务暂时不可用，请重试");
        httpError.code="PROCESS_HTTP_"+r.status;
        throw httpError;
      }
      const reader=r.body?.getReader();
      if(!reader)throw Object.assign(new Error("当前浏览器不支持实时处理进度"),{code:"PROCESS_STREAM_UNSUPPORTED"});
      const decoder=new TextDecoder();
      let buffer="",result=null;
      while(true){
        const chunk=await reader.read();
        if(chunk.done)break;
        buffer+=decoder.decode(chunk.value,{stream:true});
        const lines=buffer.split("\n");
        buffer=lines.pop()||"";
        for(const line of lines){
          if(!line.trim())continue;
          let event;
          try{event=JSON.parse(line)}catch{continue}
          if(event.type==="progress")renderProcessingProgress(event.progress);
          else if(event.type==="result")result=event;
        }
      }
      buffer+=decoder.decode();
      if(buffer.trim()){
        try{const event=JSON.parse(buffer);if(event.type==="result")result=event}catch{}
      }
      if(!result)throw Object.assign(new Error("处理连接中断，请重试"),{code:"PROCESS_STREAM_INTERRUPTED"});
      if(!result.success){
        const code=result.code||result.errorCode||"PROCESS_FAILED";
        throw Object.assign(new Error(result.message||result.error||"处理失败"),{code});
      }
      renderProcessingProgress(100);
      location.replace("/pages/order_detail.html?id="+encodeURIComponent(result.waybill.id)+"&source=process");
    }catch(e){
      if(e?.name==="AbortError")throw Object.assign(new Error("运单处理超时，请检查OCR服务后重试"),{code:"PROCESS_CLIENT_TIMEOUT"});
      throw e;
    }
  }catch(e){
    showProcessingError(e?.code||"PROCESS_FAILED");
  }finally{
    clearTimeout(timer);
    document.querySelectorAll(".source-option").forEach(b=>b.disabled=false);
    processingFile=false;
  }
}
["cameraInput","photoInput","documentInput"].forEach(id=>$(id)?.addEventListener("change",e=>processSelectedFile(e.target.files?.[0])));

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
    const route=dispatch.dispatchRoute||null;
    const routeName=route?.type==="temporary"?"临时":(route?.name||"未选择");
    setRouteBadge(route);
    if(menuRouteValue)menuRouteValue.textContent=routeName;
    const wRes=await fetch("/api/waybills/latest?confirmed=1",{credentials:"same-origin",cache:"no-store"});
    const wd=await wRes.json().catch(()=>({}));
    const w=wRes.ok&&wd.success?wd.waybill:null;
    if(w&&w.routeId===dispatchRouteId){
      const total=Number(w.summary?.total)||Number(w.stores?.length)||0;
      todayCount.textContent=total+"家";
      todayWeight.textContent=(Math.round((Number(w.totalWeight)||0)*100)/100).toFixed(2)+"t";
    }else{
      setEmptyToday();
    }
  }catch(e){
    setEmptyToday();
  }
}
loadHome();