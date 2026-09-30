const $=id=>document.getElementById(id);

const menuButton=$("menuButton");
const menuPanel=$("menuPanel");
function closeMenu(){
  if(!menuPanel)return;
  menuPanel.hidden=true;
  menuButton?.setAttribute("aria-expanded","false");
}
menuButton?.addEventListener("click",e=>{
  e.stopPropagation();
  const open=menuPanel.hidden;
  menuPanel.hidden=!open;
  menuButton.setAttribute("aria-expanded",String(open));
});
document.addEventListener("click",e=>{
  if(menuPanel&&!menuPanel.hidden&&!menuPanel.contains(e.target)&&e.target!==menuButton)closeMenu();
});

$("logout")?.addEventListener("click",async()=>{
  closeMenu();
  try{await fetch("/api/logout",{method:"POST",credentials:"same-origin"});}finally{location.replace("/")};
});

const routeSelect=$("routeSelect");
const routeMessage=$("routeMessage");
const todayRoute=$("todayRoute");
const todayCount=$("todayCount");
const todayWeight=$("todayWeight");
const todayMetrics=$("todayMetrics");
const uploadAction=$("uploadAction");
const sourceSheet=$("sourceSheet");
const sourceCancel=$("sourceCancel");
const todayStatus=$("todayStatus");

function closeSourceSheet(){
  if(sourceSheet){
    sourceSheet.hidden=true;
    document.body.classList.remove("sheet-open");
  }
}
function openSourceSheet(){
  if(!routeSelect?.value){
    routeMessage.textContent="请先选择今天实际使用的线路。";
    routeSelect.focus();
    return;
  }
  sourceSheet.hidden=false;
  document.body.classList.add("sheet-open");
}
uploadAction?.addEventListener("click",e=>{
  e.preventDefault();
  openSourceSheet();
});
sourceCancel?.addEventListener("click",closeSourceSheet);
sourceSheet?.addEventListener("click",e=>{
  if(e.target===sourceSheet)closeSourceSheet();
});

function setStatus(text,error=false){
  if(!todayStatus)return;
  todayStatus.textContent=text||"";
  todayStatus.classList.toggle("error",!!error);
}
function chooseFile(source){
  const input=document.createElement("input");
  input.type="file";
  input.accept=source==="document"?"image/*,.pdf":"image/*";
  if(source==="camera")input.capture="environment";
  input.hidden=true;
  document.body.appendChild(input);
  input.addEventListener("change",async()=>{
    const selected=input.files?.[0];
    input.remove();
    if(selected)await processSelectedFile(selected);
  },{once:true});
  input.click();
}
sourceSheet?.querySelectorAll(".source-option").forEach(btn=>{
  btn.addEventListener("click",()=>{
    const source=btn.dataset.source;
    closeSourceSheet();
    chooseFile(source);
  });
});

const stages=["识别","提取","匹配","去重","规划"];
function showStage(i){
  setStatus(i<stages.length?"正在"+stages[i]+"…":"处理完成");
}

async function loadRoutes(){
  const [routesRes,dispatchRes]=await Promise.all([
    fetch("/api/routes",{credentials:"same-origin",cache:"no-store"}),
    fetch("/api/dispatch",{credentials:"same-origin",cache:"no-store"})
  ]);
  const routes=await routesRes.json().catch(()=>({}));
  const dispatch=await dispatchRes.json().catch(()=>({}));
  if(!routesRes.ok||!routes.success)throw Error(routes.error||"线路读取失败");
  if(!dispatchRes.ok||!dispatch.success)throw Error(dispatch.error||"当前配送线路读取失败");

  routeSelect.innerHTML='<option value="">请选择配送线路</option>';
  for(const r of routes.routes||[]){
    if(r.status!=="active")continue;
    const option=document.createElement("option");
    option.value=r.id;
    option.textContent=r.name;
    routeSelect.appendChild(option);
  }

  if(dispatch.dispatchRoute){
    routeSelect.value=dispatch.dispatchRoute.id;
    routeSelect.dataset.current=dispatch.dispatchRoute.id;
    setRouteText(dispatch.dispatchRoute.name);
  }else{
    setRouteText("");
    routeMessage.textContent="请选择今天实际使用的线路。";
  }
}

function setRouteText(name){
  todayRoute.textContent=name||"请选择配送线路";
  todayRoute.classList.toggle("today-route-empty",!name);
  if(name)routeMessage.textContent="当前配送： "+name;
}

routeSelect?.addEventListener("change",async()=>{
  const previous=routeSelect.dataset.current||"";
  const routeId=routeSelect.value;
  if(!routeId){
    routeSelect.value=previous;
    return;
  }
  routeSelect.disabled=true;
  routeMessage.textContent="正在切换配送线路…";
  try{
    const r=await fetch("/api/dispatch",{
      method:"POST",
      headers:{"content-type":"application/json"},
      credentials:"same-origin",
      body:JSON.stringify({routeId})
    });
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.success)throw Error(d.error||"线路切换失败");
    routeSelect.dataset.current=d.dispatchRoute.id;
    routeSelect.value=d.dispatchRoute.id;
    setRouteText(d.dispatchRoute.name);
    await loadToday();
  }catch(e){
    routeSelect.value=previous;
    routeMessage.textContent=e.message||"线路切换失败";
  }finally{
    routeSelect.disabled=false;
  }
});

function renderToday(w){
  if(!w){
    todayCount.textContent="暂无运单";
    todayWeight.textContent="";
    todayMetrics.innerHTML="";
    return;
  }
  const summary=w.summary||{};
  const total=Number(summary.total)||Number(w.stores?.length)||0;
  todayCount.textContent=total+"家";
  const weight=Number(w.totalWeight)||0;
  todayWeight.textContent=weight?"重量："+(Math.round(weight*100)/100).toFixed(2)+"t":"";
  const metrics=[];
  if(Number(summary.original)>total)metrics.push("原始"+summary.original+"家");
  if(Number(summary.correction)>0)metrics.push("更正"+summary.correction+"家");
  if(Number(summary.merged)>0)metrics.push("合并"+summary.merged+"家");
  if(Number(summary.newStores)>0)metrics.push("新增"+summary.newStores+"家");
  const pending=(w.stores||[]).filter(x=>x.pending).length;
  if(pending>0)metrics.push("待定"+pending+"家");
  todayMetrics.innerHTML=metrics.map(x=>"<span>"+x+"</span>").join("");
}

async function loadToday(){
  const routeId=routeSelect?.value||routeSelect?.dataset.current||"";
  if(!routeId){
    renderToday(null);
    return;
  }
  try{
    const r=await fetch("/api/waybills/latest?confirmed=1",{credentials:"same-origin",cache:"no-store"});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.success)throw Error();
    const w=d.waybill;
    renderToday(w&&w.routeId===routeId?w:null);
  }catch{
    renderToday(null);
  }
}

async function processSelectedFile(selected){
  if(!selected)return;
  if(!routeSelect?.value){
    setStatus("请先选择配送线路",true);
    return;
  }
  uploadAction?.classList.add("disabled");
  uploadAction?.setAttribute("aria-disabled","true");
  showStage(0);
  try{
    const fd=new FormData();
    fd.append("file",selected);
    fd.append("routeId",routeSelect.value);
    const r=await fetch("/api/waybills/process",{method:"POST",body:fd,credentials:"same-origin"});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.success){
      const code=d.code||"PROCESS_FAILED";
      throw Error("["+code+"] "+(d.message||d.error||"处理失败"));
    }
    showStage(stages.length);
    location.replace("/pages/order_detail.html?id="+encodeURIComponent(d.waybill.id)+"&source=process");
  }catch(e){
    setStatus(e.message||"处理失败",true);
  }finally{
    uploadAction?.classList.remove("disabled");
    uploadAction?.removeAttribute("aria-disabled");
  }
}

(async()=>{
  try{
    await loadRoutes();
    await loadToday();
  }catch(e){
    routeMessage.textContent=e.message||"配送线路读取失败";
    renderToday(null);
  }
})();
