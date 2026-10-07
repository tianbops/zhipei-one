(()=>{"use strict";
  // 首页月度趋势：独立模块。任何异常均静默处理，不得影响 home.js 主流程。
  const $=id=>document.getElementById(id);
  const card=$("monthlyCard");
  if(!card)return;

  const prev=$("monthlyPrev"),next=$("monthlyNext"),title=$("monthlyTitle");
  const monthEl=$("monthlyMonth"),waybillsEl=$("monthlyWaybills"),weightEl=$("monthlyWeight");
  const chart=$("monthlyChart"),grid=$("monthlyGrid"),area=$("monthlyChartArea"),line=$("monthlyChartLine"),points=$("monthlyChartPoints");
  const axis=$("monthlyAxis"),hint=$("monthlyHint");
  let months=new Map(),history=[],currentMonth="",availableMonths=[];
  let touchX=0,touchY=0;
  let metric="weight"; // 趋势指标：weight=按重量(t)显示起伏（默认）；count=按单量。两种口径前端已有数据，切换不另发请求

  const cnToday=()=>{
    const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    return p;
  };
  const monthDiff=(a,b)=>{
    const [ay,am]=a.split("-").map(Number),[by,bm]=b.split("-").map(Number);
    return (ay-by)*12+am-bm;
  };
  const daysInMonth=ym=>{
    const [y,m]=ym.split("-").map(Number);
    return new Date(Date.UTC(y,m,0)).getUTCDate();
  };
  const label=ym=>{
    const [y,m]=ym.split("-").map(Number);
    return y+"年"+m+"月";
  };
  const escSvg=v=>String(v).replace(/[&<>"]/g,"");
  const smoothPath=pts=>{
    if(!pts.length)return "";
    if(pts.length===1)return "M "+pts[0][0]+" "+pts[0][1];
    let d="M "+pts[0][0]+" "+pts[0][1];
    for(let i=1;i<pts.length;i++){
      const p0=pts[i-1],p1=pts[i];
      const mx=(p0[0]+p1[0])/2;
      d+=" C "+mx+" "+p0[1]+", "+mx+" "+p1[1]+", "+p1[0]+" "+p1[1];
    }
    return d;
  };

  function buildMonthData(ym){
    const days=daysInMonth(ym),byDate=new Map(history.map(x=>[x.date,x]));
    const out=[];
    for(let d=1;d<=days;d++){
      const date=ym+"-"+String(d).padStart(2,"0"),item=byDate.get(date);
      out.push({date,day:d,count:Number(item?.count)||0,weight:Number(item?.totalWeight)||0});
    }
    return out;
  }

  function render(){
    if(!currentMonth)return;
    const data=buildMonthData(currentMonth);
    const total=data.reduce((s,x)=>s+x.count,0);
    const weight=data.reduce((s,x)=>s+x.weight,0);
    // 趋势指标：默认按「重量(t)」显示起伏；可切到「单量」。两种口径前端都有数据，切换不另发请求。
    const valOf=x=>metric==="weight"?x.weight:x.count;
    const safeMax=metric==="weight"?0.01:1; // 重量为 0 时避免除零，保证基线可见
    const max=Math.max(safeMax,...data.map(valOf));
    const w=360,h=112,left=8,right=8,top=10,bottom=14;
    const cw=w-left-right,ch=h-top-bottom;
    const pts=data.map((x,i)=>{
      const px=left+(data.length===1?cw/2:i*cw/(data.length-1));
      const py=top+(1-valOf(x)/max)*ch;
      return [px,py];
    });
    const path=smoothPath(pts);
    const areaPath=path?path+" L "+pts[pts.length-1][0]+" "+(h-bottom)+" L "+pts[0][0]+" "+(h-bottom)+" Z":"";
    const gridPath=[0,.5,1].map(r=>{
      const y=top+r*ch;
      return "M "+left+" "+y+" H "+(w-right);
    }).join(" ");
    grid.setAttribute("d",gridPath);
    line.setAttribute("d",path);
    area.setAttribute("d",areaPath);
    points.innerHTML="";
    data.forEach((x,i)=>{
      if(!x.count)return;
      const p=pts[i];
      const c=document.createElementNS("http://www.w3.org/2000/svg","circle");
      c.setAttribute("cx",p[0]);c.setAttribute("cy",p[1]);c.setAttribute("r",i===data.length-1?4:3);
      c.setAttribute("class","monthly-point");
      c.setAttribute("tabindex","0");
      c.setAttribute("aria-label",x.date+" "+x.count+"单 · "+x.weight.toFixed(2)+"t");
      c.addEventListener("click",()=>{hint.textContent=x.date+" · "+x.count+"单 · "+x.weight.toFixed(2)+"t"});
      points.appendChild(c);
    });
    const maxIndex=data.reduce((best,x,i)=>valOf(x)>valOf(data[best])?i:best,0);
    if(total){
      const peak=data[maxIndex];
      hint.textContent=metric==="weight"
        ? "峰值 "+peak.day+"日 · "+peak.weight.toFixed(2)+"t"
        : "峰值 "+peak.day+"日 · "+peak.count+"单";
    }else{
      hint.textContent="本月暂无配送记录";
    }
    waybillsEl.textContent=String(total);
    weightEl.textContent=weight.toFixed(2);
    title.textContent=currentMonth===cnToday().slice(0,7)?"本月趋势":"配送记录";
    monthEl.textContent=label(currentMonth);
    prev.disabled=!availableMonths.length||availableMonths.indexOf(currentMonth)>=availableMonths.length-1;
    next.disabled=!availableMonths.length||availableMonths.indexOf(currentMonth)<=0;
    axis.innerHTML="";
    const ticks=[1,Math.ceil(data.length/2),data.length];
    [...new Set(ticks)].forEach(day=>{
      const s=document.createElement("span");s.textContent=String(day).padStart(2,"0")+"日";axis.appendChild(s);
    });
    card.hidden=false;
    card.classList.remove("is-changing");
    void card.offsetWidth;
    card.classList.add("is-changing");
  }

  function move(dir){
    const i=availableMonths.indexOf(currentMonth);
    if(i<0)return;
    const ni=i+dir;
    if(ni<0||ni>=availableMonths.length)return;
    currentMonth=availableMonths[ni];
    render();
  }

  prev?.addEventListener("click",()=>move(1));
  next?.addEventListener("click",()=>move(-1));
  const metricWeightBtn=$("metricWeight"),metricCountBtn=$("metricCount");
  function setMetric(m){
    if(m!=="weight"&&m!=="count")return;
    metric=m;
    metricWeightBtn?.classList.toggle("is-active",m==="weight");
    metricCountBtn?.classList.toggle("is-active",m==="count");
    metricWeightBtn?.setAttribute("aria-pressed",String(m==="weight"));
    metricCountBtn?.setAttribute("aria-pressed",String(m==="count"));
    render();
  }
  metricWeightBtn?.addEventListener("click",()=>setMetric("weight"));
  metricCountBtn?.addEventListener("click",()=>setMetric("count"));
  chart?.addEventListener("touchstart",e=>{
    const t=e.changedTouches?.[0];if(!t)return;
    touchX=t.clientX;touchY=t.clientY;
  },{passive:true});
  chart?.addEventListener("touchend",e=>{
    const t=e.changedTouches?.[0];if(!t)return;
    const dx=t.clientX-touchX,dy=t.clientY-touchY;
    if(Math.abs(dx)>48&&Math.abs(dx)>Math.abs(dy)*1.25)move(dx>0?1:-1);
  },{passive:true});

  async function load(){
    try{
      const r=await fetch("/api/history",{credentials:"same-origin",cache:"no-store"});
      if(!r.ok)return;
      const d=await r.json().catch(()=>null);
      if(!d?.success||!Array.isArray(d.history))return;
      history=d.history.filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x?.date||"")));
      months=new Map((Array.isArray(d.months)?d.months:[]).map(x=>[String(x.month),x]));
      const todayMonth=cnToday().slice(0,7);
      const rangeMonths=[];
      for(let i=0;i<13;i++){
        const [y,m]=todayMonth.split("-").map(Number);
        const idx=y*12+(m-1)-i,yy=Math.floor(idx/12),mm=idx%12+1;
        rangeMonths.push(yy+"-"+String(mm).padStart(2,"0"));
      }
      // 即使某个月没有运单，也允许左右查看；未来月份永不出现。
      availableMonths=rangeMonths.filter(m=>monthDiff(m,todayMonth)>=0);
      currentMonth=todayMonth;
      render();
    }catch{}
  }

  load();
})();