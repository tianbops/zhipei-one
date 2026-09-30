const $=id=>document.getElementById(id);
const menuButton=$("menuButton"),menuPanel=$("menuPanel");
menuButton?.addEventListener("click",e=>{e.stopPropagation();const open=menuPanel.hidden;menuPanel.hidden=!open;menuButton.setAttribute("aria-expanded",String(open))});
document.addEventListener("click",e=>{if(menuPanel&&!menuPanel.hidden&&!menuPanel.contains(e.target)&&e.target!==menuButton){menuPanel.hidden=true;menuButton.setAttribute("aria-expanded","false")}});

const status=$("status"),overlay=$("uploadArea"),cancel=$("sourceCancel");
const routeMessage=$("todayStatus"),todayRoute=$("todayRoute"),todayCount=$("todayCount"),todayWeight=$("todayWeight"),dot=$("statusDot");
let dispatchRouteId="";
const setEmptyToday=()=>{todayCount.textContent="暂无运单";todayWeight.textContent="";if(dot)dot.textContent="0";todayRoute.textContent="";todayRoute.hidden=true;document.querySelector(".task-card")?.classList.add("no-waybill")};
const setHasToday=()=>{todayRoute.hidden=false;document.querySelector(".task-card")?.classList.remove("no-waybill")};

const processingPanel=$("uploadProcessing"),sourceMenu=$("uploadSourceMenu"),processingPercent=$("processingPercent"),processingProgress=$("processingProgressDot");
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
  sourceMenu.hidden=false;processingPanel.hidden=true;
  renderProcessingProgress(0);
}
function showProcessingUI(){
  if(!processingPanel||!sourceMenu)return;
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
function setPipelineStage(index,text){
  const checkpoints=[8,28,48,68,88,100];
  renderProcessingProgress(checkpoints[Math.max(0,Math.min(5,index))]);
}
$("uploadAction")?.addEventListener("click",openUpload);
cancel?.addEventListener("click",closeUpload);
overlay?.addEventListener("click",e=>{if(e.target===overlay)closeUpload()});

async function ensureDispatchRoute(){
  if(dispatchRouteId)return true;
  try{
    const r=await fetch("/api/dispatch",{credentials:"same-origin",cache:"no-store"});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.success&&d.dispatchRoute?.id){
      dispatchRouteId=d.dispatchRoute.id;
      if(todayRoute)todayRoute.textContent=d.dispatchRoute.name||"当前配送线路";
      return true;
    }
  }catch{}
  return false;
}

function chooseFile(source){
  // 保持文件选择器调用在用户点击手势内，避免 Android 浏览器因异步等待而拦截相册/相机。
  if(!dispatchRouteId){
    status.textContent="正在读取当前配送线路…";
    status.className="home-status";
    ensureDispatchRoute().then(ready=>{
      if(!ready){status.textContent="请先选择今天实际使用的配送线路";status.className="home-status error";}
    });
    return;
  }
  const input=source==="camera"?$("cameraInput"):source==="photo"?$("photoInput"):$("documentInput");
  if(!input)return;
  // 允许连续选择同一张运单时也能再次触发 change。
  input.value="";
  input.click();
}
document.querySelectorAll(".source-option").forEach(btn=>btn.addEventListener("click",()=>chooseFile(btn.dataset.source)));

let processingFile=false;
let processingStage="";
function setProcessingStage(text){processingStage=text;status.textContent=text;status.className="home-status processing";}
async function processSelectedFile(file){
  if(!file||processingFile)return;
  processingFile=true;
  try{
    if(!(await ensureDispatchRoute())){
      status.textContent="请先选择今天实际使用的配送线路";
      status.className="home-status error";
      return;
    }
    showProcessingUI();
    document.querySelectorAll(".source-option").forEach(b=>b.disabled=true);
    if(processingPanel)processingPanel.querySelectorAll(".processing-steps li").forEach(li=>li.classList.remove("active","done"));
    const fd=new FormData();
    fd.append("file",file);
    fd.append("routeId",dispatchRouteId);
    renderProcessingProgress(3);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),60000);
    let r;
    try{
      r=await fetch("/api/waybills/process?stream=1",{method:"POST",body:fd,credentials:"same-origin",signal:controller.signal});
    }catch(e){
      if(e?.name==="AbortError")throw Error("运单处理超时，请检查OCR服务后重试");
      throw e;
    }finally{
      clearTimeout(timer);
    }
    if(!r.ok)throw Error("运单处理服务暂时不可用，请重试");
    const reader=r.body?.getReader();
    if(!reader)throw Error("当前浏览器不支持实时处理进度");
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
        let event;try{event=JSON.parse(line)}catch{continue}
        if(event.type==="progress")renderProcessingProgress(event.progress);
        else if(event.type==="result")result=event;
      }
    }
    buffer+=decoder.decode();
    if(buffer.trim()){
      try{const event=JSON.parse(buffer);if(event.type==="result")result=event}catch{}
    }
    if(!result?.success)throw Error(result?.message||result?.error||"处理失败");
    renderProcessingProgress(100);
    location.replace("/pages/order_detail.html?id="+encodeURIComponent(result.waybill.id)+"&source=process");
  }catch(e){
      if(e?.name==="AbortError")throw Error("运单处理超时，请检查OCR服务后重试");
      throw e;
    }finally{
      clearTimeout(timer);
    }
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.success)throw Error(d.message||d.error||"处理失败");
    setPipelineStage(5,"已完成");
    location.replace("/pages/order_detail.html?id="+encodeURIComponent(d.waybill.id)+"&source=process");
  }catch(e){
    processingFile=false;
    if(overlay){overlay.hidden=true;overlay.setAttribute("aria-hidden","true");document.body.classList.remove("sheet-open");resetProcessingUI()}
    status.textContent=e.message||"处理失败";
    status.className="home-status error";
  }finally{
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
    todayRoute.textContent=dispatch.dispatchRoute?.name||"请选择配送线路";
    if(!dispatchRouteId)routeMessage.textContent="请先选择今天实际使用的线路。";
    const wRes=await fetch("/api/waybills/latest?confirmed=1",{credentials:"same-origin",cache:"no-store"});
    const wd=await wRes.json().catch(()=>({}));
    const w=wRes.ok&&wd.success?wd.waybill:null;
    if(w&&w.routeId===dispatchRouteId){
      setHasToday();
      const total=Number(w.summary?.total)||Number(w.stores?.length)||0;
      todayCount.textContent=total+"家";
      todayWeight.textContent=(Math.round((Number(w.totalWeight)||0)*100)/100).toFixed(2)+"t";
      if(dot)dot.textContent="1";
    }else{
      setEmptyToday();
    }
  }catch(e){
    todayRoute.textContent="";todayRoute.hidden=true;
    setEmptyToday();
  }
}
loadHome();