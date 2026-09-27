import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {command,set} from "../_redis.js";

async function scanAll(env){
 let cursor="0",keys=[];
 do{
  const result=await command(env,["SCAN",cursor,"MATCH","zp:*","COUNT","100"]);
  cursor=String(result?.[0]??"0");
  const batch=Array.isArray(result?.[1])?result[1]:[];
  keys.push(...batch);
 }while(cursor!=="0");
 return [...new Set(keys)];
}

export async function onRequestPost({request,env}){
 const actor=await currentUser(request,env);
 if(!actor||actor.role!=="admin"){
  return json({success:false,error:"仅系统管理员可以执行清理"},403);
 }

 const actorId=actor.id;
 const actorIndexKey="zp:user:index:"+String(actor.username||"").toLowerCase();

 const keys=await scanAll(env);
 if(keys.length) await command(env,["DEL",...keys]);

 const cleanAdmin={
  ...actor,
  role:"admin",
  disabled:false,
  boundRouteId:null,
  routeDuty:null,
  dispatchRouteId:null,
  sessionVersion:Number(actor.sessionVersion||1)+1
 };

 await set(env,"user:"+actorId,cleanAdmin);
 await set(env,"user:index:"+String(actor.username||"").toLowerCase(),actorId);
 await set(env,"users:index",[actorId]);

 return json({
  success:true,
  message:"测试数据已清理，仅保留当前系统管理员",
  keptAdmin:{id:actorId,username:actor.username,role:"admin"},
  deletedKeys:keys.length
 });
}
