import {json,body} from "./_json.js";
import {get,command,newId} from "./_redis.js";
import {hash} from "./login.js";

function normalize(v){return String(v||"").trim()}
function parse(v,fallback){try{const x=typeof v==="string"?JSON.parse(v):v;return x??fallback}catch{return fallback}}

async function registerAtomically(env,{id,username,name,passwordHash}){
 const codeKey="zp:invite-code:code:"+username.__inviteCode;
 const userIndexKey="zp:user:index:"+username.value;
 const userKey="zp:user:"+id;
 const usersIndexKey="zp:users:index";
 const user={id,username:username.value,name,role:"user",disabled:false,boundRouteId:null,routeDuty:null,dispatchRouteId:null,sessionVersion:1,passwordHash,createdAt:new Date().toISOString()};
 const script="local raw=redis.call('GET',KEYS[1]); if not raw then return -1 end; local c=cjson.decode(raw); if c.enabled==false then return -2 end; if c.expiresAt and c.expiresAt~='' then local exp=string.sub(c.expiresAt,1,19); local now=os.date('!%Y-%m-%dT%H:%M:%S'); if exp<=now then return -3 end end; local used=tonumber(c.usedCount or 0) or 0; local max=tonumber(c.maxUses or 0) or 0; if max>0 and used>=max then return -4 end; if redis.call('GET',KEYS[2]) then return -5 end; c.usedCount=used+1; redis.call('SET',KEYS[1],cjson.encode(c)); redis.call('SET',KEYS[3],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); local ids=redis.call('GET',KEYS[4]); local arr={}; if ids then arr=cjson.decode(ids); end; if type(arr)~='table' then arr={} end; table.insert(arr,ARGV[3]); redis.call('SET',KEYS[4],cjson.encode(arr)); return 1";
 return command(env,["EVAL",script,"4",codeKey,userIndexKey,userKey,usersIndexKey,JSON.stringify(user),id]);
}

export async function onRequestPost({request,env}){
 const input=await body(request);
 const username=normalize(input.username);
 const password=String(input.password||"");
 const name=(normalize(input.name)||username).slice(0,40);
 const inviteCode=normalize(input.inviteCode).toUpperCase();
 if(!username||!password||!inviteCode)return json({success:false,error:"请输入账号、密码和邀请码"},400);
 if(!/^[A-Za-z0-9_\-\.]{3,32}$/.test(username))return json({success:false,error:"账号需为3-32位字母、数字、下划线、短横线或点"},400);
 if(password.length<6)return json({success:false,error:"密码至少6位"},400);
 const existing=await get(env,"user:index:"+username.toLowerCase());
 if(existing)return json({success:false,error:"账号已存在"},409);
 const id=newId();
 const passwordHash=await hash(password);
 const u={value:username,__inviteCode:inviteCode};
 const result=await registerAtomically(env,{id,username:u,name,passwordHash});
 if(result===-5)return json({success:false,error:"账号已存在"},409);
 if(result===-1)return json({success:false,error:"邀请码不存在"},400);
 if(result===-2)return json({success:false,error:"邀请码已停用"},400);
 if(result===-3)return json({success:false,error:"邀请码已过期"},400);
 if(result===-4)return json({success:false,error:"邀请码已用完"},400);
 if(result!==1)return json({success:false,error:"注册失败，请稍后重试"},500);
 return json({success:true,message:"注册成功，请登录",user:{id,username,name,role:"user"}},201);
}
