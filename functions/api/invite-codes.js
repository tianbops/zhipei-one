import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {command,get,set,newId} from "./_redis.js";

function admin(u){return u&&u.role==="admin"}
function normalize(v){return String(v||"").trim().toUpperCase()}
function safe(c){return {id:c.id,code:c.code,enabled:c.enabled!==false,maxUses:c.maxUses,usedCount:c.usedCount||0,expiresAt:c.expiresAt||null,createdAt:c.createdAt||null}}

export async function onRequestGet({request,env}){
 const actor=await currentUser(request,env);if(!admin(actor))return json({success:false,error:"无权限"},403);
 const raw=await get(env,"invite-codes:index");let ids=[];try{ids=raw?(typeof raw==="string"?JSON.parse(raw):raw):[]}catch{return json({success:false,code:"INVITE_INDEX_INVALID",error:"邀请码索引数据异常，请联系管理员处理"},409)}if(!Array.isArray(ids))return json({success:false,code:"INVITE_INDEX_INVALID",error:"邀请码索引数据异常，请联系管理员处理"},409)
 const codes=[];for(const id of Array.isArray(ids)?ids:[]){if(typeof id!=="string"||!id)return json({success:false,code:"INVITE_INDEX_INVALID",error:"邀请码索引数据异常，请联系管理员处理"},409);const base=await get(env,"invite-code:"+id);if(!base)return json({success:false,code:"INVITE_DATA_INVALID",error:"邀请码索引包含缺失的邀请码数据，请联系管理员处理"},409);try{const b=typeof base==="string"?JSON.parse(base):base;if(!b||b.id!==id||typeof b.code!=="string"||!b.code)return json({success:false,code:"INVITE_DATA_INVALID",error:"邀请码数据异常，请联系管理员处理"},409);const r=await get(env,"invite-code:code:"+b.code);if(!r)return json({success:false,code:"INVITE_DATA_INCONSISTENT",error:"邀请码主记录与编码索引不一致，请联系管理员处理"},409);const d=typeof r==="string"?JSON.parse(r):r;if(!d||d.id!==id||d.code!==b.code)return json({success:false,code:"INVITE_DATA_INCONSISTENT",error:"邀请码主记录与编码索引不一致，请联系管理员处理"},409);codes.push(safe(d))}catch{return json({success:false,code:"INVITE_DATA_INVALID",error:"邀请码数据异常，请联系管理员处理"},409)}}
 return json({success:true,codes});
}

export async function onRequestPost({request,env}){
 const actor=await currentUser(request,env);if(!admin(actor))return json({success:false,error:"无权限"},403);
 const input=await body(request);const action=String(input.action||"");
 if(action==="create"){
  const requestedUses=Number(input.maxUses); const maxUses=Number.isFinite(requestedUses)?Math.max(1,Math.min(9999,Math.floor(requestedUses))):1;
  const expiresAt=input.expiresAt?new Date(input.expiresAt).toISOString():null;
  if(input.expiresAt&&Number.isNaN(Date.parse(input.expiresAt)))return json({success:false,error:"有效期格式错误"},400);
  const id=newId();const code=("ZP-"+crypto.randomUUID().replaceAll("-","").slice(0,10)).toUpperCase();
  const c={id,code,enabled:true,maxUses,usedCount:0,expiresAt,createdAt:new Date().toISOString(),createdBy:actor.id};
  const indexKey="zp:invite-codes:index",idKey="zp:invite-code:"+id,codeKey="zp:invite-code:code:"+code;
  const script="local raw=redis.call('GET',KEYS[1]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if not ok or type(v)~='table' then return 4 end; ids=v end; for _,x in ipairs(ids) do if x==ARGV[1] then return 2 end end; if redis.call('GET',KEYS[3]) then return 3 end; redis.call('SET',KEYS[2],ARGV[2]); redis.call('SET',KEYS[3],ARGV[3]); table.insert(ids,ARGV[1]); redis.call('SET',KEYS[1],cjson.encode(ids)); return 1";
  const result=Number(await command(env,["EVAL",script,"3",indexKey,idKey,codeKey,id,JSON.stringify(c),JSON.stringify({...c,id})]));
  if(result===4)return json({success:false,code:"INVITE_INDEX_INVALID",error:"邀请码索引数据异常，请联系管理员处理"},409); if(result!==1)return json({success:false,error:"邀请码创建失败，请稍后重试"},500);
  return json({success:true,code:safe(c)},201);
 }
 if(action==="disable"||action==="enable"){
  const id=String(input.id||"").trim(); if(!id)return json({success:false,error:"邀请码参数无效"},400);
  const indexRaw=await get(env,"invite-codes:index"); let ids=[];
  if(indexRaw){try{ids=typeof indexRaw==="string"?JSON.parse(indexRaw):indexRaw}catch{return json({success:false,code:"INVITE_INDEX_INVALID",error:"邀请码索引数据异常，请联系管理员处理"},409)} if(!Array.isArray(ids))return json({success:false,code:"INVITE_INDEX_INVALID",error:"邀请码索引数据异常，请联系管理员处理"},409)}
  let target=null;
  for(const item of ids){const x=await get(env,"invite-code:"+item); if(!x)continue; try{const obj=typeof x==="string"?JSON.parse(x):x;if(obj?.id===id){target=obj;break}}catch{return json({success:false,code:"INVITE_DATA_INVALID",error:"邀请码数据异常，请联系管理员处理"},409)}}
  if(!target)return json({success:false,error:"邀请码不存在"},404);
  const key="zp:invite-code:"+id,codeKey="zp:invite-code:code:"+target.code,now=new Date().toISOString();
  const script="local a=redis.call('GET',KEYS[1]); local b=redis.call('GET',KEYS[2]); if not a or not b then return 2 end; local okA,c=pcall(cjson.decode,a); local okB,d=pcall(cjson.decode,b); if not okA or type(c)~='table' or not okB or type(d)~='table' then return 4 end; if c.id~=ARGV[2] or d.id~=ARGV[2] or c.code~=d.code then return 5 end; c.enabled=ARGV[1]=='1'; d.enabled=c.enabled; redis.call('SET',KEYS[1],cjson.encode(c)); redis.call('SET',KEYS[2],cjson.encode(d)); return 1";
  const result=Number(await command(env,["EVAL",script,"2",key,codeKey,action==="enable"?"1":"0",id,now]));
  if(result===2)return json({success:false,error:"邀请码不存在"},404);
  if(result===4)return json({success:false,code:"INVITE_DATA_INVALID",error:"邀请码数据异常，请联系管理员处理"},409);
  if(result===5)return json({success:false,code:"INVITE_DATA_INCONSISTENT",error:"邀请码数据不一致，请联系管理员处理"},409);
  if(result!==1)return json({success:false,error:"邀请码状态已变化，请刷新后重试"},409);
  const next={...target,enabled:action==="enable"};
  return json({success:true,code:safe(next)});
 }
 return json({success:false,error:"不支持的操作"},400);
}

// Atomically validate and consume one use. Returns code id on success, null otherwise.
export async function consumeInviteCode(env,code){
 const key="zp:invite-code:code:"+normalize(code);
 const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,c=pcall(cjson.decode,raw); if not ok or type(c)~='table' then return 0 end; if c.enabled==false then return 0 end; if c.expiresAt and c.expiresAt~='' then local exp=string.sub(c.expiresAt,1,19); local now=os.date('!%Y-%m-%dT%H:%M:%S'); if exp<=now then return 0 end end; local used=tonumber(c.usedCount or 0) or 0; local max=tonumber(c.maxUses or 0) or 0; if max>0 and used>=max then return 0 end; c.usedCount=used+1; redis.call('SET',KEYS[1],cjson.encode(c)); return 1";
 return (await command(env,["EVAL",script,"1",key]))===1;
}
