import {json,body,withSecurityHeaders} from "./_json.js";
import {get,setEx,newId,command,sessionCookie,SESSION_TTL_SECONDS} from "./_redis.js";
import {Budget,mgetBatchMap,SUBREQUEST_LIMIT} from "./_redis-budget.js";
import {ensureEnvAdmin} from "./_env-admin.js";
import {verifyPassword,hashPassword,needsUpgrade} from "./_password.js";
import {peek,bump,clear,clientIp,scopePart,firstExceeded} from "./_ratelimit.js";

// 限流窗口与阈值（P0-7）
// ------------------------------------------------------------------
// 15 分钟窗口是「真人输错几次 + 自动脚本几千次」的分界线：
// 真人在 15 分钟内连续输错 10 次几乎不可能，脚本在 15 分钟内撞库几千次毫无压力。
// per-username 10 次：挡定向猜密码；per-ip 40 次：挡撞库与用户名枚举（IP 下往往有多个账号）。
const LOGIN_WINDOW_SECONDS=900;
const LOGIN_LIMIT_USERNAME=10;
const LOGIN_LIMIT_IP=40;

function tooMany(state){
 return json({success:false,error:"尝试过于频繁，请稍后重试",code:"LOGIN_RATE_LIMITED"},429,
  {"retry-after":String(Math.max(1,state?.retryAfter||LOGIN_WINDOW_SECONDS))});
}

/**
 * 存量账号的机会性升级（P0-6 迁移策略）
 * ------------------------------------------------------------------
 * 旧账号存的是裸 SHA-256（无盐）。一次性全库重置密码不现实（要通知所有用户），
 * 所以改成：**登录成功且校验通过的是旧格式时，当场用新格式重写一次哈希**。
 * 用户无感，存量账号随登录自然完成迁移；环境变量管理员因哈希来自 env 不在此列
 * （它的哈希每次登录都会被 ensureEnvAdmin 以 env 为准写回，升级了也会被覆盖）。
 *
 * 用 Lua 做条件写：只有库里的哈希仍然等于旧值、且 id 未变时才写，
 * 避免与「管理员同时在改这个用户」互相覆盖。
 */
const UPGRADE_SCRIPT="local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' then return 0 end; if u.id~=ARGV[3] then return 0 end; if u.passwordHash~=ARGV[1] then return 0 end; u.passwordHash=ARGV[2]; redis.call('SET',KEYS[1],cjson.encode(u)); return 1";
async function upgradeLegacyHash(env,user,nextHash){
 try{await command(env,["EVAL",UPGRADE_SCRIPT,"1","zp:user:"+user.id,user.passwordHash,nextHash,user.id]);return true}catch{return false}
}

export async function onRequestPost({request,env}){
 const input=await body(request);
 const username=String(input.username||"").trim();
 const password=String(input.password||"");
 if(!username||!password)return json({success:false,error:"请输入账号和密码",code:"LOGIN_CREDENTIALS_REQUIRED"},400);

 // 限流：账号桶 + IP 桶，一次只读往返查完
 const scopes=["login:u:"+scopePart(username),"login:ip:"+scopePart(clientIp(request))];
 const limits=[LOGIN_LIMIT_USERNAME,LOGIN_LIMIT_IP];
 const before=await peek(env,scopes);
 const blocked=firstExceeded(before,limits);
 if(blocked>=0)return tooMany(before[blocked]);

 // 失败路径：计一次数，再返回原本的错误（限流不改变业务错误语义）
 const fail=async res=>{await bump(env,scopes,LOGIN_WINDOW_SECONDS);return res};

 // 环境变量管理员（ADMIN_USERNAME/ADMIN_PASSWORD_HASH）：库里没有就先补回库里。
 // 这样数据库被清空后管理员仍能登录 —— 2026-10-18 迁库清空后系统彻底进不去的教训。
 await ensureEnvAdmin(env,username);
 const index=await get(env,"user:index:"+username.toLowerCase());
 if(!index)return fail(json({success:false,error:"账号或密码错误",code:"LOGIN_INVALID_CREDENTIALS"},401));
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
 // 旧：user.passwordHash!==await hash(password)（裸 SHA-256 无盐）
 // 新：verifyPassword 同时认新格式 pbkdf2$... 与旧格式 64 位 hex
 if(!(await verifyPassword(password,user.passwordHash)))
  return fail(json({success:false,error:"账号或密码错误",code:"LOGIN_INVALID_CREDENTIALS"},401));

 // 登录成功：清掉历史失败计数（只在确实有过失败时才写，省一次往返）
 if(before.some(s=>s.count>0))await clear(env,scopes);
 // 旧哈希就地升级为 PBKDF2（用户无感，见 upgradeLegacyHash 注释）
 if(needsUpgrade(user.passwordHash))await upgradeLegacyHash(env,user,await hashPassword(password,env));

 const token=newId();
 const version=user.sessionVersion??1;
 // P2-11 收口：session 键加 TTL，与 Cookie 的 Max-Age 严格同寿命（7 天）。
 // 原实现裸 SET 永不过期 → 浏览器丢弃 Cookie 后服务端会话永久驻留，zp:session:* 无界增长。
 await setEx(env,"session:"+token,{userId:user.id,sessionVersion:version,createdAt:new Date().toISOString()},SESSION_TTL_SECONDS);
 return new Response(JSON.stringify({success:true,user:{
  id:user.id,username:user.username,role:user.role||"user",name:user.name||"",
  boundRouteId:user.boundRouteId||null,routeDuty:user.routeDuty||null,dispatchRouteId:user.dispatchRouteId||null
 }}),{status:200,headers:withSecurityHeaders({"content-type":"application/json; charset=utf-8","cache-control":"no-store","set-cookie":sessionCookie(token)})});
}
// 兼容导出：历史代码里有 `import {hash} from "./login.js"`。
// 新代码请直接 import {hashPassword, verifyPassword} from "./_password.js" ——
// 老的 hash() 是无盐裸 SHA-256，正是这次要淘汰的东西，别再新增调用方。
export {hashPassword as hash};
