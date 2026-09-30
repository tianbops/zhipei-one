import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command,sessionCookie} from "./_redis.js";
import {hash} from "./login.js";

function validUsername(v){return /^[A-Za-z0-9_\-.]{3,32}$/.test(v)}

export async function onRequestPost({request,env}){
 try{
  const actor=await currentUser(request,env);
  if(!actor)return json({success:false,error:"未登录",code:"AUTH_REQUIRED"},401);
  const input=await body(request);
  const action=String(input.action||"");

  if(action==="rename"){
   const username=String(input.username||"").trim();
   if(!validUsername(username))return json({success:false,error:"用户名需为3-32位字母、数字、下划线、短横线或点"},400);
   if(username.toLowerCase()===String(actor.username||"").toLowerCase())return json({success:true,user:{id:actor.id,username}});
   const oldKey="user:index:"+String(actor.username||"").toLowerCase();
   const newKey="user:index:"+username.toLowerCase();
   const userKey="user:"+actor.id;
   const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] then return 3 end; if redis.call('GET',KEYS[2]) then return 4 end; redis.call('DEL',KEYS[1]); u.username=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[3],cjson.encode(u)); redis.call('SET',KEYS[2],ARGV[2]); return 1";
   const code=Number(await command(env,["EVAL",script,"3",oldKey,newKey,userKey,username,actor.id]));
   if(code===4)return json({success:false,error:"用户名已存在",code:"USERNAME_EXISTS"},409);
   if(code!==1)return json({success:false,error:"账号状态已变化，请刷新后重试"},409);
   return json({success:true,user:{id:actor.id,username},reauthRequired:true});
  }

  if(action==="password"){
   const currentPassword=String(input.currentPassword||"");
   const password=String(input.password||"");
   const confirmPassword=String(input.confirmPassword||"");
   if(!currentPassword||!password||!confirmPassword)return json({success:false,error:"请完整填写密码"},400);
   if(password.length<6)return json({success:false,error:"新密码至少6位"},400);
   if(password!==confirmPassword)return json({success:false,error:"两次输入的新密码不一致"},400);
   if(actor.passwordHash!==await hash(currentPassword))return json({success:false,error:"当前密码错误",code:"CURRENT_PASSWORD_INVALID"},403);
   const nextHash=await hash(password);
   const key="user:"+actor.id;
   const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] then return 3 end; u.passwordHash=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1";
   const code=Number(await command(env,["EVAL",script,"1",key,nextHash,actor.id]));
   if(code!==1)return json({success:false,error:"账号状态已变化，请刷新后重试"},409);
   return json({success:true,reauthRequired:true});
  }

  if(action==="delete"){
   if(actor.role==="admin"||actor.role==="system_admin")return json({success:false,error:"系统管理员账号不能自行注销，请联系管理员处理",code:"ADMIN_ACCOUNT_DELETE_BLOCKED"},403);
   const password=String(input.password||"");
   if(!password)return json({success:false,error:"请输入当前密码确认注销"},400);
   if(actor.passwordHash!==await hash(password))return json({success:false,error:"当前密码错误",code:"CURRENT_PASSWORD_INVALID"},403);

   const userKey="user:"+actor.id;
   const userIndexKey="user:index:"+String(actor.username||"").toLowerCase();
   const usersIndexKey="users:index";
   const boundRouteId=String(actor.boundRouteId||"").trim();
   const routeKey=boundRouteId?"route:"+boundRouteId:"";
   const requestIndexKey="route-requests:index";

   const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[1] then return 3 end; if u.role=='admin' or u.role=='system_admin' then return 7 end; local routeKey=KEYS[4]; if routeKey~='' and u.boundRouteId then local rr=redis.call('GET',routeKey); if not rr then return 4 end; local okr,r=pcall(cjson.decode,rr); if not okr or type(r)~='table' or r.id~=u.boundRouteId then return 5 end; if u.routeDuty=='driver' then if r.driverUserId~=u.id then return 6 end; r.driverUserId=nil elseif u.routeDuty=='delivery' then if r.deliveryUserId~=u.id then return 6 end; r.deliveryUserId=nil else return 6 end; redis.call('SET',routeKey,cjson.encode(r)) end; local idx=redis.call('GET',KEYS[3]); if idx then local okIds,ids=pcall(cjson.decode,idx); if not okIds or type(ids)~='table' then return 8 end; local keep={}; for _,id in ipairs(ids) do if id~=u.id then table.insert(keep,id) end end; redis.call('SET',KEYS[3],cjson.encode(keep)) end; local reqRaw=redis.call('GET',KEYS[5]); if reqRaw then local okReq,reqIds=pcall(cjson.decode,reqRaw); if not okReq or type(reqIds)~='table' then return 9 end; local keepReq={}; for _,rid in ipairs(reqIds) do local rk='route-request:'..rid; local qraw=redis.call('GET',rk); if qraw then local okq,q=pcall(cjson.decode,qraw); if okq and type(q)=='table' and q.userId==u.id then redis.call('DEL',rk) else table.insert(keepReq,rid) end else table.insert(keepReq,rid) end end; redis.call('SET',KEYS[5],cjson.encode(keepReq)) end; redis.call('DEL',KEYS[2]); redis.call('DEL',KEYS[1]); return 1";
   const code=Number(await command(env,["EVAL",script,"5",userKey,userIndexKey,usersIndexKey,routeKey,requestIndexKey,actor.id]));
   if(code===4)return json({success:false,code:"BIND_ROUTE_MISSING",error:"当前绑定线路数据不存在，请联系管理员处理"},409);
   if(code===5||code===6)return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"当前账号与线路绑定状态不一致，请联系管理员处理"},409);
   if(code===7)return json({success:false,code:"ADMIN_ACCOUNT_DELETE_BLOCKED",error:"系统管理员账号不能自行注销，请联系管理员处理"},403);
   if(code===8||code===9)return json({success:false,code:"ACCOUNT_INDEX_INVALID",error:"账号关联数据异常，请联系管理员处理"},409);
   if(code!==1)return json({success:false,error:"注销失败，请稍后重试",code:"ACCOUNT_DELETE_FAILED"},409);
   return new Response(JSON.stringify({success:true,deleted:true}),{status:200,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","set-cookie":sessionCookie("",0)}});
  }

  return json({success:false,error:"不支持的操作"},400);
 }catch(e){
  return json({success:false,error:"账号设置服务异常，请稍后重试",code:"ACCOUNT_SETTINGS_INTERNAL_ERROR"},500);
 }
}
