import {command, setEx, sessionCookie, SESSION_TTL_SECONDS} from "./_redis.js";

/* 会话鉴权：将原先两个串行 Redis REST 往返合并为一个 Lua 往返。
 * 原链路每个受保护 API 都先 GET session，再解析 userId，最后 GET user；
 * 在弱网/跨境链路下，这两次串行 RTT 会直接叠加到每个页面请求上。
 * Lua 只做同等的读取，不写入任何数据；键仍严格限定为 zp:session:* 与 zp:user:*。
 */
const AUTH_READ_SCRIPT = `
local session = redis.call("GET", KEYS[1])
if not session then return {false, false} end
local ok, data = pcall(cjson.decode, session)
if not ok or type(data) ~= "table" or not data.userId then
  return {session, false}
end
local user = redis.call("GET", ARGV[1] .. data.userId)
return {session, user or false}
`;

export async function currentUser(request,env){
 const token=(request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"")||readSession(request);
 if(!token) return null;

 // 一个 Redis EVAL 在服务端原子读取 session + user，避免两个串行 HTTP 往返。
 let pair;
 try {
  pair=await command(env,["EVAL",AUTH_READ_SCRIPT,"1","zp:session:"+token,"zp:user:"]);
 } catch (error) {
  // 不静默降级到两次请求：否则 Redis/Lua 故障时会把慢请求放大成双倍等待；
  // 由既有 guard/错误处理按数据服务故障路径处理。
  throw error;
 }
 const session=Array.isArray(pair)?pair[0]:null;
 const raw=Array.isArray(pair)?pair[1]:null;
 if(!session) return null;
 let data; try{data=typeof session==="string"?JSON.parse(session):session}catch{return null}
 if(!data?.userId||!raw) return null;
 try{
  const user=typeof raw==="string"?JSON.parse(raw):raw;
  if(user.disabled) return null;
  if(String(user.sessionVersion??1)!==String(data.sessionVersion??1)) return null;
  return user;
 }catch{return null}
}
function readSession(request){
 const raw=request.headers.get("cookie")||"";
 const m=raw.match(/(^|;\s*)zp_session=([^;]+)/);
 return m?decodeURIComponent(m[2]):"";
}
export function requireUser(request,env){
 return currentUser(request,env).then(user=>{if(!user) throw Object.assign(new Error("UNAUTHORIZED"),{status:401});return user});
}

/**
 * 滑动续期：在读得有效会话的前提下，把服务端 session TTL 续到 SESSION_TTL_SECONDS（90 天），
 * 并返回刷新后的会话 Cookie（Max-Age 同步到 90 天）。仅有效会话执行，无效/缺失会话返回 null
 * （绝不写 Cookie，也不会把过期会话复活）。
 * 调用方（/api/me、/api/home-bootstrap）把返回值作为响应的 set-cookie 注入，
 * 否则浏览器 Cookie 仍按首次下发的 7 天 Max-Age 倒计时，到时丢弃 Cookie，服务端续期形同虚设。
 */
export async function refreshSession(request, env){
 const token=readSession(request);
 if(!token) return null;
 const raw=await command(env,["GET","zp:session:"+token]);
 if(!raw) return null;
 await setEx(env,"session:"+token,raw,SESSION_TTL_SECONDS);
 return sessionCookie(token);
}
