const COOKIE="zp_session";const PREFIX="zp:";
function redis(env){return env?.UPSTASH_REDIS_REST_URL&&env?.UPSTASH_REDIS_REST_TOKEN?{url:env.UPSTASH_REDIS_REST_URL,token:env.UPSTASH_REDIS_REST_TOKEN}:null}
export async function command(env,parts){const r=redis(env);if(!r)throw new Error("REDIS_NOT_CONFIGURED");const response=await fetch(r.url,{method:"POST",headers:{Authorization:"Bearer "+r.token,"Content-Type":"application/json"},body:JSON.stringify(parts)});if(!response.ok){const detail=await response.text().catch(()=> "");throw new Error("REDIS_ERROR"+(detail?":"+detail.slice(0,240):""));}const data=await response.json();return data.result}
export async function get(env,key){return command(env,["GET",PREFIX+key])}
export async function set(env,key,value){return command(env,["SET",PREFIX+key,typeof value==="string"?value:JSON.stringify(value)])}
export async function del(env,key){return command(env,["DEL",PREFIX+key])}
export function cookieName(){return COOKIE}
export function sessionCookie(token,maxAge=604800){return COOKIE+"="+encodeURIComponent(token)+"; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age="+maxAge}
export function clearSessionCookie(){return COOKIE+"=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0"}
export function newId(){return crypto.randomUUID()}
