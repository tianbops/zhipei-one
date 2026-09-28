import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,newId,command} from "../_redis.js";
import {canMaintainRoute,requireBusinessUser} from "../_permissions.js";
import {TEMP_DISPATCH_ID} from "../dispatch.js";
import {findGlobalMatches,learnGlobal} from "../_global-learning.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const normalized=v=>clean(v).replace(/[\u3000\s]+/g,"").replace(/[（）()【】\[\]{}<>《》“”"'‘’]/g,"").replace(/[·•、,，。；;:：!！?？\-_—]/g,"").replace(/Ⅱl|Il|II|ⅱ/gi,"II").toLowerCase();

async function load(env,id){const raw=await get(env,"waybill:"+id);if(!raw)return null;try{return typeof raw==="string"?JSON.parse(raw):raw}catch{return null}}
async function loadBase(env,id){const raw=await get(env,"route:"+id+":base");if(!raw)return {routeId:id,version:1,stores:[]};try{const x=typeof raw==="string"?JSON.parse(raw):raw;return {...x,routeId:id,stores:Array.isArray(x.stores)?x.stores:[]}}catch{return{routeId:id,version:1,stores:[]}}}

export async function onRequestPost({request,env}){
 let requestLock=null,waybillLock=null,routeBaseLock=null;
 try{
  const gate=await requireBusinessUser(request,env);if(gate.response)return gate.response;
  const user=gate.user;const input=await body(request);const waybillId=clean(input.waybillId);if(!waybillId)return json({success:false,code:"WAYBILL_ID_REQUIRED",error:"缺少运单ID"},400);
  const order=await load(env,waybillId);if(!order)return json({success:false,code:"WAYBILL_NOT_FOUND",error:"运单不存在"},404);
  if(order.routeId!==TEMP_DISPATCH_ID&&!canMaintainRoute(user,order.routeId))return json({success:false,code:"BASE_MAINTENANCE_FORBIDDEN",error:"无权确认并维护该线路数据资料"},403);
  if(order.stage==="CONFIRMED")return json({success:true,waybill:order,learning:"ALREADY_CONFIRMED"});
  if(!Array.isArray(input.confirmations))return json({success:false,code:"CONFIRMATIONS_REQUIRED",error:"确认项目必须是数组"},400);

  const confirmations=input.confirmations;
  const pendingIndexes=new Set((order.stores||[]).map((s,i)=>s?.pending?i:null).filter(i=>i!==null));
  const submittedIndexes=new Set();
  for(const c of confirmations){
    const index=Number(c?.index);if(!Number.isInteger(index)||!pendingIndexes.has(index))continue;
    if(submittedIndexes.has(index))return json({success:false,code:"CONFIRMATION_DUPLICATE_INDEX",error:"同一待定门店不能重复确认"},400);
    const action=clean(c?.action);if(action!=="merge"&&action!=="new")return json({success:false,code:"CONFIRMATION_ACTION_INVALID",error:"待定门店必须选择合并或新增"},400);
    submittedIndexes.add(index);
  }
  if(submittedIndexes.size!==pendingIndexes.size)return json({success:false,code:"CONFIRMATIONS_INCOMPLETE",error:"请完成全部待定门店选择"},400);
  const confirmRequestId=clean(input.confirmRequestId);if(!confirmRequestId)return json({success:false,code:"CONFIRM_REQUEST_ID_REQUIRED",error:"缺少确认请求ID"},400);
  const doneKey="waybill:"+waybillId+":confirm:"+confirmRequestId;const existing=await get(env,doneKey);if(existing)return json({success:true,waybill:order,learning:"DUPLICATE_REQUEST"});requestLock=doneKey+":lock";const locked=await command(env,["SET",requestLock,"1","NX","EX","60"]);if(locked!=="OK"){requestLock=null;return json({success:false,code:"CONFIRM_REQUEST_BUSY",error:"确认请求正在处理中，请稍后再试"},409)}
  waybillLock="waybill:"+waybillId+":confirm-lock";const waybillLocked=await command(env,["SET",waybillLock,"1","NX","EX","60"]);if(waybillLocked!=="OK"){await command(env,["DEL",requestLock]);requestLock=null;waybillLock=null;return json({success:false,code:"CONFIRM_REQUEST_BUSY",error:"该运单正在确认处理中，请稍后再试"},409)}
  if(order.routeId!==TEMP_DISPATCH_ID){routeBaseLock="route:"+order.routeId+":base-confirm-lock";const baseLocked=await command(env,["SET",routeBaseLock,"1","NX","EX","120"]);if(baseLocked!=="OK"){await command(env,["DEL",waybillLock]);waybillLock=null;await command(env,["DEL",requestLock]);requestLock=null;routeBaseLock=null;return json({success:false,code:"BASE_UPDATE_BUSY",error:"该线路数据资料正在被其他确认操作更新，请稍后重试"},409)}}
  const stores=[...(order.stores||[])];
  const base=order.routeId===TEMP_DISPATCH_ID?{routeId:order.routeId,version:1,stores:[]}:await loadBase(env,order.routeId);
  const learned=[];
  for(const c of confirmations){
    const index=Number(c.index);if(!Number.isInteger(index)||index<0||index>=stores.length)continue;
    const item=stores[index];if(!item.pending&&!clean(c.storeId))continue;
    const rawName=clean(item.rawName||item.name);let target=null;
    const requestedId=clean(c.storeId);
    const action=clean(c.action)||"merge";
    if(action!=="merge"&&action!=="new")continue;
    if(action==="merge"&&requestedId)target=base.stores.find(s=>clean(s.storeId)===requestedId)||null;
    if(action==="merge"&&!target)target=base.stores.find(s=>normalized(s.name)===normalized(c.standardName||"")||normalized(s.originalName)===normalized(c.standardName||""))||null;
    if(action==="merge"&&!target){
      await command(env,["DEL",waybillLock]);waybillLock=null;
      await command(env,["DEL",requestLock]);requestLock=null;
      return json({success:false,code:"MERGE_TARGET_NOT_FOUND",error:"指定的已有门店不存在于当前线路资料，请重新选择“合并”或“新增”"},409);
    }
    const standardName=clean(c.standardName)||clean(target?.name)||rawName;
    if(action==="new"&&order.routeId!==TEMP_DISPATCH_ID){
      const duplicate=base.stores.find(s=>normalized(s.name)===normalized(rawName)||normalized(s.originalName)===normalized(rawName)||(Array.isArray(s.aliases)&&s.aliases.some(a=>normalized(a)===normalized(rawName))));
      if(duplicate){
        await command(env,["DEL",waybillLock]);waybillLock=null;
        await command(env,["DEL",requestLock]);requestLock=null;
        return json({success:false,code:"STORE_ALREADY_EXISTS",error:"该门店已存在于线路数据资料，不能重复新增",storeId:clean(duplicate.storeId),storeName:clean(duplicate.name||duplicate.originalName)},409);
      }
      target={storeId:newId(),originalName:rawName,name:rawName,aliases:[],navigation:null,routeOrder:base.stores.length+1,note:""};
      base.stores.push(target);
    }
    if(!target&&order.routeId!==TEMP_DISPATCH_ID){
      const globals=await findGlobalMatches(env,[{rawName:standardName}]);
      const globalTarget=globals[0]?.globalMatchStatus==="matched"?globals[0]:null;
      if(globalTarget){
        target=base.stores.find(s=>clean(s.storeId)===clean(globalTarget.storeId))||null;
        if(!target){
          target={storeId:clean(globalTarget.storeId),originalName:clean(globalTarget.originalName)||rawName,name:clean(globalTarget.name)||standardName,aliases:Array.isArray(globalTarget.aliases)?globalTarget.aliases:[],navigation:globalTarget.navigation||null,routeOrder:base.stores.length+1,note:""};
          base.stores.push(target);
        }

      }else{
        target={storeId:newId(),originalName:rawName,name:standardName,aliases:[],navigation:null,routeOrder:base.stores.length+1,note:""};
        base.stores.push(target);
      }
    }
    const storeId=clean(target?.storeId)||requestedId||newId();
    if(target){
      if(target){
 const aliases=Array.isArray(target.aliases)?target.aliases:[];
 if(rawName&&normalized(rawName)!==normalized(target.name)&&!aliases.includes(rawName))target.aliases=[...aliases,rawName];
}
    }
    item.storeId=storeId;item.name=action==="new"?rawName:standardName;item.routeOrder=Number(target?.routeOrder)||item.routeOrder;item.originalName=clean(target?.originalName)||rawName;item.pending=false;item.matchStatus="matched";item.matchMethod=action==="new"?"confirmed-new":(target?"confirmed":"confirmed-global");item.correction=action==="new"?false:normalized(rawName)!==normalized(standardName);
    learned.push({storeId,rawName,standardName:item.name,originalName:item.originalName,navigation:target?.navigation||null});
  }

  const seen=new Set();const deduped=[];let merged=0;
  for(const item of stores){const key=item.storeId?"id:"+item.storeId:"pending:"+normalized(item.rawName);if(seen.has(key)){merged++;continue}seen.add(key);deduped.push(item)}
  let ordered=deduped;
  if(order.routeId!==TEMP_DISPATCH_ID&&base.stores.length){
    const routeOrderById=new Map(base.stores.filter(s=>s&&s.storeId).map(s=>[clean(s.storeId),Number(s.routeOrder)]));
    const known=deduped.filter(s=>s.storeId&&Number.isFinite(routeOrderById.get(clean(s.storeId))));
    const unknown=deduped.filter(s=>!known.includes(s));
    known.forEach(s=>{s.routeOrder=routeOrderById.get(clean(s.storeId))});
    ordered=[...known.sort((a,b)=>a.routeOrder-b.routeOrder),...unknown];
  }
  const finalStores=ordered.map((s,i)=>({...s,routeOrder:i+1}));
  const pending=finalStores.filter(s=>s.pending).length;
  order.stores=finalStores;order.stage=pending?"PLANNED":"CONFIRMED";order.summary={...(order.summary||{}),total:finalStores.length,matched:finalStores.length-pending,pending,correction:finalStores.filter(s=>s.correction).length,merged:(order.summary?.merged||0)+merged,newStores:finalStores.filter(s=>s.matchMethod==="confirmed-new").length};
  const confirmedNow=new Date().toISOString();if(pending===0){order.confirmedAt=confirmedNow;order.confirmedBy=user.id;}else{order.lastConfirmedAt=confirmedNow;order.lastConfirmedBy=user.id;}order.confirmRequestId=confirmRequestId||null;
  if(learned.length&&order.routeId!==TEMP_DISPATCH_ID){base.version=(Number(base.version)||1)+1;base.updatedAt=new Date().toISOString();base.updatedBy=user.id;await set(env,"route:"+order.routeId+":base",base)}
  await set(env,"waybill:"+order.id,order);await set(env,doneKey,"1");
  let learningStatus=learned.length?"RECORDED":"NONE";
  if(learned.length){try{for(const item of learned)await learnGlobal(env,{...item,routeId:order.routeId,waybillId:order.id,userId:user.id})}catch(e){learningStatus="DEFERRED";}}
  let indexSync="OK";
  try{
    if(order.date===todayCN())await set(env,"route:"+order.routeId+":orders:today",order);
    await set(env,"route:"+order.routeId+":orders:latest",order);
  }catch{indexSync="DEFERRED";try{await set(env,"route:"+order.routeId+":orders:index-repair",order.id)}catch{}}
  if(routeBaseLock){await command(env,["DEL",routeBaseLock]);routeBaseLock=null}
  await command(env,["DEL",waybillLock]);waybillLock=null;
  await command(env,["DEL",requestLock]);requestLock=null;
  return json({success:true,waybill:order,learning:learningStatus,indexSync});
 }catch(e){
  try{if(routeBaseLock)await command(env,["DEL",routeBaseLock]);if(waybillLock)await command(env,["DEL",waybillLock]);if(requestLock)await command(env,["DEL",requestLock]);}catch{}
  return json({success:false,code:e?.code||"CONFIRM_INTERNAL_ERROR",error:e?.message||"确认待定门店失败"},500);
 }
}