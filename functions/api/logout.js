import {json} from "./_json.js";
import {del,sessionCookie} from "./_redis.js";
function token(request){const a=(request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(a)return a;const c=request.headers.get("cookie")||"";const m=c.match(/(^|;\s*)zp_session=([^;]+)/);return m?decodeURIComponent(m[2]):""}
export async function onRequestPost({request,env}){const t=token(request);if(t)await del(env,"session:"+t);return new Response(JSON.stringify({success:true}),{status:200,headers:{"content-type":"application/json; charset=utf-8","set-cookie":sessionCookie("",0)}})}
export {json};
