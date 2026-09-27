import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,newId} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
import {TEMP_DISPATCH_ID} from "../dispatch.js";
import {recognizeImage} from "./ocr.js";
import {findGlobalMatches} from "../_global-learning.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const normalized=v=>clean(v).replace(/[\u3000\s]+/g,"").replace(/[（）()【】\[\]{}<>《》“”"'‘’]/g,"").replace(/[·•、,，。；;:：!！?？\-_—]/g,"").replace(/Ⅱl|Il|II|ⅱ/gi,"II").toLowerCase();
const number=v=>{const n=Number(v);return Number.isFinite(n)?n:null};

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
    const parts=clean(text).split(/\s*(?:->|→|＞)\s*/).map(cleanStoreName).filter(Boolean);
    for(const part of parts){
      const idm=part.match(/\b(?:JM|A|Q)[-_ ]?\d{3,12}\b/i);
      const storeId=idm?idm[0].replace(/[ -]/g,"").toUpperCase():null;
      const name=cleanStoreName(part.replace(/\b(?:JM|A|Q)[-_ ]?\d{3,12}\b/i,""));
      if(name.length>=2&&/[\u4e00-\u9fa5A-Za-z]/.test(name))stores.push({rawName:name,sourceLine:text,storeId});
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

function standardizeStore(item){
  const rawName=clean(item.rawName||item.name);
  return {...item,rawName,name:clean(item.name||rawName),standardizedName:normalized(rawName),sourceLine:clean(item.sourceLine)};
}
function validateResult(order){
  const errors=[];
  if(!order.date)errors.push("缺少运单日期");
  if(!order.vehicle)errors.push("缺少车辆信息");
  if(!Array.isArray(order.stores)||!order.stores.length)errors.push("没有规划门店");
  const seen=new Set();for(const s of order.stores||[]){const k=s.storeId?"id:"+s.storeId:"pending:"+normalized(s.rawName);if(seen.has(k))errors.push("规划结果存在重复门店");seen.add(k)}
  if((order.stores||[]).some((s,i)=>s.routeOrder!==i+1))errors.push("线路顺序不连续");
  return {valid:errors.length===0,errors};
}
function similarity(a,b){
  const x=normalized(a),y=normalized(b);if(!x||!y)return 0;if(x===y)return 1;if(x.includes(y)||y.includes(x))return Math.min(x.length,y.length)/Math.max(x.length,y.length);
  const sx=new Set([...x]),sy=new Set([...y]);let common=0;for(const c of sx)if(sy.has(c))common++;return common/(new Set([...sx,...sy]).size||1);
}
async function base(env,id){const raw=await get(env,"route:"+id+":base");if(!raw)return[];try{const x=typeof raw==="string"?JSON.parse(raw):raw;return Array.isArray(x.stores)?x.stores:[]}catch{return[]}}
function match(items,baseStores){
  const exact=new Map(),byId=new Map();
  for(const s of baseStores){if(clean(s.storeId))byId.set(clean(s.storeId),s);for(const k of [s.name,s.originalName,...(Array.isArray(s.aliases)?s.aliases:[])].map(normalized).filter(Boolean)){if(!exact.has(k))exact.set(k,s);else if(exact.get(k)?.storeId!==s.storeId)exact.set(k,null)}}
  return items.map((x,i)=>{const rawName=clean(x.rawName||x.name);let target=(x.storeId&&byId.get(clean(x.storeId)))||exact.get(normalized(rawName))||null,method=target?(x.storeId&&byId.get(clean(x.storeId))?"identity":"exact"):null;
    if(!target){let best=null,bs=0,second=0;for(const s of baseStores){const sc=Math.max(similarity(rawName,s.name),similarity(rawName,s.originalName));if(sc>bs){second=bs;bs=sc;best=s}else if(sc>second)second=sc}if(best&&bs>=.86&&bs-second>=.08){target=best;method="similarity"}}
    if(!target)return{...x,rawName,name:rawName,storeId:null,routeOrder:100000+i,matchStatus:"pending",matchMethod:null,correction:false,pending:true};
    const standard=clean(target.name)||rawName;return{...x,rawName,storeId:clean(target.storeId),name:standard,originalName:clean(target.originalName)||rawName,routeOrder:number(target.routeOrder)||i+1,matchStatus:"matched",matchMethod:method,correction:normalized(rawName)!==normalized(standard),pending:false};
  });
}
function dedupe(items){const seen=new Set(),out=[];let merged=0;for(const s of items){const key=s.storeId?"id:"+s.storeId:"pending:"+normalized(s.rawName);if(seen.has(key)){merged++;continue}seen.add(key);out.push(s)}return{items:out,merged}}
function plan(items,useRouteOrder=true){const list=useRouteOrder?[...items].sort((a,b)=>(number(a.routeOrder)??100000)-(number(b.routeOrder)??100000)||normalized(a.name).localeCompare(normalized(b.name),"zh-CN")):[...items];return list.map((s,i)=>({...s,routeOrder:i+1}))}

export async function onRequestPost({request,env}){
  const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权处理运单"},403);
  let form;try{form=await request.formData()}catch{return json({success:false,error:"运单提交格式错误"},400)}
  const routeId=clean(form.get("routeId")||user.dispatchRouteId||user.boundRouteId);if(!routeId)return json({success:false,error:"请先选择调度线路"},400);
  const rawText=clean(form.get("rawText")),file=form.get("file");if(!rawText&&!(file instanceof File))return json({success:false,error:"请选择运单"},400);
  const started=Date.now();let ocr=null,recognizedText=rawText,ocrMs=0;
  if(!recognizedText){const ocrStarted=Date.now();try{ocr=await recognizeImage(env,file);recognizedText=ocr.rawText;ocrMs=Date.now()-ocrStarted}catch(e){return json({success:false,code:e.code||"OCR_FAILED",message:e.message||"OCR识别失败",jobId:e.jobId||null},e.code==="OCR_NOT_CONFIGURED"?503:422)}}
  const recognizedMs=Date.now()-started;const baseStarted=Date.now();const baseStores=routeId===TEMP_DISPATCH_ID?[]:await base(env,routeId);const baseMs=Date.now()-baseStarted;
  const extractedStarted=Date.now();const extracted=extract(recognizedText);const extractMs=Date.now()-extractedStarted;if(!extracted.stores.length)return json({success:false,code:"EXTRACT_EMPTY",message:"未提取到门店，请检查运单内容"},422);
  const standardized=extracted.stores.map(standardizeStore);const matchStarted=Date.now();const locallyMatched=match(standardized,baseStores);const globalCandidates=await findGlobalMatches(env,locallyMatched.filter(x=>x.pending));const globalMap=new Map(globalCandidates.map(x=>[x.rawName+"|"+(x.sourceLine||""),x]));const matched=locallyMatched.map(x=>{if(!x.pending)return x;const g=globalMap.get(x.rawName+"|"+(x.sourceLine||""));if(!g||g.globalMatchStatus!=="matched")return x;const standard=clean(g.name)||x.rawName;return {...x,...g,name:standard,correction:normalized(x.rawName)!==normalized(standard),pending:false,matchStatus:"matched",matchMethod:g.globalMatchMethod,routeOrder:100000};});const matchMs=Date.now()-matchStarted;const dedupeStarted=Date.now();const d=dedupe(matched);const dedupeMs=Date.now()-dedupeStarted;const planStarted=Date.now();const useRouteOrder=routeId!==TEMP_DISPATCH_ID&&baseStores.length>0;const planned=plan(d.items,useRouteOrder);const planMs=Date.now()-planStarted;const pending=planned.filter(x=>x.pending);
  const order={schemaVersion:"2",id:newId(),routeId,date:clean(form.get("date"))||extracted.date||null,vehicle:clean(form.get("vehicle"))||extracted.vehicle||null,totalWeight:number(form.get("totalWeight"))??extracted.totalWeight,stores:planned,rawText:recognizedText,stage:"PLANNED",pipeline:["RECOGNIZED","EXTRACTED","STANDARDIZED","MATCHED","DEDUPED","PLANNED","VALIDATED"],summary:{original:extracted.stores.length,total:planned.length,matched:planned.length-pending.length,pending:pending.length,correction:planned.filter(x=>x.correction).length,merged:d.merged,newStores:0},timing:{recognizedMs,ocrMs,baseMs,extractMs,matchMs,dedupeMs,planMs,totalMs:Date.now()-started},ocr:ocr?{provider:"PaddleOCR",model:ocr.model,jobId:ocr.jobId,lineCount:ocr.lineCount}:null,createdBy:user.id,createdAt:new Date().toISOString()};
  const validation=validateResult(order);order.validation=validation;
  await set(env,"waybill:"+order.id,order);await set(env,"route:"+routeId+":orders:latest",order);if(order.date===todayCN())await set(env,"route:"+routeId+":orders:today",order);
  return json({success:true,waybill:order,pipeline:order.pipeline,summary:order.summary});
}
