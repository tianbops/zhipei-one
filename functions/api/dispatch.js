import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,set} from "./_redis.js";
import {getRoute} from "./_route.js";

export const TEMP_DISPATCH_ID="__temporary__";

export async function onRequestGet({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin")return json({success:false,error:"管理员不参与业务调度"},403);
 const routeId=user.dispatchRouteId||null;
 if(!routeId)return json({success:true,dispatchRoute:null});
 if(routeId===TEMP_DISPATCH_ID)return json({success:true,dispatchRoute:{id:TEMP_DISPATCH_ID,name:"临时线路",type:"temporary"}});
 const route=await getRoute(env,routeId);
 if(!route||route.status!=="active")return json({success:true,dispatchRoute:null});
 return json({success:true,dispatchRoute:{id:route.id,name:route.name,type:"route"}});
}

export async function onRequestPost({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin")return json({success:false,error:"管理员不参与业务调度"},403);
 const input=await body(request);
 const routeId=String(input.routeId||"").trim();
 if(!routeId)return json({success:false,error:"请选择调度线路"},400);

 if(routeId===TEMP_DISPATCH_ID){
  user.dispatchRouteId=TEMP_DISPATCH_ID;
  await set(env,"user:"+user.id,user);
  return json({success:true,dispatchRoute:{id:TEMP_DISPATCH_ID,name:"临时线路",type:"temporary"}});
 }

 const route=await getRoute(env,routeId);
 if(!route||route.status!=="active")return json({success:false,error:"线路不存在或已停用"},404);
 user.dispatchRouteId=route.id;
 await set(env,"user:"+user.id,user);
 return json({success:true,dispatchRoute:{id:route.id,name:route.name,type:"route"}});
}