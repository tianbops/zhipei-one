import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {command,get,set,newId} from "./_redis.js";

function admin(u){return u&&u.role==="admin"}
function normalize(v){return String(v||"").trim().toUpperCase()}
function safe(c){return {id:c.id,code:c.code,enabled:c.enabled!==false,maxUses:c.maxUses,usedCount:c.usedCount||0,expiresAt:c.expiresAt||null,createdAt:c.createdAt||null}}

export async function onRequestGet({request,env}){
 const actor=await currentUser(request,env);if(!admin(actor))return json({success:false,error:"无权限"},403);
 const raw=await get(env,"invite-codes:index");let ids=[];try{ids=raw?(typeof raw==="string"?JSON.parse(raw):raw):[]}catch{}
 const codes=[];for(const id of Array.isArray(ids)?ids:[]){const base=await get(env,"invite-code:"+id);if(base){try{const b=typeof base==="string"?JSON.parse(base):base;const r=await get(env,"invite-code:code:"+b.code);if(r)codes.push(safe(typeof r==="string"?JSON.parse(r):r))}catch{}}}
 return json({success:true,codes});
}

export async function onRequestPost({request,env}){
 const actor=await currentUser(request,env);if(!admin(actor))return json({success:false,error:"无权限"},403);
 const input=await body(request);const action=String(input.action||"");
 if(action==="create"){
  const maxUses=Math.max(1,Math.min(9999,Number(input.maxUses||1)));
  const expiresAt=input.expiresAt?new Date(input.expiresAt).toISOString():null;
  if(input.expiresAt&&Number.isNaN(Date.parse(input.expiresAt)))return json({success:false,error:"有效期格式错误"},400);
  const id=newId();const code=("ZP-"+crypto.randomUUID().replaceAll("-","").slice(0,10)).toUpperCase();
  const c={id,code,enabled:true,maxUses,usedCount:0,expiresAt,createdAt:new Date().toISOString(),createdBy:actor.id};
  await set(env,"invite-code:"+id,c);await set(env,"invite-code:code:"+code,{...c,id});const raw=await get(env,"invite-codes:index");let ids=[];try{ids=raw?(typeof raw==="string"?JSON.parse(raw):raw):[]}catch{}if(!Array.isArray(ids))ids=[];ids.push(id);await set(env,"invite-codes:index",ids);
  return json({success:true,code:safe(c)},201);
 }
 if(action==="disable"||action==="enable"){
  const id=String(input.id||"");const indexRaw=await get(env,"invite-codes:index");let ids=[];try{ids=indexRaw?(typeof indexRaw==="string"?JSON.parse(indexRaw):indexRaw):[]}catch{}const all=Array.isArray(ids)?ids:[];let raw=null;for(const item of all){const x=await get(env,"invite-code:"+item);if(x){const obj=typeof x==="string"?JSON.parse(x):x;if(obj.id===id){raw=await get(env,"invite-code:code:"+obj.code);break}}}if(!raw)return json({success:false,error:"邀请码不存在"},404);
  const c=typeof raw==="string"?JSON.parse(raw):raw;c.enabled=action==="enable";await set(env,"invite-code:code:"+c.code,c);await set(env,"invite-code:"+c.id,c);return json({success:true,code:safe(c)});
 }
 return json({success:false,error:"不支持的操作"},400);
}

// Atomically validate and consume one use. Returns code id on success, null otherwise.
export async function consumeInviteCode(env,code){
 const key="zp:invite-code:code:"+normalize(code);
 const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local c=cjson.decode(raw); if c.enabled==false then return 0 end; if c.expiresAt and c.expiresAt~='' then local exp=string.sub(c.expiresAt,1,19); local now=os.date('!%Y-%m-%dT%H:%M:%S'); if exp<=now then return 0 end end; local used=tonumber(c.usedCount or 0) or 0; local max=tonumber(c.maxUses or 0) or 0; if max>0 and used>=max then return 0 end; c.usedCount=used+1; redis.call('SET',KEYS[1],cjson.encode(c)); return 1";
 return (await command(env,["EVAL",script,"1",key]))===1;
}
