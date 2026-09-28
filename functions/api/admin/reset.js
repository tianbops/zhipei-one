import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {command} from "../_redis.js";

async function scanAll(env){
 let cursor="0",keys=[];
 do{
  const result=await command(env,["SCAN",cursor,"MATCH","*","COUNT","100"]);
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

 const keys=await scanAll(env);
 if(keys.length) await command(env,["DEL",...keys]);

 return json({
  success:true,
  message:"测试数据库已全部清理，请通过管理员初始化重新建立管理员账号",
  deletedKeys:keys.length,
  keptAdmin:null
 });
}
