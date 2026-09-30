const $=id=>document.getElementById(id);
const menuButton=$("menuButton"),menuPanel=$("menuPanel");
menuButton?.addEventListener("click",e=>{e.stopPropagation();const open=menuPanel.hidden;menuPanel.hidden=!open;menuButton.setAttribute("aria-expanded",String(open))});
document.addEventListener("click",e=>{if(menuPanel&&!menuPanel.hidden&&!menuPanel.contains(e.target)&&e.target!==menuButton){menuPanel.hidden=true;menuButton.setAttribute("aria-expanded","false")}});

const status=$("status"),overlay=$("uploadArea"),cancel=$("sourceCancel");
const routeMessage=$("todayStatus"),todayRoute=$("todayRoute"),todayCount=$("todayCount"),todayWeight=$("todayWeight"),dot=$("statusDot");
let dispatchRouteId="";

function closeUpload(){if(overlay){overlay.hidden=true;overlay.setAttribute("aria-hidden","true");document.body.classList.remove("sheet-open")}}
function openUpload(){if(overlay){overlay.hidden=false;overlay.setAttribute("aria-hidden","false");document.body.classList.add("sheet-open")}}
$("uploadAction")?.addEventListener("click",openUpload);
cancel?.addEventListener("click",closeUpload);
overlay?.addEventListener("click",e=>{if(e.target===overlay)closeUpload()});

function chooseFile(source){
  const input=source==="camera"?$("cameraInput"):source==="photo"?$("photoInput"):$("documentInput");
  input?.click();
}
document.querySelectorAll(".source-option").forEach(btn=>btn.addEventListener("click",()=>chooseFile(btn.dataset.source)));

async function processSelectedFile(file){
  if(!file||!dispatchRouteId){status.textContent="当前没有可用的配送线路";status.className="home-status error";return}
  closeUpload();status.textContent="正在处理…";status.className="home-status";
  try{
    const fd=new FormData();fd.append("file",file);fd.append("routeId",dispatchRouteId);
    const r=await fetch("/api/waybills/process",{method:"POST",body:fd,credentials:"same-origin"});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.success)throw Error(d.message||d.error||"处理失败");
    location.replace("/pages/order_detail.html?id="+encodeURIComponent(d.waybill.id)+"&source=process");
  }catch(e){status.textContent=e.message||"处理失败";status.className="home-status error"}
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
      const total=Number(w.summary?.total)||Number(w.stores?.length)||0;
      todayCount.textContent=total+"家";
      todayWeight.textContent="重量："+(Math.round((Number(w.totalWeight)||0)*100)/100).toFixed(2)+"t";
      if(dot)dot.textContent="1";
    }else{
      todayCount.textContent="无数据";todayWeight.textContent="无数据";if(dot)dot.textContent="0";
    }
  }catch(e){
    todayRoute.textContent="暂无法读取线路";
    todayCount.textContent="无数据";todayWeight.textContent="无数据";if(dot)dot.textContent="0";
  }
}
loadHome();