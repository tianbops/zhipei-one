import {json,body} from "./_json.js";
import {get,setEx,newId,sessionCookie,SESSION_TTL_SECONDS} from "./_redis.js";
import {Budget,mgetBatchMap,SUBREQUEST_LIMIT} from "./_redis-budget.js";
async function hash(value){const data=new TextEncoder().encode(value);const digest=await crypto.subtle.digest("SHA-256",data);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("")}
export async function onRequestPost({request,env}){
 const input=await body(request);
 const username=String(input.username||"").trim();
 const password=String(input.password||"");
 if(!username||!password)return json({success:false,error:"请输入账号和密码",code:"LOGIN_CREDENTIALS_REQUIRED"},400);
 const index=await get(env,"user:index:"+username.toLowerCase());
 if(!index)return json({success:false,error:"账号或密码错误",code:"LOGIN_INVALID_CREDENTIALS"},401);
 let raw=await get(env,"user:"+index);
 if(!raw){
  const idsRaw=await get(env,"users:index");
  let ids=[];try{ids=JSON.parse(idsRaw||"[]")}catch{ids=[]}
  const candidateIds=Array.isArray(ids)?[...new Set(ids.map(x=>String(x||"").trim()).filter(Boolean))]:[];
  const budget=new Budget(SUBREQUEST_LIMIT);
  const {map,complete}=await mgetBatchMap(env,candidateIds.map(id=>"zp:user:"+id),budget,{batch:100});
  if(!complete)return json({success:false,error:"账号数据正在恢复，请稍后重试",code:"LOGIN_USER_DATA_BUSY"},503);
  for(const id of candidateIds){
   const candidate=map.get("zp:user:"+id);
   if(!candidate)continue;
   try{const parsed=JSON.parse(candidate);if(String(parsed.username||"").toLowerCase()===username.toLowerCase()){raw=candidate;break}}catch{}
  }
 }
 if(!raw)return json({success:false,error:"账号数据异常",code:"LOGIN_USER_DATA_INVALID"},500);
 let user;try{user=JSON.parse(raw)}catch{return json({success:false,error:"账号数据异常",code:"LOGIN_USER_DATA_INVALID"},500)}
 if(user.disabled)return json({success:false,error:"账号已停用",code:"LOGIN_USER_DISABLED"},403);
 if(user.passwordHash!==await hash(password))return json({success:false,error:"账号或密码错误",code:"LOGIN_INVALID_CREDENTIALS"},401);
 const token=newId();
 const version=user.sessionVersion??1;
 // P2-11 收口：session 键加 TTL，与 Cookie 的 Max-Age 严格同寿命（7 天）。
 // 原实现裸 SET 永不过期 → 浏览器丢弃 Cookie 后服务端会话永久驻留，zp:session:* 无界增长。
 await setEx(env,"session:"+token,{userId:user.id,sessionVersion:version,createdAt:new Date().toISOString()},SESSION_TTL_SECONDS);
 return new Response(JSON.stringify({success:true,user:{
  id:user.id,username:user.username,role:user.role||"user",name:user.name||"",
  boundRouteId:user.boundRouteId||null,routeDuty:user.routeDuty||null,dispatchRouteId:user.dispatchRouteId||null
 }}),{status:200,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","set-cookie":sessionCookie(token)}});
}
export {hash};
