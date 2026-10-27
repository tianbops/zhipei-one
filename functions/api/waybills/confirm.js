import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,newId,command} from "../_redis.js";
import {canMaintainRoute,requireBusinessUser} from "../_permissions.js";
import {isTempRoute,TEMP_ROUTE_PREFIX} from "../dispatch.js";
import {findGlobalMatches,learnGlobal} from "../_global-learning.js";
import {businessFingerprint,dailyWaybillKey} from "../_waybill-identity.js";
import {recomputeDayMeta} from "./_waybill-meta.js";
import {appendWaybillEvent} from "./_waybill-events.js";
import {degraded} from "../_degrade.js";

const clean=v=>String(v??"").trim();
const normalized=v=>clean(v).replace(/[\u3000\s]+/g,"").replace(/[（）()【】\[\]{}<>《》“”"'‘’]/g,"").replace(/[·•、,，。；;:：!！?？\-_—]/g,"").replace(/Ⅱl|Il|II|ⅱ/gi,"II").toLowerCase();
// 运单确认权限：正式线路要求维护权限；临时线路要求“必须是本人独立的临时空间”，
// 杜绝跨临时用户确认（每个临时用户 routeId=__temp__:<userId>，互不相同）。
function canConfirmWaybill(user,order){
 if(isTempRoute(order.routeId))return order.routeId===TEMP_ROUTE_PREFIX+user.id;
 // 绑定二人共同维护；带班人员（未绑定、临时调度到该线路）可确认自己上传的运单，
 // 否则带班上传后出现待定门店将无人能确认，流程卡死。
 return canMaintainRoute(user,order.routeId)||(!!order.createdBy&&order.createdBy===user.id);
}
/**
 * 指纹漂移回收（2026-10-07 生产实测发现）。
 * businessFingerprint 的入参包含每个门店的 pending / routeOrder / storeId，
 * 确认会把待定门店补齐（pending true→false、补 storeId），于是**指纹必然变化**；
 * commitScript 会写下新指纹键，但旧指纹键仍指向本单且再无人回收。
 * 后果：日后删除该运单时，history.js 只清理 record.businessFingerprint（当前那一个），
 * 旧键就成了「悬空指纹键」——线上巡检实测 8 条，且会持续累积，
 * 把巡检报告长期污染成噪声（真问题反而被淹没）。
 *
 * 安全边界：仅当旧键当前**仍指向本单**才删除；若已被再上传/覆盖链改派给别的运单，绝不动，
 * 以免破坏 process.js 的幂等去重链（与 history.js 删除清理的保护策略一致）。
 */
async function retireStaleFingerprintKey(env, { prevFingerprint, nextFingerprint, ownerId }) {
  const prev = clean(prevFingerprint), next = clean(nextFingerprint);
  if (!prev || prev === next) return false; // 未漂移时不动作（该键正被本次提交复用）
  const key = "zp:waybill:fingerprint:" + prev;
  try {
    const ref = await command(env, ["GET", key]);
    if (String(ref ?? "") !== String(ownerId || "")) return false; // 已改派他人，保护幂等链
    await command(env, ["DEL", key]);
    return true;
  } catch { return false; } // 清理失败不影响确认主流程
}

async function loadBase(env,id){const raw=await get(env,"route:"+id+":base");if(!raw)throw Object.assign(new Error("线路数据资料尚未建立"),{code:"BASE_NOT_FOUND"});let x;try{x=typeof raw==="string"?JSON.parse(raw):raw}catch{throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"})}if(!x||!Array.isArray(x.stores))throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"});return {...x,routeId:id}}
// 读取运单主记录（zp:waybill:<id>）。此前 confirm.js 引用了未定义的 load，导致确认链路运行时报错，
// 此处补全与 base.js/learning.js 同构的本地实现。
async function load(env,waybillId){const raw=await get(env,"waybill:"+waybillId);if(!raw)return null;try{return typeof raw==="string"?JSON.parse(raw):raw}catch{return null}}
async function retryLearningRepairs(env,waybillId,userId){
 const key="waybill:"+waybillId+":learning-repair";
 const MAX_REPAIRS=3;
 const lock={key:key+":lock",token:newId()};
 const locked=await command(env,["SET","zp:"+lock.key,lock.token,"NX","EX","60"]);
 if(locked!=="OK")return"DEFERRED";
 try{
  const raw=await command(env,["HGETALL","zp:"+key]);
  const entries=[];const invalidKey="zp:"+key+":invalid";
  for(let i=0;i<(raw?.length||0);i+=2){const field=raw[i],value=raw[i+1];if(!field||!value)continue;let item=null;try{item=typeof value==="string"?JSON.parse(value):value}catch{}if(!item||typeof item.storeId!=="string"||!item.storeId||typeof item.rawName!=="string"||!item.rawName||typeof item.standardName!=="string"||!item.standardName){await command(env,["HSET",invalidKey,field,JSON.stringify({status:"INVALID",field,raw:value,markedAt:new Date().toISOString()})]);await command(env,["HDEL",key,field]);continue}entries.push([field,item])}
  let processed=0;
  for(const [field,item] of entries){
   if(processed>=MAX_REPAIRS)break;
   try{await learnGlobal(env,{...item,routeId:item.routeId,waybillId,userId:item.userId||userId});await command(env,["HDEL","zp:"+key,field]);processed++;}catch(e){degraded("learning.repair-replay-failed",e,{waybillId:clean(waybillId),field:String(field).slice(0,120)})}
  }
  const remaining=Number(await command(env,["HLEN","zp:"+key]))||0;
  if(remaining===0)await command(env,["DEL","zp:"+key]);
  return remaining?"DEFERRED":"RECORDED";
 }catch{return "DEFERRED";
 }finally{await releaseLock(env,lock)}
}
// 释放分布式锁：仅在当前令牌与持锁令牌一致时删除，避免误删他人锁。
// 此前 confirm.js 多处调用 releaseLock 却未定义，导致每次成功确认在收尾阶段抛 ReferenceError 返回 500。
export async function releaseLock(env,lock){
  if(!lock)return;
  try{const cur=await get(env,lock.key);if(cur===lock.token)await command(env,["DEL","zp:"+lock.key])}catch(e){
   // 释放失败原为静默吞掉。锁未释放会让后续请求一直阻塞到 TTL 才自动解开，
   // 期间用户只能重复"正在处理请重试"，而日志里查不到任何原因。这里只上报，不改行为。
   degraded("lock.release-failed", e, {key:String(lock?.key||"").slice(0,120)});
  }
}

export async function onRequestPost({request,env}){
 let requestLock=null,waybillLock=null,routeBaseLock=null,order=null;
 const waybillIndexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;
 try{
  const gate=await requireBusinessUser(request,env);if(gate.response)return gate.response;
  const user=gate.user;const input=await body(request);const waybillId=clean(input.waybillId);if(!waybillId)return json({success:false,code:"WAYBILL_ID_REQUIRED",error:"缺少运单ID"},400);
  order=await load(env,waybillId);if(!order)return json({success:false,code:"WAYBILL_NOT_FOUND",error:"运单不存在"},404);
  if(!canConfirmWaybill(user,order))return json({success:false,code:"BASE_MAINTENANCE_FORBIDDEN",error:"无权确认并维护该线路数据资料"},403);
  if(order.stage==="CONFIRMED"){const indexKey=/^\d{4}-\d{2}-\d{2}$/.test(clean(order.date))?waybillIndexKey(order.routeId,clean(order.date)):"";if(indexKey){await command(env,["SADD",indexKey,waybillId]);try{await recomputeDayMeta(env,order.routeId,clean(order.date))}catch(e){degraded("stats.daymeta-recompute-failed",e,{routeId:clean(order.routeId),date:clean(order.date)})}}const learning=await retryLearningRepairs(env,waybillId,user.id);return json({success:true,waybill:order,learning:learning==="RECORDED"?"ALREADY_CONFIRMED":"DEFERRED"});}
  if(!Array.isArray(input.confirmations))return json({success:false,code:"CONFIRMATIONS_REQUIRED",error:"确认项目必须是数组"},400);

  const confirmations=input.confirmations;
  const pendingIndexes=new Set((order.stores||[]).map((s,i)=>s?.pending?i:null).filter(i=>i!==null));
  const submittedIndexes=new Set();
  for(const c of confirmations){
    const index=Number(c?.index);if(!Number.isInteger(index)||!pendingIndexes.has(index))continue;
    if(submittedIndexes.has(index))return json({success:false,code:"CONFIRMATION_DUPLICATE_INDEX",error:"同一待定门店不能重复确认"},400);
    const action=clean(c?.action);if(action!=="merge"&&action!=="new"&&action!=="discard")return json({success:false,code:"CONFIRMATION_ACTION_INVALID",error:"待定门店必须选择合并、新增或丢弃"},400);
    submittedIndexes.add(index);
  }
  if(submittedIndexes.size!==pendingIndexes.size)return json({success:false,code:"CONFIRMATIONS_INCOMPLETE",error:"请完成全部待定门店选择"},400);
  const confirmRequestId=clean(input.confirmRequestId);if(!confirmRequestId)return json({success:false,code:"CONFIRM_REQUEST_ID_REQUIRED",error:"缺少确认请求ID"},400);
  const doneKey="waybill:"+waybillId+":confirm:"+confirmRequestId;const existing=await get(env,doneKey);if(existing){const committed=await load(env,waybillId);if(!committed)return json({success:false,code:"WAYBILL_NOT_FOUND",error:"运单不存在"},404);return json({success:true,waybill:committed,learning:"DUPLICATE_REQUEST"});}requestLock={key:doneKey+":lock",token:newId()};const locked=await command(env,["SET","zp:"+requestLock.key,requestLock.token,"NX","EX","60"]);if(locked!=="OK"){requestLock=null;return json({success:false,code:"CONFIRM_REQUEST_BUSY",error:"确认请求正在处理中，请稍后再试"},409)}
  waybillLock={key:"waybill:"+waybillId+":confirm-lock",token:newId()};const waybillLocked=await command(env,["SET","zp:"+waybillLock.key,waybillLock.token,"NX","EX","60"]);if(waybillLocked!=="OK"){await releaseLock(env,requestLock);requestLock=null;waybillLock=null;return json({success:false,code:"CONFIRM_REQUEST_BUSY",error:"该运单正在确认处理中，请稍后再试"},409)}
  const freshOrder=await load(env,waybillId);if(!freshOrder)throw Object.assign(new Error("运单不存在"),{code:"WAYBILL_NOT_FOUND"});if(freshOrder.routeId!==order.routeId)throw Object.assign(new Error("运单线路发生变化"),{code:"WAYBILL_ROUTE_CHANGED"});order=freshOrder;if(order.stage==="CONFIRMED"){const learning=await retryLearningRepairs(env,waybillId,user.id);await releaseLock(env,waybillLock);waybillLock=null;await releaseLock(env,requestLock);requestLock=null;return json({success:true,waybill:order,learning:learning==="RECORDED"?"ALREADY_CONFIRMED":"DEFERRED"});}
  if(!isTempRoute(order.routeId)){routeBaseLock={key:"route:"+order.routeId+":base-confirm-lock",token:newId()};const baseLocked=await command(env,["SET","zp:"+routeBaseLock.key,routeBaseLock.token,"NX","EX","120"]);if(baseLocked!=="OK"){await releaseLock(env,waybillLock);waybillLock=null;await releaseLock(env,requestLock);requestLock=null;routeBaseLock=null;return json({success:false,code:"BASE_UPDATE_BUSY",error:"该线路数据资料正在被其他确认操作更新，请稍后重试"},409)}}
  const stores=[...(order.stores||[])];
  const base=isTempRoute(order.routeId)?{routeId:order.routeId,version:1,stores:[]}:await loadBase(env,order.routeId);
  const learned=[];const discarded=new Set();
  for(const c of confirmations){
    const index=Number(c.index);if(!Number.isInteger(index)||index<0||index>=stores.length)continue;
    const item=stores[index];if(!item.pending&&!clean(c.storeId))continue;
    const rawName=clean(item.rawName||item.name);let target=null;
    const requestedId=clean(c.storeId);
    const action=clean(c.action)||"merge";
    // 丢弃：该条目不是门店（运单号表格等 OCR 噪声、或拍错的残条），确认时直接剔除，
    // 既不合并进已有门店，也不新建门店。此前只能 merge/new，遇到噪声会被迫污染数据。
    if(action==="discard"){discarded.add(index);continue;}
    if(action!=="merge"&&action!=="new")continue;
    if(action==="merge"&&requestedId)target=base.stores.find(s=>clean(s.storeId)===requestedId)||null;
    if(action==="merge"&&!target)target=base.stores.find(s=>normalized(s.name)===normalized(c.standardName||"")||normalized(s.originalName)===normalized(c.standardName||""))||null;
    if(action==="merge"&&!target){
      await releaseLock(env,waybillLock);waybillLock=null;
      await releaseLock(env,requestLock);requestLock=null;
      return json({success:false,code:"MERGE_TARGET_NOT_FOUND",error:"指定的已有门店不存在于当前线路资料，请重新选择“合并”或“新增”"},409);
    }
    const standardName=action==="merge"?clean(target?.name)||rawName:(clean(c.standardName)||rawName);
    if(action==="new"&&!isTempRoute(order.routeId)){
      const duplicate=base.stores.find(s=>normalized(s.name)===normalized(rawName)||normalized(s.originalName)===normalized(rawName)||(Array.isArray(s.aliases)&&s.aliases.some(a=>normalized(a)===normalized(rawName))));
      if(duplicate){
        await releaseLock(env,waybillLock);waybillLock=null;
        await releaseLock(env,requestLock);requestLock=null;
        return json({success:false,code:"STORE_ALREADY_EXISTS",error:"该门店已存在于线路数据资料，不能重复新增",storeId:clean(duplicate.storeId),storeName:clean(duplicate.name||duplicate.originalName)},409);
      }
      target={storeId:newId(),originalName:rawName,name:rawName,aliases:[],navigation:null,routeOrder:base.stores.length+1,note:""};
      base.stores.push(target);
    }
    if(!target&&!isTempRoute(order.routeId)){
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

  // 被丢弃的条目不参与后续去重/排序/落库（剔除发生在确认阶段，数据不留残条）
  const keptStores=discarded.size?stores.filter((_,i)=>!discarded.has(i)):stores;
  const seen=new Set();const deduped=[];let merged=0;
  for(const item of keptStores){const key=item.storeId?"id:"+item.storeId:"pending:"+normalized(item.rawName);if(seen.has(key)){merged++;continue}seen.add(key);deduped.push(item)}
  // 确认发生在“规划完成”之后：不能因为门店身份确认而重新套用基准库 routeOrder。
  // 当前数组本身就是本次规划后的实际顺序：保留已有 routeOrder；
  // 缺失顺序的新增/异常门店按其在当前运单中的原位置追加编号，绝不拿基准库顺序插队。
  let ordered=[...deduped];
  const maxExistingOrder=Math.max(0,...ordered.map(s=>Number(s.routeOrder)).filter(Number.isFinite));
  let nextOrder=maxExistingOrder;
  for(const item of ordered){
    if(!Number.isFinite(Number(item.routeOrder)))item.routeOrder=++nextOrder;
  }
  const finalStores=ordered.map((s,i)=>({...s,routeOrder:i+1}));
  const pending=finalStores.filter(s=>s.pending).length;
  // 指纹失漏回收：确认会把待定门店补齐，指纹必然漂移；旧键会在删除本单后变成悬空指纹键。
  // 必须在 order.stores 被 finalStores 覆盖**之前**记下旧指纹。参见 retireStaleFingerprintKey 注释。
  const prevFingerprint=clean(order.businessFingerprint);
  order.stores=finalStores;order.stage=pending?"PLANNED":"CONFIRMED";order.summary={...(order.summary||{}),total:finalStores.length,matched:finalStores.length-pending,pending,correction:finalStores.filter(s=>s.correction).length,merged:(order.summary?.merged||0)+merged,newStores:finalStores.filter(s=>s.matchMethod==="confirmed-new").length,discarded:(Number(order.summary?.discarded)||0)+discarded.size};
  const confirmedNow=new Date().toISOString();if(pending===0){order.confirmedAt=confirmedNow;order.confirmedBy=user.id;}else{order.lastConfirmedAt=confirmedNow;order.lastConfirmedBy=user.id;}order.confirmRequestId=confirmRequestId||null;
  if(learned.length&&!isTempRoute(order.routeId)){base.version=(Number(base.version)||1)+1;base.updatedAt=new Date().toISOString();base.updatedBy=user.id}
  order.businessFingerprint=await businessFingerprint(order);
  // 确认待定门店后，门店标准名可能发生变化，必须同步重算当日业务去重键。
  // 否则原 PLANNED 运单的 dailyDedupeKey 仍携带 OCR 待定名称，
  // 下一次上传同一张已确认运单时，新签名无法命中旧单，可能产生重复运单。
  const prevDailyDedupeKey=clean(order.dailyDedupeKey);
  const nextDailyDedupeKey=await dailyWaybillKey(order);
  order.dailyDedupeKey=nextDailyDedupeKey;
  const learningEntries=learned.map(item=>({field:[clean(item.storeId),normalized(item.rawName||item.name)].join("|"),value:JSON.stringify(item)})).filter(x=>x.field);
  const basePayload=(learned.length&&!isTempRoute(order.routeId))?JSON.stringify(base):"";
  const indexKey=/^\d{4}-\d{2}-\d{2}$/.test(clean(order.date))?waybillIndexKey(order.routeId,clean(order.date)):"";
  const commitScript='local okOrder,order=pcall(cjson.decode,ARGV[1]); if not okOrder or type(order)~="table" then return 2 end; local rawDone=redis.call("GET",KEYS[2]); if rawDone then return 3 end; local existingFingerprint=redis.call("GET",KEYS[6]); if existingFingerprint and existingFingerprint~=order.id then return 7 end; local existingDaily=redis.call("GET",KEYS[7]); if existingDaily and existingDaily~=order.id then return 8 end; local okItems,items=pcall(cjson.decode,ARGV[2]); if not okItems or type(items)~="table" then return 4 end; for _,item in ipairs(items) do if type(item)~="table" or type(item.field)~="string" or item.field=="" or type(item.value)~="string" or item.value=="" then return 6 end end; if ARGV[3]~="" then local okBase,base=pcall(cjson.decode,ARGV[3]); if not okBase or type(base)~="table" then return 5 end end; if ARGV[3]~="" then redis.call("SET",KEYS[4],ARGV[3]) end; redis.call("SET",KEYS[1],ARGV[1]); redis.call("SET",KEYS[2],"1"); redis.call("SET",KEYS[6],order.id); redis.call("SET",KEYS[7],order.id); for _,item in ipairs(items) do redis.call("HSET",KEYS[3],item.field,item.value) end; if ARGV[4]~="" then redis.call("SADD",KEYS[5],order.id) end; return 1';
  const commitResult=await command(env,["EVAL",commitScript,"7","zp:waybill:"+order.id,"zp:"+doneKey,"zp:waybill:"+order.id+":learning-repair","zp:route:"+order.routeId+":base",indexKey||"zp:waybills:noop","zp:waybill:fingerprint:"+order.businessFingerprint,"zp:waybill:dedupe:"+nextDailyDedupeKey,JSON.stringify(order),JSON.stringify(learningEntries),basePayload,indexKey?"1":"",confirmedNow,order.businessFingerprint,nextDailyDedupeKey]);
  if(Number(commitResult)===3){const committed=await load(env,waybillId);if(!committed)throw Object.assign(new Error("运单不存在"),{code:"WAYBILL_NOT_FOUND"});order=committed;let learning=await retryLearningRepairs(env,waybillId,user.id);try{await appendWaybillEvent(env,waybillId,{event:"WAYBILL_ALREADY_CONFIRMED",stage:"CONFIRM",requestId:order.requestId||null,userId:user.id});}catch{}if(routeBaseLock){await releaseLock(env,routeBaseLock);routeBaseLock=null}await releaseLock(env,waybillLock);waybillLock=null;await releaseLock(env,requestLock);requestLock=null;return json({success:true,waybill:order,learning:learning==="RECORDED"?"ALREADY_CONFIRMED":"DEFERRED"});}  if(Number(commitResult)!==1)throw new Error("WAYBILL_COMMIT_FAILED");
  // 方案C rollup：确认提交成功（运单进入索引）后重算当日汇总键（best-effort）
  try{await recomputeDayMeta(env,order.routeId,clean(order.date))}catch(e){degraded("stats.daymeta-recompute-failed",e,{routeId:clean(order.routeId),date:clean(order.date)})}
  // 指纹漂移回收：只在提交成功后执行——提交失败时保留原状，仍可安全重试。详见 retireStaleFingerprintKey 注释。
  const retiredFp=await retireStaleFingerprintKey(env,{prevFingerprint,nextFingerprint:order.businessFingerprint,ownerId:order.id});
  // 旧 daily dedupe key 只允许 CAS 删除，避免旧键已经被其他运单复用时误删。
  if(prevDailyDedupeKey && prevDailyDedupeKey!==nextDailyDedupeKey){
    try{
      await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1","zp:waybill:dedupe:"+prevDailyDedupeKey,order.id]);
    }catch{}
  }
  if(retiredFp)try{await appendWaybillEvent(env, order.id, {event:"WAYBILL_IDENTITY_RETIRED",stage:"CONFIRM",requestId:confirmRequestId||null,userId:user.id,reason:"FINGERPRINT_DRIFT"});}catch{}
  let learningStatus=learned.length?await retryLearningRepairs(env,order.id,user.id):"NONE";
  try{await appendWaybillEvent(env, order.id, {event:"CONFIRM_COMPLETED",stage:"CONFIRM",requestId:order.requestId||null,userId:user.id,confirmedBy:user.id,pending:finalStores.filter(s=>s.pending).length,learned:learned.length});}catch{}
  if(learned.length)try{await appendWaybillEvent(env, order.id, {event:"LEARNING_COMPLETED",stage:"LEARNING",requestId:order.requestId||null,userId:user.id,learned:learned.length});}catch{}
  const indexSync="OK";
  if(routeBaseLock){await releaseLock(env,routeBaseLock);routeBaseLock=null}
  await releaseLock(env,waybillLock);waybillLock=null;
  await releaseLock(env,requestLock);requestLock=null;
  return json({success:true,waybill:order,learning:learningStatus,indexSync});
 }catch(e){
  try{if(routeBaseLock)await releaseLock(env,routeBaseLock);if(waybillLock)await releaseLock(env,waybillLock);if(requestLock)await releaseLock(env,requestLock);}catch(e){degraded("lock.release-failed-on-error",e,{})}
  return json({success:false,code:e?.code||"CONFIRM_INTERNAL_ERROR",error:e?.message||"确认待定门店失败",recoverable:true,action:"RETRY_LATER",hint:"确认失败，请稍后重试"},500);
 }
}
