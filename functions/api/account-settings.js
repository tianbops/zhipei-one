import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command} from "./_redis.js";
import {hash} from "./login.js";

function validUsername(v){return /^[A-Za-z0-9_\\-.]{3,32}$/.test(v)}

export async function onRequestPost({request,env}){
 try{
  const actor=await currentUser(request,env);
  if(!actor)return json({success:false,error:"未登录",code:"AUTH_REQUIRED"},401);
  const input=await body(request);
  const action=String(input.action||"");

  if(action==="rename"){
   const username=String(input.username||"").trim();
   if(!validUsername(username))return json({success:false,error:"用户名需为3-32位字母、数字、下划线、短横线或点"},400);
   if(username.toLowerCase()===String(actor.username||"").toLowerCase())return json({success:true,user:{id:actor.id,username}});
   const oldKey="zp:user:index:"+String(actor.username||"").toLowerCase();
   const newKey="zp:user:index:"+username.toLowerCase();
   const userKey="zp:user:"+actor.id;
   const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] then return 3 end; if redis.call('GET',KEYS[2]) then return 4 end; redis.call('DEL',KEYS[1]); u.username=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[3],cjson.encode(u)); redis.call('SET',KEYS[2],ARGV[2]); return 1";
   const code=Number(await command(env,["EVAL",script,"3",oldKey,newKey,userKey,username,actor.id]));
   if(code===4)return json({success:false,error:"用户名已存在",code:"USERNAME_EXISTS"},409);
   if(code!==1)return json({success:false,error:"账号状态已变化，请刷新后重试"},409);
   return json({success:true,user:{id:actor.id,username},reauthRequired:true});
  }

  if(action==="password"){
   const currentPassword=String(input.currentPassword||"");
   const password=String(input.password||"");
   const confirmPassword=String(input.confirmPassword||"");
   if(!currentPassword||!password||!confirmPassword)return json({success:false,error:"请完整填写密码"},400);
   if(password.length<6)return json({success:false,error:"新密码至少6位"},400);
   if(password!==confirmPassword)return json({success:false,error:"两次输入的新密码不一致"},400);
   if(actor.passwordHash!==await hash(currentPassword))return json({success:false,error:"当前密码错误",code:"CURRENT_PASSWORD_INVALID"},403);
   const nextHash=await hash(password);
   const key="zp:user:"+actor.id;
   const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] then return 3 end; u.passwordHash=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1";
   const code=Number(await command(env,["EVAL",script,"1",key,nextHash,actor.id]));
   if(code!==1)return json({success:false,error:"账号状态已变化，请刷新后重试"},409);
   return json({success:true,reauthRequired:true});
  }

  return json({success:false,error:"不支持的操作"},400);
 }catch(e){
  return json({success:false,error:"账号设置服务异常，请稍后重试",code:"ACCOUNT_SETTINGS_INTERNAL_ERROR"},500);
 }
}
