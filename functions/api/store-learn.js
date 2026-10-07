import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,set,newId,command} from "./_redis.js";
import {canMaintainRoute} from "./_permissions.js";
import {learnGlobal} from "./_global-learning.js";
import {formatCompareKey} from "./waybills/_store-match.js";
import {getRoute} from "./_route.js";

async function base(env,id){
 const raw=await get(env,"route:"+id+":base");
 if(!raw)throw Object.assign(new Error("线路数据资料尚未建立"),{code:"BASE_NOT_FOUND"});
 let x;try{x=typeof raw==="string"?JSON.parse(raw):raw}catch{throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"})}
 if(!x||!Array.isArray(x.stores))throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"});
 return{...x,routeId:id};
}
const clean=x=>String(x??"").trim().slice(0,100);

async function retryRouteLearningRepairs(env,routeId){
 const key="zp:route:"+routeId+":learning-repair";
 const invalidKey=key+":invalid";
 const MAX_REPAIRS=3;
 const raw=await command(env,["HGETALL",key]);
 let processed=0;
 for(let i=0;i<(raw?.length||0)&&processed<MAX_REPAIRS;i+=2){
  const field=raw[i],value=raw[i+1];if(!field||!value)continue;
  let item=null;try{item=typeof value==="string"?JSON.parse(value):value}catch{}
  if(!item||!item?.storeId||!item?.rawName||!item?.standardName){
   await command(env,["HSET",invalidKey,field,JSON.stringify({status:"INVALID",field,raw:value,markedAt:new Date().toISOString()})]);
   await command(env,["HDEL",key,field]);processed++;continue;
  }
  try{await learnGlobal(env,item);await command(env,["HDEL",key,field]);processed++;}catch{}
 }
 const remaining=Number(await command(env,["HLEN",key]))||0;
 if(remaining===0)await command(env,["DEL",key]);
 return remaining;
}

export async function onRequestPost({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 const input=await body(request);
 const routeId=clean(input.routeId);
 if(!routeId||!canMaintainRoute(user,routeId))return json({success:false,error:"无权维护该线路数据资料"},403);
 const route=await getRoute(env,routeId);
 if(!route)return json({success:false,error:"线路不存在"},404);
 if(route.status!=="active")return json({success:false,error:"线路已停用，不能维护数据资料"},409);
 const rawName=clean(input.rawName||input.name);
 if(!rawName)return json({success:false,error:"门店名称不能为空"},400);

 const lockKey="route:"+routeId+":base-confirm-lock";
 const lockToken=newId();
 const locked=await command(env,["SET","zp:"+lockKey,lockToken,"NX","EX","120"]);
 if(locked!=="OK")return json({success:false,error:"该线路数据资料正在更新，请稍后重试",code:"BASE_UPDATE_BUSY"},409);

 try{
  await retryRouteLearningRepairs(env,routeId);
  const b=await base(env,routeId);
  let target=null;
  const existingId=clean(input.storeId);
  if(existingId)target=b.stores.find(s=>s.storeId===existingId);
  if(!target){
   const rawKey=formatCompareKey(rawName);
   target=b.stores.find(s=>[s.name,s.originalName,...(Array.isArray(s.aliases)?s.aliases:[])].some(v=>formatCompareKey(v)===rawKey));
  }
  if(!target){
   const rawKey=formatCompareKey(rawName);
   const conflict=b.stores.find(s=>s?.storeId!==existingId&&[s?.name,s?.originalName,...(Array.isArray(s?.aliases)?s.aliases:[])].some(v=>formatCompareKey(v)===rawKey));
   if(conflict)return json({success:false,code:"STORE_IDENTITY_CONFLICT",error:"该名称已属于其他门店，请使用正确的storeId或确认门店身份",storeId:conflict.storeId||null,name:conflict.name||conflict.originalName||rawName},409);
   target={storeId:newId(),originalName:rawName,name:rawName,aliases:[],navigation:clean(input.navigation)||null,routeOrder:b.stores.length+1,note:"",learnedAt:new Date().toISOString()};
   b.stores.push(target);
  }else if(rawName!==target.name&&!target.aliases?.includes(rawName)){
   const rawKey=formatCompareKey(rawName);
   const conflict=b.stores.find(s=>s?.storeId!==target.storeId&&[s?.name,s?.originalName,...(Array.isArray(s?.aliases)?s.aliases:[])].some(v=>formatCompareKey(v)===rawKey));
   if(conflict)return json({success:false,code:"STORE_IDENTITY_CONFLICT",error:"该名称已属于其他门店，不能作为当前门店别名",storeId:conflict.storeId||null,name:conflict.name||conflict.originalName||rawName},409);
   target.aliases=[...(target.aliases||[]),rawName];
  }

  const data={routeId,version:(Number(b.version)||1)+1,updatedAt:new Date().toISOString(),updatedBy:user.id,stores:b.stores};
  const repairKey="zp:route:"+routeId+":learning-repair";
  const repairField=[target.storeId,formatCompareKey(rawName)].join("|");
  const learningEventId=newId();
  const repairItem={storeId:target.storeId,rawName,standardName:target.name,originalName:target.originalName,navigation:target.navigation,routeId,waybillId:clean(input.waybillId),learningEventId,userId:user.id};
  const persistScript='local okBase=redis.call("SET",KEYS[1],ARGV[1]); if not okBase then return 0 end; redis.call("HSET",KEYS[2],ARGV[2],ARGV[3]); return 1';
  const persisted=await command(env,["EVAL",persistScript,"2","zp:route:"+routeId+":base",repairKey,JSON.stringify(data),repairField,JSON.stringify(repairItem)]);
  if(Number(persisted)!==1)throw Object.assign(new Error("线路数据资料提交失败"),{code:"BASE_COMMIT_FAILED"});

  let learning="RECORDED";
  try{
   const learned=await learnGlobal(env,{storeId:target.storeId,rawName,standardName:target.name,originalName:target.originalName,navigation:target.navigation,routeId,waybillId:clean(input.waybillId),learningEventId,userId:user.id});
   learning=learned.duplicate?"DUPLICATE_IGNORED":"RECORDED";
   await command(env,["HDEL",repairKey,repairField]);
  }catch(error){
   // 线路基准库已经成功提交；全局学习属于辅助数据，失败不能回滚业务主数据。
   // 后续可依据 DEFERRED 状态补偿全局学习，避免出现“全局已写入而线路被回滚”的反向不一致。
   learning="DEFERRED";
  }

  return json({success:true,store:target,base:data,globalLearning:learning});
 }finally{
  await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1","zp:"+lockKey,lockToken]).catch(()=>{});
 }
}
