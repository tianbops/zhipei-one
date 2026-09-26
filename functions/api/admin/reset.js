import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {command} from "../_redis.js";

async function clearPrefix(env,prefix){
 let cursor="0",deleted=0;
 do{
  const result=await command(env,["SCAN",cursor,"MATCH",prefix+"*","COUNT","100"]);
  cursor=String(result?.[0]??"0");
  const keys=Array.isArray(result?.[1])?result[1]:[];
  if(keys.length){await command(env,["DEL",...keys]);deleted+=keys.length;}
 }while(cursor!=="0");
 return deleted;
}

export async function onRequestPost({request,env}){
 const actor=await currentUser(request,env);
 if(!actor||actor.role!=="admin")return json({success:false,error:"仅系统管理员可以执行初始化"},403);
 const deleted=await clearPrefix(env,"zp:");
 return json({success:true,message:"智配One数据初始化完成，请重新建立系统管理员",deleted});
}
