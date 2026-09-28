import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,set,newId,command} from "./_redis.js";
import {getRoute,saveRoute,routeId,cleanRouteName} from "./_route.js";
async function list(env){const raw=await get(env,"routes:index");if(!raw)return [];try{return typeof raw==="string"?JSON.parse(raw):raw}catch{return []}}
async function writeList(env,items){return set(env,"routes:index",items)}
export async function onRequestGet({request,env}){const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);const ids=await list(env);const routes=[];for(const id of ids){const r=await getRoute(env,id);if(r)routes.push({id:r.id,name:r.name,status:r.status||"active",driverUserId:r.driverUserId||null,deliveryUserId:r.deliveryUserId||null})}return json({success:true,routes})}
export async function onRequestPost({request,env}){const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);if(user.role!=="admin")return json({success:false,error:"无权限"},403);const input=await body(request);const name=cleanRouteName(input.name);if(!name)return json({success:false,error:"请输入线路名称"},400);const id=routeId(),now=new Date().toISOString();
const route={id,name,status:"active",driverUserId:null,deliveryUserId:null,createdAt:now};
const routeKey="zp:route:"+id,baseKey="zp:route:"+id+":base",indexKey="zp:routes:index";
const script="local raw=redis.call('GET',KEYS[1]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if ok and type(v)=='table' then ids=v end end; for _,rid in ipairs(ids) do local rr=redis.call('GET','zp:route:'..rid); if rr then local ok,r=pcall(cjson.decode,rr); if ok and string.lower(tostring(r.name or ''))==string.lower(ARGV[2]) then return 2 end end end; redis.call('SET',KEYS[2],ARGV[1]); redis.call('SET',KEYS[3],ARGV[3]); table.insert(ids,ARGV[4]); redis.call('SET',KEYS[1],cjson.encode(ids)); return 1";
const base={routeId:id,version:1,updatedAt:now,updatedBy:user.id,stores:[]};
const code=Number(await command(env,["EVAL",script,"3",indexKey,routeKey,baseKey,JSON.stringify(route),name,JSON.stringify(base),id]));
if(code===2)return json({success:false,error:"线路已存在"},409);
if(code!==1)return json({success:false,code:"ROUTE_CREATE_FAILED",error:"线路创建失败，请稍后重试"},500);
return json({success:true,route})}
