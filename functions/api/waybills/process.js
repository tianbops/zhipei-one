import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,newId} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
import {TEMP_DISPATCH_ID} from "../dispatch.js";
import {getRoute} from "../_route.js";
import {recognizeImage} from "./ocr.js";
import {findGlobalMatches} from "../_global-learning.js";
import {clean,formatCompareKey,matchStores,businessStoreCode} from "./_store-match.js";

const todayCN=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const number=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
async function base(env,id){const raw=await get(env,"route:"+id+":base");if(!raw)throw Object.assign(new Error("线路数据资料尚未建立"),{code:"BASE_NOT_FOUND"});let x;try{x=typeof raw==="string"?JSON.parse(raw):raw}catch{throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"})}if(!x||!Array.isArray(x.stores))throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"});return x.stores}

function extract(rawText){
  const stores=[]; let date=null,vehicle=null,totalWeight=null;
  const lines=clean(rawText).split(/\r?\n+/).map(x=>x.trim()).filter(Boolean).slice(0,5000);
  const full=lines.join(" ");
  const dm=full.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  if(dm){const p=dm[1].replace(/[年月/.]/g,"-").replace(/日$/,"").split("-").map(x=>x.padStart(2,"0"));if(p.length===3)date=p.join("-")}
  const vm=full.match(/(?:车牌|车辆|车号)\s*[:：]?\s*([\u4e00-\u9fa5A-Z]{1,3}[A-Z0-9]{5,8})/i);
  if(vm)vehicle=vm[1];
  const wm=full.match(/(?:总重量|重量)\s*[:：]?\s*([\d.]+)\s*(?:吨|t|T)?/);
  if(wm)totalWeight=number(wm[1]);

  const waybillTail=/ZW\d{8}[A-Z0-9]+/ig;
  const cleanStoreName=value=>clean(value)
    .replace(/^[\s|>→]+|[\s|>→]+$/g,"")
    .replace(/^[-:：]+/,"")
    .replace(waybillTail,"")
    .trim();

  const addRouteText=text=>{
    const hasWaybillCode=/\bZW\d{8}[A-Z0-9]+\b/i.test(text);
    const parts=clean(text).split(/\s*(?:-\s*>|→|＞)\s*/).map(cleanStoreName).filter(Boolean);
    for(let partIndex=0;partIndex<parts.length;partIndex++){
      let part=parts[partIndex];
      if(hasWaybillCode&&partIndex===parts.length-1){
        part=part.replace(/\s+\d{5,}(?:\s+\d{5,})*\s*$/g,"").trim();
      }
      const idm=part.match(/\b(?:JM|A|Q)[\p{Pd}_ ]?\d{3,12}\b/i);
      const storeId=idm?idm[0].replace(/[\p{Pd} ]/gu,"").toUpperCase():null;
      const rawName=cleanStoreName(part);
      const name=cleanStoreName(part.replace(/\b(?:JM|A|Q)[\p{Pd}_ ]?\d{3,12}\b/i,""));
      if(name.length>=2&&/[\u4e00-\u9fa5A-Za-z]/.test(name))stores.push({rawName, name, sourceLine:text, storeId});
    }
  };

  const firstArrow=full.search(/\s*(?:->|→|＞)\s*/);
  if(firstArrow>=0){
    let routeText=full;
    const percentMatches=[...full.matchAll(/\(?\s*\d+(?:\.\d+)?\s*%\s*\)?/g)];
    if(percentMatches.length){
      const last=percentMatches[percentMatches.length-1];
      if(last.index<firstArrow)routeText=full.slice(last.index+last[0].length);
    }
    addRouteText(routeText);
  }else{
    for(const line of lines){
      if(/^(?:运单列表|订单列表|运输日期|日期|时间|车牌号?|车辆|车号|额定装载|额定载重|额定体积|主司机|司机|送货员|承运订单|总重量|总数量|数量|件数|总体积)/i.test(line))continue;
      const cleaned=line.replace(/(?:运单列表订单列表|承运订单.*?)(?=[\u4e00-\u9fa5])/g,"").trim();
      if(cleaned) addRouteText(cleaned);
    }
  }
  return {date,vehicle,totalWeight,stores};
}

function baseIdentityNames(store){
  return [store?.name,store?.originalName,...(Array.isArray(store?.aliases)?store.aliases:[])]
    .map(v=>clean(v).split('•')[0].split('·')[0].trim()).filter(v=>v.length>=2);
}

function splitByRouteBase(items,baseStores){
  const bases=Array.isArray(baseStores)?baseStores:[];
  if(!bases.length)return items;
  return items.flatMap(item=>{
    const rawName=clean(item?.rawName||item?.name);
    const rawKey=formatCompareKey(rawName);
    const hits=[];
    for(const store of bases){
      for(const name of baseIdentityNames(store)){
        const key=formatCompareKey(name);
        if(key.length>=4&&rawKey.includes(key))hits.push({store,name,key,pos:rawKey.indexOf(key)});
      }
    }
    const unique=new Map();
    for(const hit of hits){const id=clean(hit.store?.storeId)||hit.key;const old=unique.get(id);if(!old||hit.key.length>old.key.length)unique.set(id,hit);}
    const selected=[...unique.values()].sort((a,b)=>a.pos-b.pos||b.key.length-a.key.length);
    if(selected.length<2)return [item];
    return selected.map((hit,index)=>({...item,rawName:hit.name,name:hit.name,storeId:clean(hit.store?.storeId)||null,extractionMethod:'route-base-segment',extractionSegment:index+1,extractionSegments:selected.length}));
  });
}

function validateResult(order){
  const errors=[];
  if(!order.date)errors.push("缺少运单日期");
  if(!order.vehicle)errors.push("缺少车辆信息");
  if(!Array.isArray(order.stores)||!order.stores.length)errors.push("没有规划门店");
  const seen=new Set();const seenOrders=new Set();for(const s of order.stores||[]){const k=s.storeId?"id:"+s.storeId:"pending:"+formatCompareKey(s.rawName);if(seen.has(k))errors.push("规划结果存在重复门店");seen.add(k);const ro=number(s.routeOrder);if(ro==null||ro<1||!Number.isInteger(ro))errors.push("规划结果存在无效线路顺序");else if(seenOrders.has(ro))errors.push("规划结果存在重复线路顺序");else seenOrders.add(ro)}
  if((order.stores||[]).some((s,i)=>s.routeOrder!==i+1))errors.push("线路顺序不连续");
  return {valid:errors.length===0,errors};
}
function dedupe(items){
  const seen=new Map(),out=[],conflicts=[],removed=[];
  let merged=0;
  for(const s of items){
    const identityKey=formatCompareKey(s.name||s.rawName);
    let key=s.storeId?"id:"+s.storeId:"pending:"+identityKey;
    if(s.storeId&&seen.has(key)){
      const previous=seen.get(key);
      const previousIdentity=formatCompareKey(previous.name||previous.rawName);
      if(previousIdentity!==identityKey){
        key="id-conflict:"+s.storeId+":"+identityKey;
        conflicts.push({storeId:s.storeId,firstName:previous.name||previous.rawName,conflictName:s.name||s.rawName});
      }else{
        merged++;
        removed.push({rawName:s.rawName,name:s.name,storeId:s.storeId||null,mergedInto:{rawName:previous.rawName,name:previous.name,storeId:previous.storeId||null}});
        continue;
      }
    }
    seen.set(key,s);
    out.push(s);
  }
  return{items:out,merged,conflicts,removed};
}
function plan(items,useRouteOrder=true){const list=useRouteOrder?[...items].sort((a,b)=>(number(a.routeOrder)??100000)-(number(b.routeOrder)??100000)||formatCompareKey(a.name).localeCompare(formatCompareKey(b.name),"zh-CN")):[...items];return list.map((s,i)=>({...s,routeOrder:i+1}))}

export async function onRequestPost({request,env}){
  const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权处理运单"},403);
  let form;try{form=await request.formData()}catch{return json({success:false,error:"运单提交格式错误"},400)}
  const requestedRouteId=clean(form.get("routeId"));const routeId=clean(user.dispatchRouteId||user.boundRouteId);if(!routeId)return json({success:false,error:"请先选择调度线路"},400);if(requestedRouteId&&requestedRouteId!==routeId)return json({success:false,code:"DISPATCH_ROUTE_MISMATCH",error:"提交线路与当前调度线路不一致，请刷新后重试"},403);
  if(routeId!==TEMP_DISPATCH_ID){const route=await getRoute(env,routeId);if(!route||route.status!=="active")return json({success:false,code:"DISPATCH_ROUTE_INACTIVE",error:"当前调度线路不存在或已停用，请重新选择线路"},409)}
  const rawText=clean(form.get("rawText")),file=form.get("file");if(!rawText&&!(file instanceof File))return json({success:false,error:"请选择运单"},400);
  const started=Date.now();let ocr=null,recognizedText=rawText,ocrMs=0;
  if(!recognizedText){const ocrStarted=Date.now();try{ocr=await recognizeImage(env,file);recognizedText=ocr.rawText;ocrMs=Date.now()-ocrStarted}catch(e){return json({success:false,code:e.code||"OCR_FAILED",message:e.message||"OCR识别失败",jobId:e.jobId||null},e.code==="OCR_NOT_CONFIGURED"?503:422)}}
  const recognizedMs=Date.now()-started;const baseStarted=Date.now();let baseStores=[];if(routeId!==TEMP_DISPATCH_ID){try{baseStores=await base(env,routeId)}catch(e){return json({success:false,code:e.code||"BASE_DATA_INVALID",message:e.message||"线路数据资料读取失败"},409)}if(!baseStores.length)return json({success:false,code:"BASE_EMPTY",message:"当前线路尚未建立门店数据资料，请先完善线路数据资料"},409)}const baseMs=Date.now()-baseStarted;
  const extractedStarted=Date.now();const extracted=extract(recognizedText);const rawExtractCount=extracted.stores.length;extracted.stores=splitByRouteBase(extracted.stores,baseStores);const splitExtractCount=extracted.stores.length;const extractMs=Date.now()-extractedStarted;if(!extracted.stores.length)return json({success:false,code:"EXTRACT_EMPTY",message:"未提取到门店，请检查运单内容"},422);
  const matchStarted=Date.now();const locallyMatched=matchStores(extracted.stores,baseStores);const hasRouteBase=routeId!==TEMP_DISPATCH_ID&&baseStores.length>0;const globalCandidates=hasRouteBase?[]:await findGlobalMatches(env,locallyMatched.filter(x=>x.pending));const globalMap=new Map(globalCandidates.map(x=>[x.rawName+"|"+(x.sourceLine||""),x]));const matched=locallyMatched.map(x=>{if(!x.pending)return x;const g=globalMap.get(x.rawName+"|"+(x.sourceLine||""));if(!g||g.globalMatchStatus!=="matched")return x;const standard=clean(g.name)||x.rawName;return {...x,...g,name:standard,correction:formatCompareKey(x.rawName)!==formatCompareKey(standard),pending:false,matchStatus:"matched",matchMethod:g.globalMatchMethod,routeOrder:100000};});const matchMs=Date.now()-matchStarted;const dedupeStarted=Date.now();const d=dedupe(matched);const dedupeMs=Date.now()-dedupeStarted;const planStarted=Date.now();const useRouteOrder=routeId!==TEMP_DISPATCH_ID&&baseStores.length>0;const planned=plan(d.items,useRouteOrder);const planMs=Date.now()-planStarted;const pending=planned.filter(x=>x.pending);
  const formWeight=number(form.get("totalWeight"));const effectiveWeight=formWeight!=null&&formWeight>0?formWeight:extracted.totalWeight;const order={schemaVersion:"2",id:newId(),routeId,date:clean(form.get("date"))||extracted.date||null,vehicle:clean(form.get("vehicle"))||extracted.vehicle||null,totalWeight:effectiveWeight,stores:planned,rawText:recognizedText,stage:"PLANNED",pipeline:["RECOGNIZED","EXTRACTED","MATCHED","DEDUPED","PLANNED","VALIDATED"],summary:{original:extracted.stores.length,total:planned.length,matched:planned.length-pending.length,pending:pending.length,correction:planned.filter(x=>x.correction).length,merged:d.merged,newStores:0},timing:{recognizedMs,ocrMs,baseMs,extractMs,matchMs,dedupeMs,planMs,totalMs:Date.now()-started},ocr:ocr?{provider:"PaddleOCR",model:ocr.model,jobId:ocr.jobId,lineCount:ocr.lineCount}:null,createdBy:user.id,createdAt:new Date().toISOString()};
  const validation=validateResult(order);order.validation=validation;if(!validation.valid)return json({success:false,code:"WAYBILL_VALIDATION_FAILED",error:"运单规划结果校验失败，请重新处理运单",validation},422);order.diagnostics={matchMode:hasRouteBase?"ROUTE_BASE":"GLOBAL_LEARNING",baseStoreCount:baseStores.length,rawExtractCount,extractCount:extracted.stores.length,splitExtractCount,extractItems:extracted.stores.map((s,i)=>({index:i+1,rawName:s.rawName,name:s.name,storeId:s.storeId||null})),localMatchedCount:locallyMatched.filter(x=>!x.pending).length,localPendingCount:locallyMatched.filter(x=>x.pending).length,localPendingItems:locallyMatched.filter(x=>x.pending).map(x=>({rawName:x.rawName,candidates:x.candidates||[]})),globalMatchedCount:matched.filter(x=>!x.pending&&x.matchMethod==="global-alias"||!x.pending&&x.matchMethod==="global-identity").length,globalPendingCount:matched.filter(x=>x.pending).length,dedupeBefore:matched.length,dedupeAfter:d.items.length,merged:d.merged,dedupeConflicts:d.conflicts,dedupeRemoved:d.removed,correctionItems:planned.filter(x=>x.correction).map((s,i)=>({rawName:s.rawName,name:s.name,storeId:s.storeId||null,matchMethod:s.matchMethod||null})),plannedCount:planned.length,finalCount:order.stores.length,finalItems:planned.map((s,i)=>({index:i+1,rawName:s.rawName,name:s.name,storeId:s.storeId||null,pending:!!s.pending,matchMethod:s.matchMethod||null,routeOrder:s.routeOrder}))};
  await set(env,"waybill:"+order.id,order);
  let indexSync="OK";
  try{
    await set(env,"route:"+routeId+":orders:latest",order);
    if(order.date===todayCN())await set(env,"route:"+routeId+":orders:today",order);
  }catch{
    indexSync="DEFERRED";
    try{await command(env,["SADD","zp:route:"+routeId+":orders:index-repair",order.id])}catch{}
  }
  return json({success:true,waybill:order,pipeline:order.pipeline,summary:order.summary,indexSync});
}
