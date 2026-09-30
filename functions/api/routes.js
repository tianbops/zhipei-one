import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,set,newId,command} from "./_redis.js";
import {getRoute,saveRoute,routeId,cleanRouteName} from "./_route.js";
async function list(env){const raw=await get(env,"routes:index");if(!raw)return [];try{const v=typeof raw==="string"?JSON.parse(raw):raw;if(!Array.isArray(v))throw new Error("INVALID_INDEX");return v}catch{throw Object.assign(new Error("ROUTES_INDEX_INVALID"),{code:"ROUTES_INDEX_INVALID"})}}
async function writeList(env,items){return set(env,"routes:index",items)}
async function cleanupRouteRequests(env,routeId){let removed=0;for(let attempt=0;attempt<3;attempt++){const raw=await get(env,"route-requests:index");if(!raw)return removed;let ids;try{ids=typeof raw==="string"?JSON.parse(raw):raw}catch{return removed}if(!Array.isArray(ids)||ids.some(x=>typeof x!=="string"||!x.trim()))return removed;const keep=[];const deleteKeys=[];for(const rid of ids){const item=await get(env,"route-request:"+rid);let q=null;try{q=typeof item==="string"?JSON.parse(item):item}catch{}if(q?.routeId===routeId){deleteKeys.push("zp:route-request:"+rid);removed++;}else keep.push(rid)}if(deleteKeys.length)await command(env,["DEL",...deleteKeys]);const ok=await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then redis.call("SET",KEYS[1],ARGV[2]); return 1 end; return 0',"1","zp:route-requests:index",String(raw),JSON.stringify(keep)]);if(Number(ok)===1)return removed}return removed}
async function cleanupRouteWaybills(env,routeId){
 let cursor="0",deleted=0,ids=[];
 do{
  const s=await command(env,["SCAN",cursor,"MATCH","zp:waybill:*","COUNT","200"]);
  cursor=String(s?.[0]??"0");
  for(const key of Array.isArray(s?.[1])?s[1]:[]){
   const k=String(key);
   if(!k.startsWith("zp:waybill:"))continue;
   const id=k.slice("zp:waybill:".length);
   if(!id||id.includes(":"))continue;
   const raw=await get(env,"waybill:"+id);
   let w=null;try{w=typeof raw==="string"?JSON.parse(raw):raw}catch{}
   if(w?.routeId===routeId)ids.push(id);
  }
 }while(cursor!=="0");
 ids=[...new Set(ids)];
 for(const id of ids){
  const keys=["zp:waybill:"+id];
  let c2="0";
  do{
   const s=await command(env,["SCAN",c2,"MATCH","zp:waybill:"+id+":*","COUNT","100"]);
   c2=String(s?.[0]??"0");
   if(Array.isArray(s?.[1]))keys.push(...s[1]);
  }while(c2!=="0");
  const unique=[...new Set(keys)];
  if(unique.length){await command(env,["DEL",...unique]);deleted+=unique.length}
 }
 return deleted;
}

export async function onRequestGet({request,env}){const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);let ids;try{ids=await list(env)}catch{return json({success:false,code:"ROUTES_INDEX_INVALID",error:"线路索引数据异常，请联系管理员处理"},409)}const routes=[];for(const id of ids){if(typeof id!=="string"||!id.trim())return json({success:false,code:"ROUTE_DATA_INVALID",error:"线路索引包含无效数据，请联系管理员处理"},409);const r=await getRoute(env,id);if(!r||r.id!==id||typeof r.name!=="string"||!r.name.trim()||!["active","disabled"].includes(r.status||"active"))return json({success:false,code:"ROUTE_DATA_INVALID",error:"线路数据异常，请联系管理员处理"},409);if(r.driverUserId!=null&&typeof r.driverUserId!=="string")return json({success:false,code:"ROUTE_DATA_INVALID",error:"线路岗位数据异常，请联系管理员处理"},409);if(r.deliveryUserId!=null&&typeof r.deliveryUserId!=="string")return json({success:false,code:"ROUTE_DATA_INVALID",error:"线路岗位数据异常，请联系管理员处理"},409);for(const slot of [["driver",r.driverUserId],["delivery",r.deliveryUserId]]){if(slot[1]){const rawUser=await get(env,"user:"+slot[1]);let linked=null;try{linked=typeof rawUser==="string"?JSON.parse(rawUser):rawUser}catch{}if(!linked||linked.id!==slot[1]||linked.role==="admin"||linked.disabled===true||linked.boundRouteId!==r.id||linked.routeDuty!==slot[0])return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"线路岗位与用户绑定数据不一致，请联系管理员处理"},409)}}const baseRaw=await get(env,"route:"+r.id+":base");let storeCount=0;try{const b=baseRaw?(typeof baseRaw==="string"?JSON.parse(baseRaw):baseRaw):null;storeCount=Array.isArray(b?.stores)?b.stores.length:0}catch{}routes.push({id:r.id,name:r.name,status:r.status||"active",driverUserId:r.driverUserId||null,deliveryUserId:r.deliveryUserId||null,storeCount})}return json({success:true,routes})}
export async function onRequestPost({request,env}){const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);if(user.role!=="admin")return json({success:false,error:"无权限"},403);const input=await body(request);if(input.action==="delete"){const rid=String(input.routeId||"").trim();if(!rid)return json({success:false,error:"线路不存在"},404);const raw=await get(env,"route:"+rid);if(!raw)return json({success:false,error:"线路不存在"},404);let x;try{x=typeof raw==="string"?JSON.parse(raw):raw}catch{return json({success:false,code:"ROUTE_DATA_INVALID",error:"线路数据异常，无法安全删除"},409)}if(x.id!==rid)return json({success:false,code:"ROUTE_DATA_INVALID",error:"线路数据异常，无法安全删除"},409);let routeIds;try{routeIds=await list(env)}catch{return json({success:false,code:"ROUTES_INDEX_INVALID",error:"线路索引数据异常，请先修复后再删除"},409)}if(!routeIds.includes(rid))return json({success:false,code:"ROUTE_INDEX_MISSING",error:"线路索引中不存在该线路，请先修复数据后再删除"},409);const bound=[];for(const [duty,uid] of [["driver",x.driverUserId],["delivery",x.deliveryUserId]]){if(!uid)continue;const ur=await get(env,"user:"+uid);if(!ur)return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"线路绑定用户不存在，无法安全删除"},409);let z;try{z=typeof ur==="string"?JSON.parse(ur):ur}catch{return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"线路绑定用户数据异常，无法安全删除"},409)}if(z.id!==uid||z.disabled===true||z.boundRouteId!==rid||z.routeDuty!==duty)return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"线路与用户绑定数据不一致，无法安全删除"},409);bound.push({duty,id:uid,user:z})}const requestRaw=await get(env,"route-requests:index");let requestIds=[];if(requestRaw){try{const v=typeof requestRaw==="string"?JSON.parse(requestRaw):requestRaw;if(!Array.isArray(v)||v.some(id=>typeof id!=="string"||!id.trim()))throw 0;requestIds=v}catch{return json({success:false,code:"ROUTE_REQUEST_INDEX_INVALID",error:"线路申请索引数据异常，请先修复后再删除线路"},409)}}const keys=["zp:route:"+rid,"zp:routes:index",...bound.map(v=>"zp:user:"+v.id)];const args=[rid,JSON.stringify(routeIds.filter(v=>v!==rid)),...bound.map(v=>v.id),...bound.map(v=>JSON.stringify({...v.user,boundRouteId:null,routeDuty:null,sessionVersion:(v.user.sessionVersion??1)+1}))];let script="local rr=redis.call('GET',KEYS[1]); local ri=redis.call('GET',KEYS[2]); if not rr or not ri then return 2 end; local r=cjson.decode(rr); local ids=cjson.decode(ri); if r.id~=ARGV[1] or type(ids)~='table' then return 3 end;";for(let i=0;i<bound.length;i++){const k=3+i;const uidArg=2+i;const jsonArg=2+bound.length+i;script+=`local raw${i}=redis.call('GET',KEYS[${k}]); if not raw${i} then return 4 end; local ok${i},u${i}=pcall(cjson.decode,raw${i}); if not ok${i} or type(u${i})~='table' or u${i}.id~=ARGV[${uidArg}] or u${i}.boundRouteId~=ARGV[1] or u${i}.routeDuty~=ARGV[${2+bound.length+i}] then return 5 end; `}script+=`redis.call('SET',KEYS[2],ARGV[2]);`;for(let i=0;i<bound.length;i++)script+=`redis.call('SET',KEYS[${3+i}],ARGV[${2+2*bound.length+i}]);`;script+="redis.call('DEL',KEYS[1]); return 1";
const code=Number(await command(env,["EVAL",script,String(keys.length),...keys,...args]));if(code!==1)return json({success:false,error:"线路状态已变化，请刷新后重试"},409);const requestDeleted=await cleanupRouteRequests(env,rid);const waybillDeleted=await cleanupRouteWaybills(env,rid);let c="0",deleted=0;do{const s=await command(env,["SCAN",c,"MATCH","zp:route:"+rid+"*","COUNT","200"]);c=String(s?.[0]??"0");if(s?.[1]?.length){await command(env,["DEL",...s[1]]);deleted+=s[1].length}}while(c!=="0");return json({success:true,deleted,requestDeleted,waybillDeleted})}
const name=cleanRouteName(input.name);if(!name)return json({success:false,error:"请输入线路名称"},400);const id=routeId(),now=new Date().toISOString();
const route={id,name,status:"active",driverUserId:null,deliveryUserId:null,createdAt:now};
const routeKey="zp:route:"+id,baseKey="zp:route:"+id+":base",indexKey="zp:routes:index";
const script="local raw=redis.call('GET',KEYS[1]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if not ok or type(v)~='table' then return 4 end; ids=v end; for _,rid in ipairs(ids) do local rr=redis.call('GET','zp:route:'..rid); if rr then local ok,r=pcall(cjson.decode,rr); if ok and string.lower(tostring(r.name or ''))==string.lower(ARGV[2]) then return 2 end end end; redis.call('SET',KEYS[2],ARGV[1]); redis.call('SET',KEYS[3],ARGV[3]); table.insert(ids,ARGV[4]); redis.call('SET',KEYS[1],cjson.encode(ids)); return 1";
const base={routeId:id,version:1,updatedAt:now,updatedBy:user.id,stores:[]};
const code=Number(await command(env,["EVAL",script,"3",indexKey,routeKey,baseKey,JSON.stringify(route),name,JSON.stringify(base),id]));
if(code===2)return json({success:false,error:"线路已存在"},409);if(code===4)return json({success:false,code:"ROUTES_INDEX_INVALID",error:"线路索引数据异常，请联系管理员处理"},409);
if(code!==1)return json({success:false,code:"ROUTE_CREATE_FAILED",error:"线路创建失败，请稍后重试"},500);
return json({success:true,route})}
