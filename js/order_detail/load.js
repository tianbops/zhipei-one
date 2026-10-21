'use strict';
async function load(){
 const directUrl=id?'/api/waybills/latest?id='+encodeURIComponent(id)
  :(source==='today'&&targetDate
    ?'/api/history?date='+encodeURIComponent(targetDate)
    :(source==='today'?'/api/waybills/latest?confirmed=1':'/api/waybills/latest'));

 const fetchJson=async(url,signal)=>{
  const r=await fetch(url,{credentials:'same-origin',cache:'no-store',signal});
  const d=await r.json().catch(()=>({}));
  return {r,d};
 };
 const findHistoryWaybill=async(signal)=>{
  if(!id)return null;
  // 详情直读异常时，以历史查询作为第二数据源；历史查询与详情共用同一 ACL，
  // 因而不会因为兜底而扩大用户可见范围。
  const dates=[];
  if(targetDate)dates.push(targetDate);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(!dates.includes(today))dates.push(today);
  for(const date of dates){
    try{
      const {r,d}=await fetchJson('/api/history?date='+encodeURIComponent(date),signal);
      const list=Array.isArray(d.waybills)?d.waybills:[];
      if(r.ok&&d.success!==false){
        const hit=list.find(x=>x&&String(x.id)===String(id));
        if(hit)return hit;
      }
    }catch{}
  }
  // 跨日期详情/历史入口：单日没有命中时，再用历史索引定位原运单。
  try{
    const {r,d}=await fetchJson('/api/history?months=25',signal);
    if(r.ok&&d.success!==false){
      const entries=Array.isArray(d.history)?d.history:[];
      for(const entry of entries){
        const ids=Array.isArray(entry?.waybillIds)?entry.waybillIds:[];
        if(ids.includes(id)){
          const date=entry.date;
          if(date){
            const one=await fetchJson('/api/history?date='+encodeURIComponent(date),signal);
            const list=Array.isArray(one.d?.waybills)?one.d.waybills:[];
            const hit=list.find(x=>x&&String(x.id)===String(id));
            if(one.r.ok&&one.d.success!==false&&hit)return hit;
          }
        }
      }
    }
  }catch{}
  return null;
 };
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),12000);
 try{
  const {r,d}=await fetchJson(directUrl,controller.signal);
  let waybill=d.waybill||null;
  if(!r.ok||!d.success)throw Error(d.error||'运单读取失败');
  // 显式 ID 读取若因历史索引/线路上下文异常返回空，不能直接显示 0 家；
  // 既然历史查询是同一权限域内的已保存事实，则按 ID 从历史源恢复。
  if(id&&!waybill)waybill=await findHistoryWaybill(controller.signal);
  if(id&&!waybill)throw Error('运单已保存，但详情读取失败，请稍后重试');
  if(!waybill&&!Array.isArray(d.waybills))throw Error(d.error||'暂无当日运单');
  if(source==='today'&&targetDate&&Array.isArray(d.waybills)&&d.waybills.length){
    historyChoices=d.waybills;
    order=d.waybills[0];
  }else{
    historyChoices=null;order=waybill;
  }
  render();
  bindHistoryGestures();
 }catch(e){
  if(e?.name==='AbortError')throw Error('运单读取超时，请重试');
  throw e;
 }finally{clearTimeout(timer)}
}

// 待定门店的"指定已有门店"入口需要线路基准库；按线路缓存，同一张运单多次打开只读一次
async function loadBaseStores(routeId){
 if(baseStoreCache&&baseStoreRoute===routeId)return baseStoreCache;
 const r=await fetch('/api/base?routeId='+encodeURIComponent(routeId),{credentials:'same-origin',cache:'no-store'});
 const d=await r.json().catch(()=>({}));
 if(!r.ok||!d.success)throw Error(d.error||'线路数据资料读取失败');
 const stores=Array.isArray(d.base?.stores)?d.base.stores:[];
 baseStoreRoute=routeId;baseStoreCache=stores;
 return stores;
}
