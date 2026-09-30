import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,newId,command} from "../_redis.js";
import {canMaintainRoute,requireBusinessUser} from "../_permissions.js";
import {TEMP_DISPATCH_ID} from "../dispatch.js";
import {findGlobalMatches,learnGlobal} from "../_global-learning.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const normalized=v=>clean(v).replace(/[\u3000\s]+/g,"").replace(/[（）()【】\[\]{}<>《》“”"'‘’]/g,"").replace(/[·•、,，。；;:：!！?？\-_—]/g,"").replace(/Ⅱl|Il|II|ⅱ/gi,"II").toLowerCase();

async function releaseLock(env,lock){if(!lock?.key||!lock?.token)return;await command(env,["EVAL","if redis.call(\"GET\",KEYS[1])==ARGV[1] then return redis.call(\"DEL\",KEYS[1]) else return 0 end","1","zp:"+lock.key,lock.token]).catch(()=>{})}
async function load(env,id){const raw=await get(env,"waybill:"+id);if(!raw)return null;try{return typeof raw==="string"?JSON.parse(raw):raw}catch{return null}}
async function writeIndexIfNewer(env,key,waybill){const script=`local incoming=cjson.decode(ARGV[1]);local raw=redis.call("GET",KEYS[1]);if raw then local ok,current=pcall(cjson.decode,raw);if ok and type(current)=="table" and current.routeId==incoming.routeId and current.createdAt and incoming.createdAt and tostring(current.createdAt)>=tostring(incoming.createdAt) then return 0 end end;redis.call("SET",KEYS[1],ARGV[1]);return 1`;return command(env,["EVAL",script,"1","zp:"+key,JSON.stringify(waybill)])}
async function loadBase(env,id){const raw=await get(env,"route:"+id+":base");if(!raw)throw Object.assign(new Error("线路数据资料尚未建立"),{code:"BASE_NOT_FOUND"});let x;try{x=typeof raw==="string"?JSON.parse(raw):raw}catch{throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"})}if(!x||!Array.isArray(x.stores))throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"});return {...x,routeId:id}}
async function queueLearningRepairs(env,waybillId,items){
 if(!waybillId||!items.length)return;
 const key="zp:waybill:"+waybillId+":learning-repair";
 for(const item of items){
  const field=[clean(item.storeId),normalized(item.rawName||item.name)].join("|");
  if(!field)continue;
  await command(env,["HSET",key,field,JSON.stringify(item)]);
 }
}
async function retryLearningRepairs(env,waybillId,userId){
 const key="waybill:"+waybillId+":learning-repair";
 const lock={key:key+":lock",token:newId()};
 const locked=await command(env,["SET","zp:"+lock.key,lock.token,"NX","EX","60"]);
 if(locked!=="OK")return"DEFERRED";
 try{
  const raw=await command(env,["HGETALL","zp:"+key]);
  const entries=[];const invalidKey="zp:"+key+":invalid";
  for(let i=0;i<(raw?.length||0);i+=2){const field=raw[i],value=raw[i+1];if(!field||!value)continue;let item=null;try{item=typeof value==="string"?JSON.parse(value):value}catch{}if(!item||typeof item.storeId!=="string"||!item.storeId||typeof item.rawName!=="string"||!item.rawName||typeof item.standardName!=="string"||!item.standardName){await command(env,["HSET",invalidKey,field,JSON.stringify({status:"INVALID",field,raw:value,markedAt:new Date().toISOString()})]);await command(env,["HDEL",key,field]);continue}entries.push([field,item])}
  for(const [field,item] of entries){
   try{await learnGlobal(env,{...item,routeId:item.routeId,waybillId,userId:item.userId||userId});await command(env,["HDEL","zp:"+key,field])}catch{}
  }
  const remaining=Number(await command(env,["HLEN","zp:"+key]))||0;
  if(remaining===0)await command(env,["DEL","zp:"+key]);
  return remaining?"DEFERRED":"RECORDED";
 }finally{await releaseLock(env,lock)}
}

export async function onRequestPost({request,env}){
 let requestLock=null,waybillLock=null,routeBaseLock=null,order=null;
 try{
  const gate=await requireBusinessUser(request,env);if(gate.response)return gate.response;
  const user=gate.user;const input=await body(request);const waybillId=clean(input.waybillId);if(!waybillId)return json({success:false,code:"WAYBILL_ID_REQUIRED",error:"缺少运单ID"},400);
  order=await load(env,waybillId);if(!order)return json({success:false,code:"WAYBILL_NOT_FOUND",error:"运单不存在"},404);
  if(order.routeId!==TEMP_DISPATCH_ID&&!canMaintainRoute(user,order.routeId))return json({success:false,code:"BASE_MAINTENANCE_FORBIDDEN",error:"无权确认并维护该线路数据资料"},403);
  if(order.stage==="CONFIRMED"){const learning=await retryLearningRepairs(env,waybillId,user.id);return json({success:true,waybill:order,learning:learning==="RECORDED"?"ALREADY_CONFIRMED":"DEFERRED"});}
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
  const doneKey="waybill:"+waybillId+":confirm:"+confirmRequestId;const existing=await get(env,doneKey);if(existing){const committed=await load(env,waybillId);if(!committed)return json({success:false,code:"WAYBILL_NOT_FOUND",error:"运单不存在"},404);return json({success:true,waybill:committed,learning:"DUPLICATE_REQUEST"});}requestLock={key:doneKey+":lock",token:newId()};const locked=await command(env,["SET","zp:"+requestLock.key,requestLock.token,"NX","EX","60"]);if(locked!=="OK"){requestLock=null;return json({success:false,code:"CONFIRM_REQUEST_BUSY",error:"确认请求正在处理中，请稍后再试"},409)}
  waybillLock={key:"waybill:"+waybillId+":confirm-lock",token:newId()};const waybillLocked=await command(env,["SET","zp:"+waybillLock.key,waybillLock.token,"NX","EX","60"]);if(waybillLocked!=="OK"){await releaseLock(env,requestLock);requestLock=null;waybillLock=null;return json({success:false,code:"CONFIRM_REQUEST_BUSY",error:"该运单正在确认处理中，请稍后再试"},409)}
  const freshOrder=await load(env,waybillId);if(!freshOrder)throw Object.assign(new Error("运单不存在"),{code:"WAYBILL_NOT_FOUND"});if(freshOrder.routeId!==order.routeId)throw Object.assign(new Error("运单线路发生变化"),{code:"WAYBILL_ROUTE_CHANGED"});order=freshOrder;if(order.stage==="CONFIRMED"){const learning=await retryLearningRepairs(env,waybillId,user.id);await releaseLock(env,waybillLock);waybillLock=null;await releaseLock(env,requestLock);requestLock=null;return json({success:true,waybill:order,learning:learning==="RECORDED"?"ALREADY_CONFIRMED":"DEFERRED"});}
  if(order.routeId!==TEMP_DISPATCH_ID){routeBaseLock={key:"route:"+order.routeId+":base-confirm-lock",token:newId()};const baseLocked=await command(env,["SET","zp:"+routeBaseLock.key,routeBaseLock.token,"NX","EX","120"]);if(baseLocked!=="OK"){await releaseLock(env,waybillLock);waybillLock=null;await releaseLock(env,requestLock);requestLock=null;routeBaseLock=null;return json({success:false,code:"BASE_UPDATE_BUSY",error:"该线路数据资料正在被其他确认操作更新，请稍后重试"},409)}}
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
      await releaseLock(env,waybillLock);waybillLock=null;
      await releaseLock(env,requestLock);requestLock=null;
      return json({success:false,code:"MERGE_TARGET_NOT_FOUND",error:"指定的已有门店不存在于当前线路资料，请重新选择“合并”或“新增”"},409);
    }
    const standardName=action==="merge"?clean(target?.name)||rawName:(clean(c.standardName)||rawName);
    if(action==="new"&&order.routeId!==TEMP_DISPATCH_ID){
      const duplicate=base.stores.find(s=>normalized(s.name)===normalized(rawName)||normalized(s.originalName)===normalized(rawName)||(Array.isArray(s.aliases)&&s.aliases.some(a=>normalized(a)===normalized(rawName))));
      if(duplicate){
        await releaseLock(env,waybillLock);waybillLock=null;
        await releaseLock(env,requestLock);requestLock=null;
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
    item.storeId=storeId;item.name=action==="new"?rawName:(clean(target?.name)||standardName);item.routeOrder=Number(target?.routeOrder)||item.routeOrder;item.originalName=clean(target?.originalName)||rawName;item.pending=false;item.matchStatus="matched";item.matchMethod=action==="new"?"confirmed-new":(target?"confirmed":"confirmed-global");item.correction=action==="new"?false:normalized(rawName)!==normalized(standardName);
    learned.push({storeId,rawName,standardName:clean(target?.name)||item.name,originalName:item.originalName,navigation:target?.navigation||null,routeId:order.routeId,learningEventId:newId()});
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
  if(learned.length&&order.routeId!==TEMP_DISPATCH_ID){base.version=(Number(base.version)||1)+1;base.updatedAt=new Date().toISOString();base.updatedBy=user.id}
  const learningEntries=learned.map(item=>({field:[clean(item.storeId),normalized(item.rawName||item.name)].join("|"),value:JSON.stringify(item)})).filter(x=>x.field);
  const basePayload=(learned.length&&order.routeId!==TEMP_DISPATCH_ID)?JSON.stringify(base):"";
  const historyKey=(order.routeId!==TEMP_DISPATCH_ID&&order.stage==="CONFIRMED"&&/^\\d{4}-\\d{2}-\\d{2}$/.test(clean(order.date)))?"zp:route:"+order.routeId+":history:"+clean(order.date):"";
  const commitScript='local okOrder,order=pcall(cjson.decode,ARGV[1]); if not okOrder or type(order)~="table" then return 2 end; local rawDone=redis.call("GET",KEYS[2]); if rawDone then return 3 end; local okItems,items=pcall(cjson.decode,ARGV[2]); if not okItems or type(items)~="table" then return 4 end; for _,item in ipairs(items) do if type(item)~="table" or type(item.field)~="string" or item.field=="" or type(item.value)~="string" or item.value=="" then return 6 end end; if ARGV[3]~="" then local okBase,base=pcall(cjson.decode,ARGV[3]); if not okBase or type(base)~="table" then return 5 end end; if ARGV[3]~="" then redis.call("SET",KEYS[4],ARGV[3]) end; redis.call("SET",KEYS[1],ARGV[1]); redis.call("SET",KEYS[2],"1"); for _,item in ipairs(items) do redis.call("HSET",KEYS[3],item.field,item.value) end; if ARGV[4]~="" then redis.call("SET",ARGV[4],order.id) end; return 1';
  const commitResult=await command(env,["EVAL",commitScript,"4","zp:waybill:"+order.id,"zp:"+doneKey,"zp:waybill:"+order.id+":learning-repair","zp:route:"+order.routeId+":base",JSON.stringify(order),JSON.stringify(learningEntries),basePayload,historyKey]);
  if(Number(commitResult)===3){const committed=await load(env,waybillId);if(!committed)throw Object.assign(new Error("运单不存在"),{code:"WAYBILL_NOT_FOUND"});order=committed;let learning=await retryLearningRepairs(env,waybillId,user.id);if(routeBaseLock){await releaseLock(env,routeBaseLock);routeBaseLock=null}await releaseLock(env,waybillLock);waybillLock=null;await releaseLock(env,requestLock);requestLock=null;return json({success:true,waybill:order,learning:learning==="RECORDED"?"ALREADY_CONFIRMED":"DEFERRED"});}if(Number(commitResult)!==1)throw new Error("WAYBILL_COMMIT_FAILED");
  let learningStatus=learned.length?await retryLearningRepairs(env,order.id,user.id):"NONE";
  let indexSync="OK";
  try{
    if(order.date===todayCN())await writeIndexIfNewer(env,"route:"+order.routeId+":orders:today",order);
    await writeIndexIfNewer(env,"route:"+order.routeId+":orders:latest",order);
  }catch{indexSync="DEFERRED";try{await command(env,["SADD","zp:route:"+order.routeId+":orders:index-repair",order.id])}catch{}}
  if(routeBaseLock){await releaseLock(env,routeBaseLock);routeBaseLock=null}
  await releaseLock(env,waybillLock);waybillLock=null;
  await releaseLock(env,requestLock);requestLock=null;
  return json({success:true,waybill:order,learning:learningStatus,indexSync});
 }catch(e){
  try{if(routeBaseLock)await releaseLock(env,routeBaseLock);if(waybillLock)await releaseLock(env,waybillLock);if(requestLock)await releaseLock(env,requestLock);}catch{}
  return json({success:false,code:e?.code||"CONFIRM_INTERNAL_ERROR",error:e?.message||"确认待定门店失败"},500);
 }
}