import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,set,command,newId} from "./_redis.js";
import {getRoute,validDuty} from "./_route.js";
function parse(v){try{return typeof v==="string"?JSON.parse(v):v}catch{return null}}
async function request(env,id){return parse(await get(env,"route-request:"+id))}
async function list(env){return parse(await get(env,"route-requests:index"))||[]}
export async function onRequestGet({request,env}){
 const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
 const ids=await list(env);const items=[];
 for(const id of Array.isArray(ids)?ids:[]){const x=await request(env,id);if(!x)continue;if(user.role==="admin"?x.status==="pending":x.userId===user.id)items.push(x)}
 return json({success:true,requests:items});
}
export async function onRequestPost({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin")return json({success:false,error:"管理员不参与业务线路绑定"},403);
 const input=await body(request);
 const routeId=String(input.routeId||"").trim();
 const duty=String(input.duty||"");
 if(!routeId||!validDuty(duty))return json({success:false,error:"线路或岗位无效"},400);
 const route=await getRoute(env,routeId);
 if(!route||route.status!=="active")return json({success:false,error:"线路不存在或已停用"},404);
 const id=newId(),now=new Date().toISOString();
 const userKey="zp:user:"+user.id,routeKey="zp:route:"+routeId,reqKey="zp:route-request:"+id,indexKey="zp:route-requests:index";
 const script="local cu=redis.call('GET',KEYS[1]); local cr=redis.call('GET',KEYS[2]); if not cu or not cr then return 2 end; local u=cjson.decode(cu); local r=cjson.decode(cr); if u.disabled then return 7 end; if u.boundRouteId then return 4 end; if r.status~='active' then return 8 end; if ARGV[2]=='driver' and r.driverUserId and r.driverUserId~=u.id then return 5 end; if ARGV[2]=='delivery' and r.deliveryUserId and r.deliveryUserId~=u.id then return 6 end; local raw=redis.call('GET',KEYS[4]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if ok and type(v)=='table' then ids=v end end; for _,rid in ipairs(ids) do local rqraw=redis.call('GET','zp:route-request:'..rid); if rqraw then local ok,q=pcall(cjson.decode,rqraw); if ok and q.userId==u.id and q.status=='pending' then return 3 end end end; local q={id=ARGV[1],userId=u.id,routeId=r.id,duty=ARGV[2],status='pending',createdAt=ARGV[3]}; redis.call('SET',KEYS[3],cjson.encode(q)); table.insert(ids,ARGV[1]); redis.call('SET',KEYS[4],cjson.encode(ids)); return 1";
 const rawCode=await command(env,["EVAL",script,"4",userKey,routeKey,reqKey,indexKey,id,duty,now]);
 const code=Number(rawCode);
 if(code===3)return json({success:false,error:"已有待审核申请"},409);
 if(code===4)return json({success:false,error:"你已绑定其他线路"},409);
 if(code===5||code===6)return json({success:false,error:"线路岗位已被占用"},409);
 if(code===7)return json({success:false,error:"账号已停用"},403);
 if(code===8)return json({success:false,error:"线路不存在或已停用"},409);
 if(code!==1)return json({success:false,code:"ROUTE_REQUEST_FAILED",message:"申请提交失败",detail:String(rawCode??"null")},409);
 return json({success:true,request:{id,userId:user.id,routeId,duty,status:"pending",createdAt:now}});
}
