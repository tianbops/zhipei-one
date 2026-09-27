import {get} from "./_redis.js";
export async function currentUser(request,env){
 const token=(request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"")||readSession(request);
 if(!token) return null;
 const session=await get(env,"session:"+token);
 if(!session) return null;
 let data; try{data=typeof session==="string"?JSON.parse(session):session}catch{return null}
 if(!data?.userId) return null;
 const raw=await get(env,"user:"+data.userId);
 if(!raw) return null;
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
