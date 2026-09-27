import {json,body} from "./_json.js";
import {get,set,newId,sessionCookie} from "./_redis.js";
async function hash(value){const data=new TextEncoder().encode(value);const digest=await crypto.subtle.digest("SHA-256",data);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("")}
export async function onRequestPost({request,env}){
 const input=await body(request);
 const username=String(input.username||"").trim();
 const password=String(input.password||"");
 if(!username||!password)return json({success:false,error:"请输入账号和密码"},400);
 const index=await get(env,"user:index:"+username.toLowerCase());
 if(!index)return json({success:false,error:"账号或密码错误"},401);
 const raw=await get(env,"user:"+index);
 if(!raw)return json({success:false,error:"账号或密码错误"},401);
 let user;try{user=JSON.parse(raw)}catch{return json({success:false,error:"账号数据异常"},500)}
 if(user.disabled)return json({success:false,error:"账号已停用"},403);
 if(user.passwordHash!==await hash(password))return json({success:false,error:"账号或密码错误"},401);
 const token=newId();
 const version=user.sessionVersion??1;
 await set(env,"session:"+token,{userId:user.id,sessionVersion:version,createdAt:new Date().toISOString()});
 return new Response(JSON.stringify({success:true,user:{
  id:user.id,username:user.username,role:user.role||"user",name:user.name||"",
  boundRouteId:user.boundRouteId||null,routeDuty:user.routeDuty||null,dispatchRouteId:user.dispatchRouteId||null
 }}),{status:200,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","set-cookie":sessionCookie(token)}});
}
export {hash};
