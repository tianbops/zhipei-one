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
  try{await fetch("/api/logout",{method:"POST",credentials:"same-origin"});}
  finally{location.replace("/")};
});

const todayRoute=$("todayRoute");
const todayCount=$("todayCount");
const todayWeight=$("todayWeight");
const todayStatus=$("todayStatus");
const uploadAction=$("uploadAction");
const sourceSheet=$("sourceSheet");
const sourceCancel=$("sourceCancel");
const status=$("status");

function setStatus(text,error=false){
  if(!status)return;
  status.textContent=text||"";
  status.classList.toggle("error",!!error);
}
function setTodayStatus(text,error=false){
  if(!todayStatus)return;
  todayStatus.textContent=text||"";
  todayStatus.classList.toggle("error",!!error);
}
function closeSourceSheet(){
  if(sourceSheet){
    sourceSheet.hidden=true;
    document.body.classList.remove("sheet-open");
  }
}
function openSourceSheet(){
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

const stages=["识别","提取","匹配","去重","规划"];
function showStage(i){
  setStatus(i<stages.length?"正在"+stages[i]+"…":"处理完成");
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

function renderToday(w){
  if(!w){
    todayCount.textContent="—";
    todayWeight.textContent="—";
    setTodayStatus("今天还没有已确认的配送运单。");
    return;
  }
  const summary=w.summary||{};
  const total=Number(summary.total)||Number(w.stores?.length)||0;
  todayCount.textContent=total+"家";
  const weight=Number(w.totalWeight)||0;
  todayWeight.textContent=weight?(Math.round(weight*100)/100).toFixed(2)+"t":"—";
  const metrics=[];
  if(Number(summary.original)>total)metrics.push("原始"+summary.original+"家");
  if(Number(summary.correction)>0)metrics.push("更正"+summary.correction+"家");
  if(Number(summary.merged)>0)metrics.push("合并"+summary.merged+"家");
  if(Number(summary.newStores)>0)metrics.push("新增"+summary.newStores+"家");
  const pending=(w.stores||[]).filter(x=>x.pending).length;
  if(pending>0)metrics.push("待定"+pending+"家");
  setTodayStatus(metrics.join("    "));
}

async function loadToday(){
  try{
    const r=await fetch("/api/waybills/latest?confirmed=1",{credentials:"same-origin",cache:"no-store"});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.success)throw Error();
    const w=d.waybill;
    if(!w){
      todayRoute.textContent="未选择配送线路";
      renderToday(null);
      return;
    }
    todayRoute.textContent=w.routeName||w.route?.name||"当前配送线路";
    renderToday(w);
  }catch{
    todayRoute.textContent="当前配送线路";
    renderToday(null);
    setTodayStatus("今日配送信息暂时无法读取。",true);
  }
}

async function loadDispatch(){
  try{
    const r=await fetch("/api/dispatch",{credentials:"same-origin",cache:"no-store"});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.success)throw Error();
    if(d.dispatchRoute?.name)todayRoute.textContent=d.dispatchRoute.name;
    else todayRoute.textContent="未选择配送线路";
  }catch{
    todayRoute.textContent="配送线路读取失败";
    setTodayStatus("请从右上角菜单进入“线路变更”检查线路。",true);
  }
}

async function processSelectedFile(selected){
  if(!selected)return;
  uploadAction?.classList.add("disabled");
  uploadAction?.setAttribute("aria-disabled","true");
  setStatus("");
  showStage(0);
  try{
    const fd=new FormData();
    fd.append("file",selected);
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
  await Promise.allSettled([loadDispatch(),loadToday()]);
})();
