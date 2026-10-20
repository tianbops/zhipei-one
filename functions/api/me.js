import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {guard} from "./_safe.js";
export const onRequestGet=guard(async ({request,env})=>{
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 return json({success:true,user:{
  id:user.id,
  username:user.username,
  role:user.role||"user",
  name:user.name||"",
  boundRouteId:user.boundRouteId||null,
  routeDuty:user.routeDuty||null,
  dispatchRouteId:user.dispatchRouteId||null,
  disabled:!!user.disabled
 }});
});
