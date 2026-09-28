import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,set,newId,command} from "./_redis.js";
import {getRoute,saveRoute,routeId,cleanRouteName} from "./_route.js";
async function list(env){const raw=await get(env,"routes:index");if(!raw)return [];try{const v=typeof raw==="string"?JSON.parse(raw):raw;if(!Array.isArray(v))throw new Error("INVALID_INDEX");return v}catch{throw Object.assign(new Error("ROUTES_INDEX_INVALID"),{code:"ROUTES_INDEX_INVALID"})}}
async function writeList(env,items){return set(env,"routes:index",items)}
export async function onRequestGet({request,env}){const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);let ids;try{ids=await list(env)}catch{return json({success:false,code:"ROUTES_INDEX_INVALID",error:"线路索引数据异常，请联系管理员处理"},409)}const routes=[];for(const id of ids){const r=await getRoute(env,id);if(r)routes.push({id:r.id,name:r.name,status:r.status||"active",driverUserId:r.driverUserId||null,deliveryUserId:r.deliveryUserId||null})}return json({success:true,routes})}
export async function onRequestPost({request,env}){const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);if(user.role!=="admin")return json({success:false,error:"无权限"},403);const input=await body(request);const name=cleanRouteName(input.name);if(!name)return json({success:false,error:"请输入线路名称"},400);const id=routeId(),now=new Date().toISOString();
const route={id,name,status:"active",driverUserId:null,deliveryUserId:null,createdAt:now};
const routeKey="zp:route:"+id,baseKey="zp:route:"+id+":base",indexKey="zp:routes:index";
const script="local raw=redis.call('GET',KEYS[1]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if not ok or type(v)~='table' then return 4 end; ids=v end; for _,rid in ipairs(ids) do local rr=redis.call('GET','zp:route:'..rid); if rr then local ok,r=pcall(cjson.decode,rr); if ok and string.lower(tostring(r.name or ''))==string.lower(ARGV[2]) then return 2 end end end; redis.call('SET',KEYS[2],ARGV[1]); redis.call('SET',KEYS[3],ARGV[3]); table.insert(ids,ARGV[4]); redis.call('SET',KEYS[1],cjson.encode(ids)); return 1";
const base={routeId:id,version:1,updatedAt:now,updatedBy:user.id,stores:[]};
const code=Number(await command(env,["EVAL",script,"3",indexKey,routeKey,baseKey,JSON.stringify(route),name,JSON.stringify(base),id]));
if(code===2)return json({success:false,error:"线路已存在"},409);if(code===4)return json({success:false,code:"ROUTES_INDEX_INVALID",error:"线路索引数据异常，请联系管理员处理"},409);
if(code!==1)return json({success:false,code:"ROUTE_CREATE_FAILED",error:"线路创建失败，请稍后重试"},500);
return json({success:true,route})}
