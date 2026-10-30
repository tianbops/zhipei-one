const COOKIE="zp_session";const PREFIX="zp:";
function redis(env){return env?.UPSTASH_REDIS_REST_URL&&env?.UPSTASH_REDIS_REST_TOKEN?{url:env.UPSTASH_REDIS_REST_URL,token:env.UPSTASH_REDIS_REST_TOKEN}:null}

// D1 后端优先：配置了 env.DB（Cloudflare D1 绑定）即走 D1，否则回退 Upstash（兼容旧部署）。
import { createD1Backend } from "./_db.js";
function d1Backend(env){
  if(!env||!env.DB) return null;
  if(!env.__zpD1) env.__zpD1 = createD1Backend(env);
  return env.__zpD1;
}

/**
 * 为单个只读请求创建独立 D1 Session 环境。
 * 不修改共享 env，也不复用其 D1Backend 缓存；缺少 Sessions API 时原样回退。
 * 默认 first-primary：首个查询从主库开始，后续查询由 Sessions API 保证顺序一致性。
 */
export function createD1SessionEnv(env,constraint="first-primary",routingObserver=null){
  const db=env?.DB;
  if(!db||typeof db.withSession!=="function") return env;
  return {...env,DB:db.withSession(constraint),__zpD1:undefined,__zpD1RoutingObserver:routingObserver||env.__zpD1RoutingObserver||null};
}

export async function command(env,parts){
  const d1=d1Backend(env);
  if(d1) return d1.command(parts);
  const r=redis(env);if(!r)throw new Error("REDIS_NOT_CONFIGURED");const response=await fetch(r.url,{method:"POST",headers:{Authorization:"Bearer "+r.token,"Content-Type":"application/json"},body:JSON.stringify(parts)});if(!response.ok){const detail=await response.text().catch(()=> "");throw new Error("REDIS_ERROR"+(detail?":"+detail.slice(0,240):""));}const data=await response.json();return data.result}
export async function pipeline(env,commands){
  const d1=d1Backend(env);
  if(d1) return d1.pipeline(commands);
  const r=redis(env);if(!r)throw new Error("REDIS_NOT_CONFIGURED");if(!Array.isArray(commands)||!commands.length)return[];const response=await fetch(r.url.replace(/\/$/,"")+"/pipeline",{method:"POST",headers:{Authorization:"Bearer "+r.token,"Content-Type":"application/json"},body:JSON.stringify(commands)});if(!response.ok){const detail=await response.text().catch(()=> "");throw new Error("REDIS_PIPELINE_ERROR"+(detail?":"+detail.slice(0,240):""));}const data=await response.json();return Array.isArray(data)?data.map(x=>x?.result):[]}
export async function get(env,key){return command(env,["GET",PREFIX+key])}
export async function set(env,key,value){return command(env,["SET",PREFIX+key,typeof value==="string"?value:JSON.stringify(value)])}
// 带 TTL 的写入（P2-11）：服务端键必须与 Cookie 的 Max-Age 同寿命。
// 原实现 session 用裸 SET 永不过期 —— 浏览器丢弃 Cookie 后，服务端会话永久驻留，
// zp:session:* 键空间无界增长，既拖慢 cleanupUserSessions 的全键扫描，也白占内存。
// TTL 非法（非正数/NaN）直接抛错，绝不静默改写成 1 秒 —— 那会让调用方以为设了长 TTL 却拿到短会话。
export async function setEx(env,key,value,ttlSeconds){const t=Number(ttlSeconds);if(!Number.isFinite(t)||t<1)throw new Error("SETEX_TTL_INVALID");return command(env,["SET",PREFIX+key,typeof value==="string"?value:JSON.stringify(value),"EX",String(Math.floor(t))])}
export async function del(env,key){return command(env,["DEL",PREFIX+key])}
export const SESSION_TTL_SECONDS=7776000;   // 90 天：滑动续期窗口。活跃用户每次打开 App（/api/me、/api/home-bootstrap 心跳）续到 90 天后，接近永久免登；仅 90 天完全不打开才过期重登。与 sessionCookie 默认 Max-Age 严格同寿。
export function cookieName(){return COOKIE}export function sessionCookie(token,maxAge=SESSION_TTL_SECONDS){return COOKIE+"="+encodeURIComponent(token)+"; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age="+maxAge}export function clearSessionCookie(){return COOKIE+"=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0"}export function newId(){return crypto.randomUUID()}