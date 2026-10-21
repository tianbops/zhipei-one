import {json,body} from "./_json.js";
import {get,command,newId} from "./_redis.js";
import {hashPassword} from "./_password.js";
import {TEMP_ROUTE_PREFIX} from "./dispatch.js";
import {envAdminCredentials} from "./_env-admin.js";
import {peek,bump,clear,clientIp,scopePart,firstExceeded} from "./_ratelimit.js";

// 注册限流（P0-7）：邀请码是唯一注册入口，而没有失败次数限制时它可被无限次枚举。
// 真人注册失败（邀请码打错、账号重复）一小时 20 次不可能，脚本一小时几万次很轻松。
const REGISTER_WINDOW_SECONDS=3600;
const REGISTER_LIMIT_IP=20;

function normalize(v){return String(v??"").trim()}

async function registerAtomically(env,{id,username,name,passwordHash,inviteCode}){
 const codeKey="zp:invite-code:code:"+inviteCode;
 const userIndexKey="zp:user:index:"+username.toLowerCase();
 const userKey="zp:user:"+id;
 const usersIndexKey="zp:users:index";
 // 新注册用户默认进入“临时用户”状态：分配每人独立的临时线路（dispatchRouteId=__temp__:<id>，见 dispatch.js TEMP_ROUTE_PREFIX），
 // 避免未选择调度线路时空跑“请先选择调度线路”；各临时用户数据天然隔离，并共享全局学习库。
 const user={id,username,name,role:"user",disabled:false,boundRouteId:null,routeDuty:null,dispatchRouteId:TEMP_ROUTE_PREFIX+id,sessionVersion:1,passwordHash,createdAt:new Date().toISOString()};
 const script="local raw=redis.call('GET',KEYS[1]); if not raw then return -1 end; local ok,c=pcall(cjson.decode,raw); if not ok or type(c)~='table' or type(c.id)~='string' or type(c.code)~='string' then return -6 end; if string.upper(c.code)~=ARGV[5] then return -6 end; local main=redis.call('GET','zp:invite-code:'..c.id); if not main then return -6 end; local okm,m=pcall(cjson.decode,main); if not okm or type(m)~='table' or m.id~=c.id or m.code~=c.code then return -6 end; if c.enabled==false or m.enabled==false then return -2 end; if c.expiresAt and c.expiresAt~='' and ARGV[4] >= string.sub(c.expiresAt,1,19) then return -3 end; local used=tonumber(c.usedCount or 0) or 0; local max=tonumber(c.maxUses or 0) or 0; if max>0 and used>=max then return -4 end; if redis.call('GET',KEYS[2]) then return -5 end; local rawIds=redis.call('GET',KEYS[4]); local arr={}; if rawIds then local okIds,v=pcall(cjson.decode,rawIds); if not okIds or type(v)~='table' then return -7 end; arr=v; for _,uid in ipairs(arr) do if type(uid)~='string' or uid=='' then return -7 end end end; local next=used+1; c.usedCount=next; m.usedCount=next; redis.call('SET',KEYS[1],cjson.encode(c)); redis.call('SET','zp:invite-code:'..c.id,cjson.encode(m)); redis.call('SET',KEYS[3],ARGV[1]); redis.call('SET',KEYS[2],ARGV[3]); table.insert(arr,ARGV[3]); redis.call('SET',KEYS[4],cjson.encode(arr)); return 1";
 const now=new Date().toISOString().slice(0,19);
 return command(env,["EVAL",script,"4",codeKey,userIndexKey,userKey,usersIndexKey,JSON.stringify(user),username,id,now,inviteCode]);
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

  // 限流：邀请码爆破防护。只统计**失败**，成功注册不清零也不计数（见 _ratelimit.js 说明）
  const scopes=["register:ip:"+scopePart(clientIp(request))];
  const limits=[REGISTER_LIMIT_IP];
  const before=await peek(env,scopes);
  const blocked=firstExceeded(before,limits);
  if(blocked>=0)return json({success:false,error:"尝试过于频繁，请稍后重试",code:"REGISTER_RATE_LIMITED"},429,
    {"retry-after":String(Math.max(1,before[blocked].retryAfter||REGISTER_WINDOW_SECONDS))});
  const fail=async res=>{await bump(env,scopes,REGISTER_WINDOW_SECONDS);return res};

  const existing=await get(env,"user:index:"+username.toLowerCase());
  if(existing)return fail(json({success:false,error:"账号已存在"},409));
  // 环境变量管理员的账号名是保留名：不能被普通注册抢占，否则管理员会被挤掉。
  const envAdmin=envAdminCredentials(env);
  if(envAdmin&&username.toLowerCase()===envAdmin.username.toLowerCase())
    return fail(json({success:false,error:"该账号为系统保留账号，无法注册"},409));
  const id=newId();
  const passwordHash=await hashPassword(password,env);
  const result=Number(await registerAtomically(env,{id,username,name,passwordHash,inviteCode}));
  // 邀请码类失败是爆破的目标，全部计数；系统级异常（500）不计数——那不是攻击者的错，
  // 也不该让一次后端抖动把正常用户锁一小时。
  if(result===-5)return fail(json({success:false,error:"账号已存在"},409));
  if(result===-1)return fail(json({success:false,error:"邀请码不存在"},400));
  if(result===-2)return fail(json({success:false,error:"邀请码已停用"},400));
  if(result===-3)return fail(json({success:false,error:"邀请码已过期"},400));
  if(result===-4)return fail(json({success:false,error:"邀请码已用完"},400));
  if(result===-6||result===-7)return json({success:false,error:"注册数据异常，请联系管理员处理"},409);
  if(result!==1)return json({success:false,error:"注册失败，请稍后重试"},500);
  return json({success:true,message:"注册成功，请登录",user:{id,username,name,role:"user"}},201);
 }catch(error){
  return json({success:false,error:"注册服务异常，请稍后重试",code:"REGISTER_INTERNAL_ERROR"},500);
 }
}