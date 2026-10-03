import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command} from "./_redis.js";
import {getRoute} from "./_route.js";

export const TEMP_DISPATCH_ID="__temporary__";

export async function onRequestGet({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin")return json({success:false,error:"管理员不参与业务调度"},403);
 const routeId=user.dispatchRouteId||null;
 let routeInfo=null;
 if(routeId===TEMP_DISPATCH_ID){
  routeInfo={id:TEMP_DISPATCH_ID,name:"临时线路",type:"temporary"};
 }else if(routeId){
  const route=await getRoute(env,routeId);
  if(route&&route.status==="active")routeInfo={id:route.id,name:route.name,type:"route"};
 }
 // 未调用路线用户（未选择调度线路且无业务线路绑定）直接分配至临时线路，
 // 含新注册用户——保证所有用户都有可用调度线路，避免空跑“请先选择调度线路”。
 if(!routeInfo&&!user.dispatchRouteId&&!user.boundRouteId){
  const script=`local raw=redis.call("GET",KEYS[1]);if not raw then return -1 end;local ok,u=pcall(cjson.decode,raw);if not ok or type(u)~="table" then return -2 end;if u.id~=ARGV[1] or u.disabled==true or u.role=="admin" then return -3 end;u.dispatchRouteId=ARGV[2];redis.call("SET",KEYS[1],cjson.encode(u));return 1`;
  const result=await command(env,["EVAL",script,"1","zp:user:"+user.id,user.id,TEMP_DISPATCH_ID]);
  if(Number(result)===1)routeInfo={id:TEMP_DISPATCH_ID,name:"临时线路",type:"temporary"};
 }
 return json({success:true,dispatchRoute:routeInfo});
}

export async function onRequestPost({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin")return json({success:false,error:"管理员不参与业务调度"},403);
 const input=await body(request);
 const routeId=String(input.routeId||"").trim();
 if(!routeId)return json({success:false,error:"请选择调度线路"},400);

 const route=routeId===TEMP_DISPATCH_ID?null:await getRoute(env,routeId);
 if(routeId!==TEMP_DISPATCH_ID&&(!route||route.status!=="active"))return json({success:false,error:"线路不存在或已停用"},404);
 const script=`local raw=redis.call("GET",KEYS[1]);if not raw then return -1 end;local ok,u=pcall(cjson.decode,raw);if not ok or type(u)~="table" then return -2 end;if u.id~=ARGV[1] or u.disabled==true or u.role=="admin" then return -3 end;u.dispatchRouteId=ARGV[2];redis.call("SET",KEYS[1],cjson.encode(u));return 1`;
 const result=await command(env,["EVAL",script,"1","zp:user:"+user.id,user.id,routeId]);
 if(Number(result)===-1||Number(result)===-3)return json({success:false,error:"用户状态已变化，请重新登录"},409);
 if(Number(result)===-2)return json({success:false,error:"用户数据异常"},409);
 return json({success:true,dispatchRoute:routeId===TEMP_DISPATCH_ID?{id:TEMP_DISPATCH_ID,name:"临时线路",type:"temporary"}:{id:route.id,name:route.name,type:"route"}});
}