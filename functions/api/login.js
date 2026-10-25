/**
 * POST /api/login —— 账号口令登录，成功后下发 7 天会话 Cookie（HttpOnly + SameSite=Lax + Secure）。
 * 账号不存在 / 口令错误 / 账号停用 / 触发限流，对外一律是「账号或密码错误」，不泄露账号是否存在。
 */
import {json,body,withSecurityHeaders} from "./_json.js";
import {guard} from "./_safe.js";
import {get,setEx,newId,command,sessionCookie,SESSION_TTL_SECONDS} from "./_redis.js";
import {Budget,mgetBatchMap,SUBREQUEST_LIMIT} from "./_redis-budget.js";
import {envAdminCredentials,envAdminId,ensureEnvAdminFromRecord} from "./_env-admin.js";
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

/**
 * 一次往返完成「用户名 → 用户记录」（P2-12）
 * ------------------------------------------------------------------
 * 原来是 `GET zp:user:index:<name>` 拿到 id，再 `GET zp:user:<id>` —— 两次**串行**往返，
 * 第二次的入参依赖第一次的结果，没法用 MGET 合并。登录是纯冷路径（无本地缓存可借），
 * 每次串行往返在中位 186ms 量级，两次就是登录耗时里最厚的一段。
 *
 * 改成脚本内连读：返回 [id] 或 [id, raw]（index 有值但用户记录缺失时只有 id，
 * 由调用方走原来的兜底扫描）。脚本是**只读**的，执行失败时调用方退化回两次 GET，
 * 不改变任何鉴权语义。
 */
// 一律返回**两个字符串**（不返回空表）：一是某些 Lua 运行时（含测试用的 fengari）
// 不接受空表作返回值，二是调用方可以只看下标、不用判类型。
const LOOKUP_SCRIPT=`
local id = redis.call('GET', KEYS[1])
if not id then return {false, false} end
local raw = redis.call('GET', ARGV[1] .. tostring(id))
if not raw then return {id, false} end
return {id, raw}
`;

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
 * （它的哈希以 env 为准，升级了也会被下一次播种覆盖回去，等于每次登录白写两次库，
 * 所以对它干脆不升级）。
 *
 * 用 Lua 做条件写：只有库里的哈希仍然等于旧值、且 id 未变时才写，
 * 避免与「管理员同时在改这个用户」互相覆盖。
 */
const UPGRADE_SCRIPT="local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' then return 0 end; if u.id~=ARGV[3] then return 0 end; if u.passwordHash~=ARGV[1] then return 0 end; u.passwordHash=ARGV[2]; redis.call('SET',KEYS[1],cjson.encode(u)); return 1";
async function upgradeLegacyHash(env,user,nextHash){
 try{await command(env,["EVAL",UPGRADE_SCRIPT,"1","zp:user:"+user.id,user.passwordHash,nextHash,user.id]);return true}catch{return false}
}

/** 按用户名读用户：优先走一次往返的脚本，脚本不可用时退化回原来的两次 GET */
async function lookupUserByName(env,username){
 const lower=username.toLowerCase();
 try{
  const r=await command(env,["EVAL",LOOKUP_SCRIPT,"1","zp:user:index:"+lower,"zp:user:"]);
  if(Array.isArray(r))return {id:r[0]?String(r[0]):null,raw:r[1]?String(r[1]):null};
 }catch{}
 const index=await get(env,"user:index:"+lower);
 if(!index)return {id:null,raw:null};
 return {id:String(index),raw:await get(env,"user:"+index)};
}

const handleLogin=guard(async ({request,env,waitUntil})=>{
 const ioStart=performance.now();
 const input=await body(request);
 const username=String(input.username||"").trim();
 const password=String(input.password||"");
 if(!username||!password)return json({success:false,error:"请输入账号和密码",code:"LOGIN_CREDENTIALS_REQUIRED"},400);

 // 限流：账号桶 + IP 桶，一次只读往返查完
 const scopes=["login:u:"+scopePart(username),"login:ip:"+scopePart(clientIp(request))];
 const limits=[LOGIN_LIMIT_USERNAME,LOGIN_LIMIT_IP];

 // 环境变量管理员（ADMIN_USERNAME/ADMIN_PASSWORD_HASH）：库里没有就先补回库里。
 // 这样数据库被清空后管理员仍能登录 —— 2026-10-18 迁库清空后系统彻底进不去的教训。
 const cred=envAdminCredentials(env);
 const isEnvAdmin=!!cred&&username.toLowerCase()===cred.username.toLowerCase();

 // 并行批（P2-12）：限流读 / 管理员记录读 / 用户名→用户连读，三者互不依赖。
 // 原来这三步是串行的，登录的服务端耗时绝大部分就耗在等这几次回程上。
 // 代价是「命中限流时多读了一次用户」——限流是异常路径，正常登录省下的往返更值钱。
 const [before,adminRaw,lookup]=await Promise.all([
  peek(env,scopes),
  isEnvAdmin?get(env,"user:"+envAdminId()):Promise.resolve(null),
  lookupUserByName(env,username)
 ]);
 const ioMs=Number((performance.now()-ioStart).toFixed(1));

 const blocked=firstExceeded(before,limits);
 if(blocked>=0)return tooMany(before[blocked]);

 // 失败路径：计一次数，再返回原本的错误（限流不改变业务错误语义）
 const fail=async res=>{await bump(env,scopes,LOGIN_WINDOW_SECONDS);return res};

 let raw=lookup?.raw||null;
 if(isEnvAdmin){
  // 播种只在「库里缺记录 / 哈希与环境变量不一致」时发生；已就绪则零写入。
  // 空库场景下是播种刚写完，直接拿播种结果，不再多读一次。
  const seeded=await ensureEnvAdminFromRecord(env,cred,adminRaw);
  if(seeded)raw=seeded;
 }
 // 用户名索引都不存在 → 账号不存在（环境变量管理员已由上面的播种兜住，不会走到这里）。
 // 直接失败，别为了一个不存在的账号去扫全量 users:index。
 if(!raw&&!lookup?.id)return fail(json({success:false,error:"账号或密码错误",code:"LOGIN_INVALID_CREDENTIALS"},401));
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
 // 旧哈希就地升级为 PBKDF2（用户无感，见 upgradeLegacyHash 注释）。
 // 登录已经成功了，升级只是顺手的迁移 —— 丢到响应之后做，不占关键路径。
 if(needsUpgrade(user.passwordHash)&&!(isEnvAdmin&&user.id===envAdminId())){
  const upgrade=async()=>{try{await upgradeLegacyHash(env,user,await hashPassword(password,env))}catch{}};
  if(typeof waitUntil==="function")waitUntil(upgrade());else await upgrade();
 }

 const token=newId();
 const version=user.sessionVersion??1;
 // P2-11 收口：session 键加 TTL，与 Cookie 的 Max-Age 严格同寿命（7 天）。
 // 原实现裸 SET 永不过期 → 浏览器丢弃 Cookie 后服务端会话永久驻留，zp:session:* 无界增长。
 await setEx(env,"session:"+token,{userId:user.id,sessionVersion:version,createdAt:new Date().toISOString()},SESSION_TTL_SECONDS);
 return new Response(JSON.stringify({success:true,user:{
  id:user.id,username:user.username,role:user.role||"user",name:user.name||"",
  boundRouteId:user.boundRouteId||null,routeDuty:user.routeDuty||null,dispatchRouteId:user.dispatchRouteId||null
 }}),{status:200,headers:withSecurityHeaders({"content-type":"application/json; charset=utf-8","cache-control":"no-store","set-cookie":sessionCookie(token),"server-timing":"login-io;dur="+ioMs})});
},"LOGIN_FAILED");

/**
 * POST /api/login —— 账号口令登录。
 * 校验成功下发 7 天会话 Cookie（HttpOnly + SameSite=Lax + Secure），返回用户身份与线路绑定。
 * 失败路径（口令错 / 账号停用 / 触发限流）统一走「账号或密码错误」，不泄露账号是否存在。
 *
 * 导出写成函数声明而不是 `export const onRequestPost = guard(...)`：
 * scripts/gen-api-docs.mjs 静态扫描「导出的 onRequest 系列函数声明」来识别端点，
 * 换成 const 形式会让 /api/login 从 API 文档里直接消失。行为与 guard 完全一致。
 */
export async function onRequestPost(ctx){return handleLogin(ctx)}
// 兼容导出：历史代码里有 `import {hash} from "./login.js"`。
// 新代码请直接 import {hashPassword, verifyPassword} from "./_password.js" ——
// 老的 hash() 是无盐裸 SHA-256，正是这次要淘汰的东西，别再新增调用方。
export {hashPassword as hash};
