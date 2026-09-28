import {json,body} from "./_json.js";
import {get,command,newId} from "./_redis.js";
import {hash} from "./login.js";

function normalize(v){return String(v??"").trim()}

async function registerAtomically(env,{id,username,name,passwordHash,inviteCode}){
 const codeKey="zp:invite-code:code:"+inviteCode;
 const userIndexKey="zp:user:index:"+username.toLowerCase();
 const userKey="zp:user:"+id;
 const usersIndexKey="zp:users:index";
 const user={id,username,name,role:"user",disabled:false,boundRouteId:null,routeDuty:null,dispatchRouteId:null,sessionVersion:1,passwordHash,createdAt:new Date().toISOString()};
 const script="local raw=redis.call('GET',KEYS[1]); if not raw then return -1 end; local ok,c=pcall(cjson.decode,raw); if not ok or type(c)~='table' then return -6 end; if c.enabled==false then return -2 end; if c.expiresAt and c.expiresAt~='' and ARGV[4] >= string.sub(c.expiresAt,1,19) then return -3 end; local used=tonumber(c.usedCount or 0) or 0; local max=tonumber(c.maxUses or 0) or 0; if max>0 and used>=max then return -4 end; if redis.call('GET',KEYS[2]) then return -5 end; c.usedCount=used+1; redis.call('SET',KEYS[1],cjson.encode(c)); redis.call('SET',KEYS[3],ARGV[1]); redis.call('SET',KEYS[2],ARGV[3]); local rawIds=redis.call('GET',KEYS[4]); local arr={}; if rawIds then local okIds,v=pcall(cjson.decode,rawIds); if not okIds or type(v)~='table' then return -7 end; arr=v end; table.insert(arr,ARGV[3]); redis.call('SET',KEYS[4],cjson.encode(arr)); return 1";
 const now=new Date().toISOString().slice(0,19);
 return command(env,["EVAL",script,"4",codeKey,userIndexKey,userKey,usersIndexKey,JSON.stringify(user),username,id,now]);
}

export async function onRequestPost({request,env}){
 try{
  const input=await body(request);
  const username=normalize(input.username);
  const password=String(input.password??"");
  const name=(normalize(input.name)||username).slice(0,40);
  const inviteCode=normalize(input.inviteCode).toUpperCase();
  if(!username||!password||!inviteCode)return json({success:false,error:"请输入账号、密码和邀请码"},400);
  if(!/^[A-Za-z0-9_\-.]{3,32}$/.test(username))return json({success:false,error:"账号需为3-32位字母、数字、下划线、短横线或点"},400);
  if(password.length<6)return json({success:false,error:"密码至少6位"},400);
  const existing=await get(env,"user:index:"+username.toLowerCase());
  if(existing)return json({success:false,error:"账号已存在"},409);
  const id=newId();
  const passwordHash=await hash(password);
  const result=Number(await registerAtomically(env,{id,username,name,passwordHash,inviteCode}));
  if(result===-5)return json({success:false,error:"账号已存在"},409);
  if(result===-1)return json({success:false,error:"邀请码不存在"},400);
  if(result===-2)return json({success:false,error:"邀请码已停用"},400);
  if(result===-3)return json({success:false,error:"邀请码已过期"},400);
  if(result===-4)return json({success:false,error:"邀请码已用完"},400);
  if(result===-6||result===-7)return json({success:false,error:"注册数据异常，请联系管理员处理"},409);
  if(result!==1)return json({success:false,error:"注册失败，请稍后重试"},500);
  return json({success:true,message:"注册成功，请登录",user:{id,username,name,role:"user"}},201);
 }catch(error){
  return json({success:false,error:"注册服务异常，请稍后重试",code:"REGISTER_INTERNAL_ERROR"},500);
 }
}