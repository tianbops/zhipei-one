(()=>{"use strict";
  // 首页「配送趋势 · Smart Trend」模块（内部代号；用户界面仅显示「本月配送」等业务词，无英文技术词）。
  // 设计约束：工业物流终端科技感 —— 来自精细网格 + 数据节点 + 平滑曲线 + 动态切换 + 数字变化，
  // 严禁霓虹蓝/紫渐变、发光、3D、玻璃拟态等廉价科技风。任何异常均静默处理，不得影响 home.js 主流程。
  const $=id=>document.getElementById(id);
  const card=$("trendCard");
  if(!card)return;

  const titleEl=$("trendTitle"),yearBtn=$("trendYearBtn"),monthRow=$("trendMonthRow");
  const prev=$("trendPrev"),next=$("trendNext"),monthEl=$("trendMonth");
  const metricWrap=$("trendMetric"),metricWeightBtn=$("metricWeight"),metricCountBtn=$("metricCount");
  const waybillsEl=$("trendWaybills"),weightEl=$("trendWeight");
  const wbDelta=$("trendWaybillsDelta"),wtDelta=$("trendWeightDelta");
  const wrap=$("trendChartWrap"),chart=$("trendChart");
  const grid=$("trendGrid"),area=$("trendArea"),line=$("trendLine"),points=$("trendPoints");
  const axis=$("trendAxis"),hint=$("trendHint");

  const prefersReduced=window.matchMedia&&window.matchMedia("(prefers-reduced-motion:reduce)").matches;
  let daily=[],byMonth=new Map(),availableMonths=[],currentMonth="";
  let metric="weight";            // 月度曲线指标：weight(按重量 t，默认) / count(按单量)
  let yearMode=false,year=0;
  let animating=false,touchX=0,touchY=0;

  /* ---------- 基础工具 ---------- */
  const cnMonth=()=>{
    const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    return p.slice(0,7); // YYYY-MM
  };
  const monthDiff=(a,b)=>{const [ay,am]=a.split("-").map(Number),[by,bm]=b.split("-").map(Number);return (ay-by)*12+am-bm;};
  const daysInMonth=ym=>{const [y,m]=ym.split("-").map(Number);return new Date(Date.UTC(y,m,0)).getUTCDate();};
  const label=ym=>{const [y,m]=ym.split("-").map(Number);return y+"年"+m+"月";};
  const esc=v=>String(v==null?"":v).replace(/[&<>"]/g,"");
  const smoothPath=pts=>{
    if(!pts.length)return "";
    if(pts.length===1)return "M "+pts[0][0]+" "+pts[0][1];
    let d="M "+pts[0][0]+" "+pts[0][1];
    for(let i=1;i<pts.length;i++){
      const p0=pts[i-1],p1=pts[i],mx=(p0[0]+p1[0])/2;
      d+=" C "+mx+" "+p0[1]+", "+mx+" "+p1[1]+", "+p1[0]+" "+p1[1];
    }
    return d;
  };

  /* ---------- 月度数据（补齐缺勤日 = 0） ---------- */
  function buildMonthData(ym){
    const days=daysInMonth(ym),byDate=new Map(daily.map(x=>[x.date,x])),out=[];
    for(let d=1;d<=days;d++){
      const date=ym+"-"+String(d).padStart(2,"0"),item=byDate.get(date);
      out.push({date,day:d,count:Number(item?.count)||0,weight:Number(item?.totalWeight)||0});
    }
    return out;
  }

  function animateNumber(el,to,fmt){
    const from=Number(el.dataset.v||0);
    el.dataset.v=String(to);
    if(prefersReduced){el.textContent=fmt(to);return;}
    const t0=performance.now(),dur=320;
    (function step(t){
      const k=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-k,3);
      el.textContent=fmt(from+(to-from)*e);
      if(k<1)requestAnimationFrame(step);
    })(t0);
  }

  function setDelta(el,cur,prev,unit){
    if(prev==null||prev<=0){el.textContent="";el.className="trend-delta";return;}
    const pct=(cur-prev)/prev*100;
    if(!isFinite(pct)){el.textContent="";el.className="trend-delta";return;}
    const up=pct>=0;
    el.textContent=(up?"↑ ":"↓ ")+Math.abs(pct).toFixed(1)+"%";
    el.className="trend-delta "+(up?"is-up":"is-down");
  }

  /* ---------- 月度视图渲染 ---------- */
  function renderMonth(){
    const data=buildMonthData(currentMonth);
    const total=data.reduce((s,x)=>s+x.count,0);
    const weight=data.reduce((s,x)=>s+x.weight,0);
    const valOf=x=>metric==="weight"?x.weight:x.count;
    const safeMax=metric==="weight"?0.01:1;            // 重量为 0 时兜底，避免除零、保证基线可见
    const max=Math.max(safeMax,...data.map(valOf));
    const w=360,h=120,left=10,right=10,top=12,bottom=16;
    const cw=w-left-right,ch=h-top-bottom;
    const pts=data.map((x,i)=>{
      const px=left+(data.length===1?cw/2:i*cw/(data.length-1));
      const py=top+(1-valOf(x)/max)*ch;
      return [px,py];
    });
    const path=smoothPath(pts);
    const areaPath=path?path+" L "+pts[pts.length-1][0]+" "+(h-bottom)+" L "+pts[0][0]+" "+(h-bottom)+" Z":"";
    const gridPath=[0,.5,1].map(r=>{const y=top+r*ch;return "M "+left+" "+y+" H "+(w-right);}).join(" ");
    grid.setAttribute("d",gridPath);
    line.setAttribute("d",path);
    area.setAttribute("d",areaPath);
    points.innerHTML="";
    const peakIdx=data.reduce((b,x,i)=>valOf(x)>valOf(data[b])?i:b,0);
    data.forEach((x,i)=>{
      if(!valOf(x))return;
      const p=pts[i],c=document.createElementNS("http://www.w3.org/2000/svg","circle");
      const isPeak=i===peakIdx&&total>0;
      c.setAttribute("cx",p[0]);c.setAttribute("cy",p[1]);
      c.setAttribute("r",isPeak?4.5:2.6);
      c.setAttribute("class","trend-point"+(isPeak?" is-peak":""));
      c.setAttribute("tabindex","0");
      c.setAttribute("aria-label",x.date+" "+x.count+"单 · "+x.weight.toFixed(2)+"t");
      c.addEventListener("click",()=>{hint.innerHTML=esc(x.date)+" · "+x.count+"单 · "+x.weight.toFixed(2)+"t";});
      points.appendChild(c);
    });
    if(total){
      const peak=data[peakIdx];
      hint.innerHTML=metric==="weight"
        ? "峰值 "+peak.day+"日 · "+peak.weight.toFixed(2)+"t"
        : "峰值 "+peak.day+"日 · "+peak.count+"单";
    }else{
      hint.innerHTML="本月暂无配送记录";
    }
    // 轴：首日 / 月中 / 末日（只保留一排趋势线，无下方节奏条）
    axis.innerHTML="";
    const last=daysInMonth(currentMonth);
    [1,Math.round(last/2),last].forEach(d=>{
      const s=document.createElement("span");s.textContent=String(d).padStart(2,"0")+"日";axis.appendChild(s);
    });
    // 汇总 + 环比（对比上一自然月）
    animateNumber(waybillsEl,total,v=>String(Math.round(v)));
    animateNumber(weightEl,weight,v=>v.toFixed(2));
    const prevKey=prevMonthKey(currentMonth);
    const pm=prevKey?byMonth.get(prevKey):null;
    setDelta(wbDelta,total,pm?Number(pm.waybills)||0:null);
    setDelta(wtDelta,weight,pm?Number(pm.totalWeight)||0:null);
    // 抬头（两画面统一：月度/年度）
    titleEl.textContent="月度配送";
    monthEl.textContent=label(currentMonth);
    metricWrap.hidden=false;
    prev.disabled=availableMonths.indexOf(currentMonth)>=availableMonths.length-1; // 最旧月
    next.disabled=availableMonths.indexOf(currentMonth)<=0;                        // 当前月（未来禁止）
  }

  function prevMonthKey(ym){
    const [y,m]=ym.split("-").map(Number),idx=y*12+(m-1)-1;
    return Math.floor(idx/12)+"-"+String(idx%12+1).padStart(2,"0");
  }

  /* ---------- 年度视图渲染 ---------- */
  function renderYear(){
    const yk=String(year);
    const months=[];
    for(let m=1;m<=12;m++)months.push(yk+"-"+String(m).padStart(2,"0"));
    // 与月度视图共用同一指标（重量 t / 单量），两画面统一
    const isW=metric==="weight";
    const vals=months.map(mk=>{const x=byMonth.get(mk);if(!x)return 0;return isW?(Number(x.totalWeight)||0):(Number(x.waybills)||0);});
    const total=months.reduce((s,mk)=>{const x=byMonth.get(mk);return s+(x?Number(x.waybills)||0:0);},0);
    const weight=months.reduce((s,mk)=>{const x=byMonth.get(mk);return s+(x?Number(x.totalWeight)||0:0);},0);
    const safeMax=isW?0.01:1;
    const max=Math.max(safeMax,...vals);
    // 12 月活动柱（工业风：细柱 + 峰值略亮）
    const w=360,h=120,left=10,right=10,top=14,bottom=14;
    const cw=w-left-right,slot=cw/12,barW=Math.min(18,slot*0.46);
    let d="",bars="";
    vals.forEach((v,i)=>{
      const x=left+slot*i+slot/2,hh=(v<=0?0.04:v/max)*(h-top-bottom),yy=h-bottom-hh;
      const isPeak=v===max&&v>0;
      const fmtV=v=>isW?v.toFixed(2)+"t":v+"单";
      bars+='<rect x="'+(x-barW/2).toFixed(1)+'" y="'+yy.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="'+hh.toFixed(1)
        +'" rx="1.5" class="trend-year-bar'+(isPeak?" is-peak":"")+'"><title>'+label(months[i])+" · "+fmtV(v)+"</title></rect>";
    });
    // 基线 + 柱（用 line 通道绘制基线，area 留空）
    grid.setAttribute("d","M "+left+" "+(h-bottom)+" H "+(w-right));
    line.setAttribute("d","");area.setAttribute("d","");
    points.innerHTML=bars;
    // 轴：1 / 4 / 7 / 10 / 12 月
    axis.innerHTML="";
    [1,4,7,10,12].forEach(m=>{const s=document.createElement("span");s.textContent=m+"月";axis.appendChild(s);});
    // 汇总（无环比）
    animateNumber(waybillsEl,total,v=>String(Math.round(v)));
    animateNumber(weightEl,weight,v=>v.toFixed(2));
    wbDelta.textContent="";wtDelta.textContent="";
    // 峰值信息（随指标切换）：年度峰值月（重量口径显示 t）
    let peakMi=0;vals.forEach((v,i)=>{if(v>vals[peakMi])peakMi=i;});
    let busiest=null;
    for(const it of daily){if(!String(it.date).startsWith(yk))continue;if(!busiest||(Number(it.count)||0)>busiest.count)busiest={date:it.date,count:Number(it.count)||0};}
    const fmtV=v=>isW?v.toFixed(2)+"t":Math.round(v)+"单";
    const peakMonth=vals[peakMi]>safeMax?(peakMi+1)+"月":"—";
    let busiestTxt="";
    if(!isW&&busiest&&busiest.count>0){
      const [,bm,bd]=busiest.date.split("-").map(Number);
      busiestTxt="　最忙 "+bm+"月"+bd+"日 · "+busiest.count+"单";
    }
    hint.innerHTML="年度峰值 <b>"+peakMonth+" · "+fmtV(vals[peakMi])+"</b>"+busiestTxt;
    titleEl.textContent="年度配送";
    monthEl.textContent=year+" 年度";
    metricWrap.hidden=false;   // 与月度画面统一：同样提供 重量/单量 切换
    prev.disabled=true;next.disabled=true;
  }

  /* ---------- 切换动画（曲线滑出 / 新曲线滑入 + 数字计数） ---------- */
  function animateSwap(dir,renderFn){
    if(animating){return;}
    if(prefersReduced){renderFn();return;}
    animating=true;
    const exitX=dir<0?-40:40;     // dir=-1 前往更新月份：旧内容向左滑出
    const enterX=dir<0?40:-40;
    wrap.style.transition="transform .14s ease, opacity .14s ease";
    wrap.style.transform="translateX("+exitX+"px)";wrap.style.opacity=".12";
    monthEl.style.transition="transform .14s ease";monthEl.style.transform="translateX("+(exitX*0.4)+"px)";
    setTimeout(()=>{
      renderFn();
      wrap.style.transition="none";wrap.style.transform="translateX("+enterX+"px)";wrap.style.opacity="0";
      monthEl.style.transition="none";monthEl.style.transform="translateX("+(enterX*0.4)+"px)";
      void wrap.offsetWidth;
      requestAnimationFrame(()=>{
        wrap.style.transition="transform .26s cubic-bezier(.22,.61,.36,1), opacity .26s ease";
        wrap.style.transform="translateX(0)";wrap.style.opacity="1";
        monthEl.style.transition="transform .26s cubic-bezier(.22,.61,.36,1)";monthEl.style.transform="translateX(0)";
      });
      setTimeout(()=>{animating=false;},280);
    },150);
  }

  /* ---------- 导航 ---------- */
  function navigate(dir){
    const i=availableMonths.indexOf(currentMonth);
    if(i<0)return;
    const ni=i+dir;
    if(ni<0||ni>=availableMonths.length)return;   // 未来月份自然不可达（availableMonths 不超今日）
    currentMonth=availableMonths[ni];
    animateSwap(dir,renderMonth);
  }
  // 年份按钮文案随视图状态同步
  function syncYearBtn(){
    if(yearMode){yearBtn.textContent="‹ 月度";yearBtn.classList.add("is-active");}
    else{yearBtn.textContent=cnMonth().slice(0,4)+" 年度 ›";yearBtn.classList.remove("is-active");}
  }
  function enterYear(){
    if(yearMode)return;
    yearMode=true;year=Number(cnMonth().slice(0,4));syncYearBtn();renderYear();
  }
  function exitYear(){
    if(!yearMode)return;
    yearMode=false;syncYearBtn();renderMonth();
  }
  function toggleYear(){ if(yearMode)exitYear();else enterYear(); }
  // 年度视图内跨年切换（仅在有数据的相邻年份间移动）
  function yearList(){
    const s=new Set(availableMonths.map(m=>Number(m.slice(0,4))));
    for(const k of byMonth.keys())s.add(Number(k.slice(0,4)));
    return [...s].sort((a,b)=>a-b);
  }
  function goYear(delta){
    if(!yearMode)return;
    const ys=yearList(),i=ys.indexOf(year);
    if(i<0)return;
    const ni=i+delta;
    if(ni<0||ni>=ys.length)return;
    year=ys[ni];renderYear();
  }
  // 左右滑动意图（与按钮、动画解耦，保证手势始终可识别）
  function onSwipeLeft(){  if(yearMode)goYear(-1); else navigate(1); }  // 左滑：更旧月 / 更旧年
  function onSwipeRight(){ if(yearMode)exitYear(); else enterYear(); }  // 右滑：进入「年度配送」/ 返回月度
  function setMetric(m){
    if(m!=="weight"&&m!=="count")return;
    metric=m;
    metricWeightBtn.classList.toggle("is-active",m==="weight");
    metricCountBtn.classList.toggle("is-active",m==="count");
    metricWeightBtn.setAttribute("aria-pressed",String(m==="weight"));
    metricCountBtn.setAttribute("aria-pressed",String(m==="count"));
    if(yearMode)renderYear();else renderMonth();   // 两画面共用同一指标，切换即重绘当前视图
  }

  /* ---------- 事件 ---------- */
  prev?.addEventListener("click",()=>navigate(1));    // 上一个月（更旧）
  next?.addEventListener("click",()=>navigate(-1));   // 下一个月（更新；当前月时禁用）
  metricWeightBtn?.addEventListener("click",()=>setMetric("weight"));
  metricCountBtn?.addEventListener("click",()=>setMetric("count"));
  yearBtn?.addEventListener("click",toggleYear);
  // 左右滑动：月度下 左滑=更旧月、右滑=进入「年度配送」；年度下 左滑=更旧年、右滑=返回月度。
  // 安卓 Chrome 在可纵向滚动页面里：用方向锁定（先到 6px 即判定 X/Y），横向意图时 touchmove
  // preventDefault 吃下手势、阻止浏览器纵向滚动接管并发 touchcancel 误杀手势。
  (function bindSwipe(){
    if(!card)return;
    let sx=0,sy=0,active=false,locked=null;
    const MIN=44;
    const down=e=>{const t=e.touches?.[0]||e;if(!t)return;sx=t.clientX;sy=t.clientY;active=true;locked=null;};
    const move=e=>{
      if(!active)return;
      const t=e.touches?.[0]||e;if(!t)return;
      const dx=t.clientX-sx,dy=t.clientY-sy;
      if(locked===null&&(Math.abs(dx)>6||Math.abs(dy)>6))locked=Math.abs(dx)>Math.abs(dy)?"x":"y";
      if(locked==="x"&&e.cancelable)e.preventDefault(); // 横向意图：阻止页面滚动抢走手势
    };
    const up=e=>{
      if(!active)return;active=false;
      if(locked!=="x")return;             // 纵向手势不触发切换
      const t=e.changedTouches?.[0]||e;if(!t)return;
      const dx=t.clientX-sx,dy=t.clientY-sy;
      if(Math.abs(dx)<MIN||Math.abs(dx)<Math.abs(dy))return;
      if(dx<0)onSwipeLeft();else onSwipeRight();
    };
    card.addEventListener("touchstart",down,{passive:true});
    card.addEventListener("touchmove",move,{passive:false});
    card.addEventListener("touchend",up,{passive:true});
    card.addEventListener("touchcancel",up,{passive:true});
  })();

  /* ---------- 数据加载 ---------- */
  async function load(){
    try{
      const r=await fetch("/api/history",{credentials:"same-origin",cache:"no-store"});
      if(!r.ok)return;
      const d=await r.json().catch(()=>null);
      if(!d?.success||!Array.isArray(d.history))return;
      daily=d.history.filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x?.date||"")));
      byMonth=new Map((Array.isArray(d.months)?d.months:[]).map(x=>[String(x.month),x]));
      const today=cnMonth();
      const list=[];
      for(let i=0;i<13;i++){
        const [y,m]=today.split("-").map(Number),idx=y*12+(m-1)-i;
        list.push(Math.floor(idx/12)+"-"+String(idx%12+1).padStart(2,"0"));
      }
      availableMonths=list.filter(m=>monthDiff(m,today)<=0); // 仅保留不晚于今日的月份（更早月份可左滑查看）
      currentMonth=today;
      card.hidden=false;
      card.classList.add("is-in");
      renderMonth();
      syncYearBtn();
    }catch{}
  }
  load();
})();
