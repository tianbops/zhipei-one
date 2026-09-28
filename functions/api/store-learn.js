import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,set,newId,command} from "./_redis.js";
import {canMaintainRoute} from "./_permissions.js";
import {learnGlobal} from "./_global-learning.js";
import {formatCompareKey} from "./waybills/_store-match.js";
import {getRoute} from "./_route.js";

async function base(env,id){
 const raw=await get(env,"route:"+id+":base");
 if(!raw)return{routeId:id,version:1,stores:[]};
 try{const x=typeof raw==="string"?JSON.parse(raw):raw;return{...x,routeId:id,stores:Array.isArray(x.stores)?x.stores:[]}}
 catch{return{routeId:id,version:1,stores:[]}}
}
const clean=x=>String(x??"").trim().slice(0,100);

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
 const locked=await command(env,["SET","zp:"+lockKey,"1","NX","EX","120"]);
 if(locked!=="OK")return json({success:false,error:"该线路数据资料正在更新，请稍后重试",code:"BASE_UPDATE_BUSY"},409);

 try{
  const b=await base(env,routeId);
  let target=null;
  const existingId=clean(input.storeId);
  if(existingId)target=b.stores.find(s=>s.storeId===existingId);
  if(!target){
   const rawKey=formatCompareKey(rawName);
   target=b.stores.find(s=>[s.name,s.originalName,...(Array.isArray(s.aliases)?s.aliases:[])].some(v=>formatCompareKey(v)===rawKey));
  }
  if(!target){
   target={storeId:newId(),originalName:rawName,name:rawName,aliases:[],navigation:clean(input.navigation)||null,routeOrder:b.stores.length+1,note:"",learnedAt:new Date().toISOString()};
   b.stores.push(target);
  }else if(rawName!==target.name&&!target.aliases?.includes(rawName)){
   target.aliases=[...(target.aliases||[]),rawName];
  }

  const data={routeId,version:(Number(b.version)||1)+1,updatedAt:new Date().toISOString(),updatedBy:user.id,stores:b.stores};
  await set(env,"route:"+routeId+":base",data);

  let learning="RECORDED";
  try{
   const learned=await learnGlobal(env,{storeId:target.storeId,rawName,standardName:target.name,originalName:target.originalName,navigation:target.navigation,routeId,waybillId:clean(input.waybillId),userId:user.id});
   learning=learned.duplicate?"DUPLICATE_IGNORED":"RECORDED";
  }catch(error){
   if(error?.message==="GLOBAL_LEARNING_BUSY")learning="DEFERRED";
   else throw error;
  }

  return json({success:true,store:target,base:data,globalLearning:learning});
 }finally{
  await command(env,["DEL","zp:"+lockKey]).catch(()=>{});
 }
}
