import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,command,newId} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
import {businessFingerprint} from "../_waybill-identity.js";
import {TEMP_DISPATCH_ID} from "../dispatch.js";
import {getRoute} from "../_route.js";
import {recognizeImage} from "./ocr.js";
import {findGlobalMatches} from "../_global-learning.js";
import {clean,formatCompareKey,matchStores} from "./_store-match.js";

const waybillIndexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;
const number=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
async function base(env,id){const raw=await get(env,"route:"+id+":base");if(!raw)throw Object.assign(new Error("线路数据资料尚未建立"),{code:"BASE_NOT_FOUND"});let x;try{x=typeof raw==="string"?JSON.parse(raw):raw}catch{throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"})}if(!x||!Array.isArray(x.stores))throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"});return x.stores}

function extract(rawText){
  const stores=[]; let date=null,vehicle=null,totalWeight=null;
  const lines=clean(rawText).split(/\r?\n+/).map(x=>x.trim()).filter(Boolean).slice(0,5000);
  const full=lines.join(" ");
  const dm=full.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  if(dm){const p=dm[1].replace(/[年月/.]/g,"-").replace(/日$/,"").split("-").map(x=>x.padStart(2,"0"));if(p.length===3)date=p.join("-")}
  // OCR 常会把车牌省份简称、字母和数字之间拆成空格，因此车辆提取不能要求字符连续。
  // 先按车辆字段提取，再对整段文本做通用车牌兜底；只做格式兼容，不做具体车辆硬编码。
  const vehiclePattern=/(?:车牌号?|车牌|车辆|车号)\s*[:：]?\s*([\u4e00-\u9fa5])\s*([A-Z])\s*([A-Z0-9]{5,8})/i;
  let vm=full.match(vehiclePattern);
  if(!vm)vm=full.match(/(^|[^\u4e00-\u9fa5A-Z0-9])([\u4e00-\u9fa5])\s*([A-Z])\s*([A-Z0-9]{5,8})(?=$|[^A-Z0-9])/i);
  if(vm){
    const groups=vm.length===4?vm.slice(2):vm.slice(1);
    vehicle=(groups[0]+groups[1]+groups[2]).toUpperCase();
  }
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
    const candidates=[...unique.values()].sort((a,b)=>b.key.length-a.key.length||a.pos-b.pos);
    const selected=[];
    for(const candidate of candidates){
      const start=candidate.pos;
      const end=start+candidate.key.length;
      const overlaps=selected.some(hit=>{
        const hitStart=hit.pos;
        const hitEnd=hitStart+hit.key.length;
        return start< hitEnd && hitStart<end;
      });
      if(!overlaps)selected.push(candidate);
    }
    selected.sort((a,b)=>a.pos-b.pos||b.key.length-a.key.length);
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

async function runProcess({request,env,emit=()=>{},form:providedForm=null,user:providedUser=null}){
  emit(3,"运单已接收");
  const user=providedUser||await currentUser(request,env);if(!user){emit(4,"身份验证失败");return json({success:false,code:"AUTH_REQUIRED",error:"未登录"},401)};if(user.role==="admin"||!canUseRoute(user)){emit(4,"无权处理运单");return json({success:false,code:"WAYBILL_PROCESS_FORBIDDEN",error:"无权处理运单"},403)};
  emit(5,"正在读取运单");
  let form=providedForm;try{if(!form)form=await request.formData()}catch{emit(5,"运单提交格式错误");return json({success:false,code:"WAYBILL_FORM_INVALID",error:"运单提交格式错误"},400)}
  const requestedRouteId=clean(form.get("routeId"));const routeId=clean(user.dispatchRouteId||user.boundRouteId);if(!routeId){emit(0,"等待配送线路");return json({success:false,code:"DISPATCH_ROUTE_MISSING",error:"请先选择调度线路"},400);}if(requestedRouteId&&requestedRouteId!==routeId){emit(0,"线路校验失败");return json({success:false,code:"DISPATCH_ROUTE_MISMATCH",error:"提交线路与当前调度线路不一致，请刷新后重试"},403);}
  let route=null;if(routeId!==TEMP_DISPATCH_ID){emit(6,"正在校验配送线路");route=await getRoute(env,routeId);if(!route||route.status!=="active"){emit(6,"当前配送线路不可用");return json({success:false,code:"DISPATCH_ROUTE_INACTIVE",error:"当前调度线路不存在或已停用，请重新选择线路"},409)}}
  const rawText=clean(form.get("rawText")),file=form.get("file");if(!rawText&&!(file instanceof File)){emit(6,"未找到运单");return json({success:false,code:"WAYBILL_FILE_MISSING",error:"请选择运单"},400)};emit(6,"已读取运单");
  const started=Date.now();let ocr=null,recognizedText=rawText,ocrMs=0;
  if(!recognizedText){const ocrStarted=Date.now();emit(8,"运单已上传，正在排队识别…");try{ocr=await recognizeImage(env,file,p=>{const v=Number(p||0);emit(8+Math.round(v*0.44),v<=10?"运单已上传，正在排队识别…":"正在识别运单…");});recognizedText=ocr.rawText;ocrMs=Date.now()-ocrStarted}catch(e){return json({success:false,code:e.code||"OCR_FAILED",message:e.message||"OCR识别失败",jobId:e.jobId||null},e.code==="OCR_NOT_CONFIGURED"?503:422)}}
  const recognizedMs=Date.now()-started;const baseStarted=Date.now();let baseStores=[];let baseAvailable=false;if(routeId!==TEMP_DISPATCH_ID){try{baseStores=await base(env,routeId);baseAvailable=Array.isArray(baseStores)&&baseStores.length>0}catch(e){if(e?.code!=="BASE_NOT_FOUND")return json({success:false,code:e.code||"BASE_DATA_INVALID",message:e.message||"线路数据资料读取失败"},409)}}const baseMs=Date.now()-baseStarted;emit(56,baseAvailable?"已读取线路基准":"未建立线路基准，转入全局学习");
  const extractedStarted=Date.now();const extracted=extract(recognizedText);const rawExtractCount=extracted.stores.length;extracted.stores=splitByRouteBase(extracted.stores,baseStores);const splitExtractCount=extracted.stores.length;const extractMs=Date.now()-extractedStarted;emit(66,`已提取 ${extracted.stores.length} 家门店`);if(!extracted.stores.length)return json({success:false,code:"EXTRACT_EMPTY",message:"未提取到门店，请检查运单内容"},422);
  const rawExtractItems=extracted.stores.map((s,i)=>({index:i+1,rawName:s.rawName,name:s.name,storeId:s.storeId||null,sourceLine:s.sourceLine||null}));const matchStarted=Date.now();const locallyMatched=matchStores(extracted.stores,baseStores);const hasRouteBase=baseAvailable;const globalCandidates=hasRouteBase?[]:await findGlobalMatches(env,locallyMatched.filter(x=>x.pending));const globalMap=new Map(globalCandidates.map(x=>[x.rawName+"|"+(x.sourceLine||""),x]));const matched=locallyMatched.map(x=>{if(!x.pending)return x;const g=globalMap.get(x.rawName+"|"+(x.sourceLine||""));if(!g||g.globalMatchStatus!=="matched")return x;const standard=clean(g.name)||x.rawName;return {...x,...g,name:standard,correction:formatCompareKey(x.rawName)!==formatCompareKey(standard),pending:false,matchStatus:"matched",matchMethod:g.globalMatchMethod,routeOrder:100000};});const matchMs=Date.now()-matchStarted;emit(78,hasRouteBase?"已完成线路基准匹配":"已完成全局学习匹配");const dedupeStarted=Date.now();const d=dedupe(matched);const dedupeMs=Date.now()-dedupeStarted;emit(86,`已完成去重${d.merged?`，合并 ${d.merged} 家`:""}`);const planStarted=Date.now();const useRouteOrder=baseAvailable;const planned=plan(d.items,useRouteOrder);const planMs=Date.now()-planStarted;const pending=planned.filter(x=>x.pending);emit(92,`已完成线路规划，共 ${planned.length} 家`);
  const formWeight=number(form.get("totalWeight"));const effectiveWeight=formWeight!=null&&formWeight>0?formWeight:extracted.totalWeight;const order={schemaVersion:"2",id:newId(),routeId,routeName:clean(route?.name)||"临时",date:clean(form.get("date"))||extracted.date||null,vehicle:clean(form.get("vehicle"))||extracted.vehicle||null,totalWeight:effectiveWeight,stores:planned,rawText:recognizedText,stage:pending.length?"PLANNED":"CONFIRMED",pipeline:["RECOGNIZED","EXTRACTED","MATCHED","DEDUPED","PLANNED","VALIDATED",...(pending.length?[]:["CONFIRMED"])],summary:{original:rawExtractCount,total:planned.length,matched:planned.length-pending.length,pending:pending.length,correction:planned.filter(x=>x.correction).length,merged:d.merged,newStores:0},timing:{recognizedMs,ocrMs,baseMs,extractMs,matchMs,dedupeMs,planMs,totalMs:Date.now()-started},ocr:ocr?{provider:ocr.provider||"PaddleOCR",model:ocr.model,jobId:ocr.jobId,lineCount:ocr.lineCount,fallback:ocr.fallback||null}:null,createdBy:user.id,createdAt:new Date().toISOString()};
  if(!pending.length){order.confirmedAt=order.createdAt;order.confirmedBy=user.id;}
  const validation=validateResult(order);order.validation=validation;if(!validation.valid){const first=validation.errors?.[0]||"校验失败";const codeMap={"缺少运单日期":"WAYBILL_VALIDATION_DATE_MISSING","缺少车辆信息":"WAYBILL_VALIDATION_VEHICLE_MISSING","没有规划门店":"WAYBILL_VALIDATION_STORES_EMPTY","规划结果存在重复门店":"WAYBILL_VALIDATION_DUPLICATE_STORE","规划结果存在无效线路顺序":"WAYBILL_VALIDATION_ROUTE_ORDER_INVALID","规划结果存在重复线路顺序":"WAYBILL_VALIDATION_ROUTE_ORDER_DUPLICATE","线路顺序不连续":"WAYBILL_VALIDATION_ROUTE_ORDER_GAP"};return json({success:false,code:codeMap[first]||"WAYBILL_VALIDATION_FAILED",error:"运单规划结果校验失败："+first,validation},422)}order.diagnostics={matchMode:hasRouteBase?"ROUTE_BASE":"GLOBAL_LEARNING",baseStoreCount:baseStores.length,rawExtractCount,extractCount:extracted.stores.length,splitExtractCount,rawExtractItems,extractItems:extracted.stores.map((s,i)=>({index:i+1,rawName:s.rawName,name:s.name,storeId:s.storeId||null})),localMatchedCount:locallyMatched.filter(x=>!x.pending).length,localPendingCount:locallyMatched.filter(x=>x.pending).length,localPendingItems:locallyMatched.filter(x=>x.pending).map(x=>({rawName:x.rawName,candidates:x.candidates||[]})),globalMatchedCount:matched.filter(x=>!x.pending&&(x.matchMethod==="global-alias"||x.matchMethod==="global-identity")).length,globalPendingCount:hasRouteBase?0:matched.filter(x=>x.pending).length,finalPendingCount:pending.length,dedupeBefore:matched.length,dedupeAfter:d.items.length,merged:d.merged,dedupeConflicts:d.conflicts,dedupeRemoved:d.removed,correctionItems:planned.filter(x=>x.correction).map((s,i)=>({rawName:s.rawName,name:s.name,storeId:s.storeId||null,matchMethod:s.matchMethod||null})),plannedCount:planned.length,finalCount:order.stores.length,finalItems:planned.map((s,i)=>({index:i+1,rawName:s.rawName,name:s.name,storeId:s.storeId||null,pending:!!s.pending,matchMethod:s.matchMethod||null,routeOrder:s.routeOrder}))};
  emit(96,"正在保存运单");
  order.businessFingerprint=await businessFingerprint(order);
  const fingerprintKey="zp:waybill:fingerprint:"+order.businessFingerprint;
  const indexKey=waybillIndexKey(routeId,clean(order.date));
  const saveScript='local existing=redis.call("GET",KEYS[1]); if existing and existing~=ARGV[1] then local raw=redis.call("GET","zp:waybill:"..existing); if raw then redis.call("SADD",KEYS[3],existing); return existing else redis.call("DEL",KEYS[1]) end end; redis.call("SET",KEYS[1],ARGV[1]); redis.call("SET",KEYS[2],ARGV[2]); redis.call("SADD",KEYS[3],ARGV[1]); return ARGV[1]';
  let saveResult;
  try{
    saveResult=await command(env,["EVAL",saveScript,"3",fingerprintKey,"zp:waybill:"+order.id,indexKey,order.id,JSON.stringify(order)]);
  }catch(e){
    return json({success:false,code:"WAYBILL_SAVE_FAILED",error:"运单保存失败",detail:e?.message||String(e)},500);
  }
  if(String(saveResult)!==order.id){
    const existing=await get(env,"waybill:"+String(saveResult));
    if(existing){
      const existingOrder=typeof existing==="string"?JSON.parse(existing):existing;
      await command(env,["SADD",waybillIndexKey(routeId,clean(existingOrder.date)),existingOrder.id]);
      return json({success:true,waybill:existingOrder,idempotent:true,indexSync:"OK"});
    }
    return json({success:false,code:"WAYBILL_FINGERPRINT_CONFLICT",error:"相同业务运单正在保存，请稍后重试"},409);
  }
  emit(100,"处理完成");
  return json({success:true,waybill:order,pipeline:order.pipeline,summary:order.summary,indexSync:"OK"});
}

export async function onRequestPost({request,env}){
  const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
  if(new URL(request.url).searchParams.get("stream")!=="1")return runProcess({request,env});
  const encoder=new TextEncoder();
  let closed=false;
  let heartbeat=null;
  const streamBody=new ReadableStream({start(controller){
    const push=value=>{
      if(closed)return false;
      try{controller.enqueue(encoder.encode(value));return true}catch{closed=true;return false}
    };
    const emit=(progress,message)=>push(JSON.stringify({type:"progress",progress,message})+"\n");
    heartbeat=setInterval(()=>push(JSON.stringify({type:"heartbeat",ts:Date.now()})+"\n"),1000);
    // 先建立响应流并立即发送首个进度事件，再在流内部读取 multipart/form-data。
    // 避免 request.formData() 阻塞响应头和首个进度事件，导致客户端长时间停在 3%。
    emit(3,"运单已接收");
    runProcess({request,env,emit,user}).then(async response=>{
      let payload={};try{payload=await response.clone().json()}catch(error){payload={success:false,error:"处理结果读取失败"}}
      push(JSON.stringify({type:"result",...payload})+"\n");
      if(heartbeat)clearInterval(heartbeat);
      if(!closed){closed=true;try{controller.close()}catch{}}
    }).catch(error=>{
      push(JSON.stringify({type:"result",success:false,code:error?.code||"PROCESS_UNHANDLED_ERROR",message:error?.message||"处理流程发生未捕获异常",error:error?.message||"处理流程发生未捕获异常",detail:error?.stack||String(error||"")})+"\n");
      if(heartbeat)clearInterval(heartbeat);
      if(!closed){closed=true;try{controller.close()}catch{}}
    });
  },cancel(){
    closed=true;
    if(heartbeat)clearInterval(heartbeat);
  }});
  return new Response(streamBody,{status:200,headers:{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-store, no-transform","X-Accel-Buffering":"no","X-Content-Type-Options":"nosniff"}});
}
