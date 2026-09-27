import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,newId} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
import {TEMP_DISPATCH_ID} from "../dispatch.js";
import {recognizeImage} from "./ocr.js";
import {findGlobalMatches} from "../_global-learning.js";
import {clean,normalizeStoreName,correctionKey,matchStores} from "./_store-match.js";

const clean=v=>String(v??"").trim();

export const normalizeStoreName=v=>{
  let s=clean(v);
  try{s=s.normalize("NFKC")}catch{}
  return s
    .replace(/[\p{Z}\p{Cf}\p{P}\p{S}]+/gu,"")
    .replace(/Ⅱl|Il|II|ⅱ/gi,"II")
    .toLowerCase();
};

export const correctionKey=v=>
  normalizeStoreName(v).replace(/(?:jm|a|q)\d{3,12}/gi,"");

export const businessStoreCode=v=>{
  const m=clean(v).match(/(?:^|[^A-Z0-9])(JM|A|Q)[-_ ]?(\d{3,12})(?=$|[^A-Z0-9])/i);
  return m?(m[1]+m[2]).toUpperCase():null;
};

const identityFields=s=>[
  s?.name,
  s?.originalName,
  ...(Array.isArray(s?.aliases)?s.aliases:[])
].map(clean).filter(Boolean);

const similarity=(a,b)=>{
  const x=normalizeStoreName(a),y=normalizeStoreName(b);
  if(!x||!y)return 0;
  if(x===y)return 1;
  if(x.includes(y)||y.includes(x))return Math.min(x.length,y.length)/Math.max(x.length,y.length);
  const sx=new Set([...x]),sy=new Set([...y]);
  let common=0;
  for(const c of sx)if(sy.has(c))common++;
  return common/(new Set([...sx,...sy]).size||1);
};

export function matchStores(items,baseStores){
  const byId=new Map();
  const byCode=new Map();
  const byName=new Map();

  for(const store of Array.isArray(baseStores)?baseStores:[]){
    const id=clean(store?.storeId);
    if(id)byId.set(id,store);

    for(const field of identityFields(store)){
      const key=normalizeStoreName(field);
      if(!key)continue;
      const current=byName.get(key);
      byName.set(key,current&&current.storeId!==store.storeId?null:store);
    }

    for(const field of [store?.storeId,store?.name,store?.originalName,...(Array.isArray(store?.aliases)?store.aliases:[])]){
      const code=businessStoreCode(field);
      if(!code)continue;
      const current=byCode.get(code);
      byCode.set(code,current&&current.storeId!==store.storeId?null:store);
    }
  }

  return (items||[]).map((item,index)=>{
    const rawName=clean(item?.rawName||item?.name);
    const incomingId=clean(item?.storeId);
    const incomingCode=businessStoreCode(rawName)||businessStoreCode(item?.name)||businessStoreCode(incomingId);
    let target=null;
    let method=null;

    if(incomingId) {
      target=byId.get(incomingId)||null;
      if(target)method="identity";
    }

    if(!target&&incomingCode){
      target=byCode.get(incomingCode)||null;
      if(target)method="identity-code";
    }

    if(!target){
      const key=normalizeStoreName(rawName);
      const exact=byName.get(key)||null;
      if(exact){
        const candidateCode=businessStoreCode(exact.name)||businessStoreCode(exact.originalName);
        if(!incomingCode||!candidateCode||candidateCode===incomingCode){
          target=exact;
          method="exact";
        }
      }
    }

    let candidates=[];
    if(!target){
      candidates=baseStores.map(store=>{
        const candidateCode=businessStoreCode(store?.name)||businessStoreCode(store?.originalName);
        if(incomingCode&&candidateCode&&incomingCode!==candidateCode)return null;
        const score=Math.max(...identityFields(store).map(field=>similarity(rawName,field)),0);
        return {store,score};
      }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,5);
      const best=candidates[0];
      const second=candidates[1]?.score||0;
      if(best&&best.score>=0.86&&best.score-second>=0.08){
        target=best.store;
        method="similarity";
        candidates=[];
      }
    }

    if(!target){
      return {
        ...item,
        rawName,
        name:rawName,
        storeId:null,
        routeOrder:100000+index,
        matchStatus:"pending",
        matchMethod:null,
        correction:false,
        pending:true,
        candidates:candidates.map(x=>({
          storeId:clean(x.store?.storeId),
          name:clean(x.store?.name||x.store?.originalName),
          score:Number(x.score.toFixed(3))
        })),
        matchDiagnostics:{
          baseStoreCount:Array.isArray(baseStores)?baseStores.length:0,
          normalizedName:normalizeStoreName(rawName)
        }
      };
    }

    const standard=clean(target.name)||rawName;
    return {
      ...item,
      rawName,
      storeId:clean(target.storeId),
      name:standard,
      originalName:clean(target.originalName)||rawName,
      routeOrder:Number(target.routeOrder)||index+1,
      matchStatus:"matched",
      matchMethod:method,
      correction:correctionKey(rawName)!==correctionKey(standard),
      pending:false,
      candidates:[]
    };
  });
}

function dedupe(items){const seen=new Set(),out=[];let merged=0;for(const s of items){const key=s.storeId?"id:"+s.storeId:"pending:"+normalized(s.rawName);if(seen.has(key)){merged++;continue}seen.add(key);out.push(s)}return{items:out,merged}}
function plan(items,useRouteOrder=true){const list=useRouteOrder?[...items].sort((a,b)=>(number(a.routeOrder)??100000)-(number(b.routeOrder)??100000)||normalized(a.name).localeCompare(normalized(b.name),"zh-CN")):[...items];return list.map((s,i)=>({...s,routeOrder:i+1}))}

export async function onRequestPost({request,env}){try{
  const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权处理运单"},403);
  let form;try{form=await request.formData()}catch{return json({success:false,error:"运单提交格式错误"},400)}
  const routeId=clean(form.get("routeId")||user.dispatchRouteId||user.boundRouteId);if(!routeId)return json({success:false,error:"请先选择调度线路"},400);
  const rawText=clean(form.get("rawText")),file=form.get("file");if(!rawText&&!(file instanceof File))return json({success:false,error:"请选择运单"},400);
  const started=Date.now();let ocr=null,recognizedText=rawText,ocrMs=0;
  if(!recognizedText){const ocrStarted=Date.now();try{ocr=await recognizeImage(env,file);recognizedText=ocr.rawText;ocrMs=Date.now()-ocrStarted}catch(e){return json({success:false,code:e.code||"OCR_FAILED",message:e.message||"OCR识别失败",jobId:e.jobId||null},e.code==="OCR_NOT_CONFIGURED"?503:422)}}
  const recognizedMs=Date.now()-started;const baseStarted=Date.now();const baseStores=routeId===TEMP_DISPATCH_ID?[]:await base(env,routeId);const baseMs=Date.now()-baseStarted;
  const extractedStarted=Date.now();const extracted=extract(recognizedText);const extractMs=Date.now()-extractedStarted;if(!extracted.stores.length)return json({success:false,code:"EXTRACT_EMPTY",message:"未提取到门店，请检查运单内容"},422);
  const standardized=extracted.stores.map(standardizeStore);const matchStarted=Date.now();const locallyMatched=matchStores(standardized,baseStores);let globalCandidates=[];try{globalCandidates=await findGlobalMatches(env,locallyMatched.filter(x=>x.pending));}catch{globalCandidates=[];}const globalMap=new Map(globalCandidates.map(x=>[x.rawName+"|"+(x.sourceLine||""),x]));const matched=locallyMatched.map(x=>{if(!x.pending)return x;const g=globalMap.get(x.rawName+"|"+(x.sourceLine||""));if(!g||g.globalMatchStatus!=="matched")return x;const standard=clean(g.name)||x.rawName;return {...x,...g,name:standard,correction:correctionKey(x.rawName)!==correctionKey(standard),pending:false,matchStatus:"matched",matchMethod:g.globalMatchMethod,routeOrder:100000};});const matchMs=Date.now()-matchStarted;const dedupeStarted=Date.now();const d=dedupe(matched);const dedupeMs=Date.now()-dedupeStarted;const planStarted=Date.now();const useRouteOrder=routeId!==TEMP_DISPATCH_ID&&baseStores.length>0;const planned=plan(d.items,useRouteOrder);const planMs=Date.now()-planStarted;const pending=planned.filter(x=>x.pending);
  const formWeight=number(form.get("totalWeight"));const effectiveWeight=formWeight!=null&&formWeight>0?formWeight:extracted.totalWeight;const order={schemaVersion:"2",id:newId(),routeId,date:clean(form.get("date"))||extracted.date||null,vehicle:clean(form.get("vehicle"))||extracted.vehicle||null,totalWeight:effectiveWeight,stores:planned,rawText:recognizedText,stage:"PLANNED",pipeline:["RECOGNIZED","EXTRACTED","STANDARDIZED","MATCHED","DEDUPED","PLANNED","VALIDATED"],summary:{original:extracted.stores.length,total:planned.length,matched:planned.length-pending.length,pending:pending.length,correction:planned.filter(x=>x.correction).length,merged:d.merged,newStores:0},timing:{recognizedMs,ocrMs,baseMs,extractMs,matchMs,dedupeMs,planMs,totalMs:Date.now()-started},ocr:ocr?{provider:"PaddleOCR",model:ocr.model,jobId:ocr.jobId,lineCount:ocr.lineCount}:null,createdBy:user.id,createdAt:new Date().toISOString()};
  const validation=validateResult(order);order.validation=validation;
  await set(env,"waybill:"+order.id,order);await set(env,"route:"+routeId+":orders:latest",order);if(order.date===todayCN())await set(env,"route:"+routeId+":orders:today",order);
  return json({success:true,waybill:order,pipeline:order.pipeline,summary:order.summary});
  }catch(e){
    const code=String(e?.code||"").trim()||"PROCESS_INTERNAL_ERROR";
    const message=String(e?.message||"处理失败").slice(0,240);
    return json({success:false,code,message},500);
  }
}