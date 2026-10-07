import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {resolveGlobalConflict,listGlobalConflicts,isolateGlobalRecord,restoreGlobalRecord} from "../_global-learning.js";
import {isSystemAdmin} from "../_permissions.js";
import {command} from "../_redis.js";
import {Budget,hscanBudgeted,SUBREQUEST_LIMIT} from "../_redis-budget.js";

/** 列出被隔离（QUARANTINED）的全局学习记录，供管理员人工处理。 */
async function listQuarantined(env,{limit=100}={}){
 const size=Math.min(200,Math.max(1,Number(limit)||100));
 // P1-05 收口：原为裸 HSCAN + do{...}while(true)，无预算上限 → 记录量大时越过平台子请求硬限。
 const budget=new Budget(SUBREQUEST_LIMIT);
 const {entries,complete}=await hscanBudgeted(env,"zp:global:learning:records",budget,{count:200});
 const out=[];
 for(const [,raw]of entries){const rec=JSON.parse(raw||"null");if(rec&&rec.status==="QUARANTINED")out.push(rec);if(out.length>=size)break}
 out.sort((a,b)=>String(b.quarantinedAt||b.updatedAt||"").localeCompare(String(a.quarantinedAt||a.updatedAt||"")));
 return{records:out,count:out.length,partial:!complete};
}

export async function onRequestGet({request,env}){
 const actor=await currentUser(request,env);
 if(!isSystemAdmin(actor))return json({success:false,error:"无权限"},403);
 const url=new URL(request.url);
 const action=String(url.searchParams.get("action")||"").trim();
 try{
  if(action==="quarantined")return json({success:true,...await listQuarantined(env,{limit:Number(url.searchParams.get("limit")||"100")})});
  const limit=Math.min(200,Math.max(1,Number(url.searchParams.get("limit")||"100")));
  const cursor=String(url.searchParams.get("cursor")||"0");
  const result=await listGlobalConflicts(env,{limit,cursor});
  return json({success:true,...result});
 }catch(e){
  return json({success:false,code:"GLOBAL_LEARNING_LIST_FAILED",error:"全局学习读取失败"},500);
 }
}

export async function onRequestPost({request,env}){
 const actor=await currentUser(request,env);
 if(!isSystemAdmin(actor))return json({success:false,error:"无权限"},403);
 const input=await body(request);
 const action=String(input.action||"").trim();
 const storeId=String(input.storeId||"").trim();
 if(!storeId)return json({success:false,code:"GLOBAL_STORE_ID_REQUIRED",error:"请提供门店ID"},400);
 try{
  if(action==="isolate"){
   const r=await isolateGlobalRecord(env,{storeId,userId:actor.id,reason:String(input.reason||"").trim()});
   if(!r.isolated)return json({success:false,code:r.code||"GLOBAL_ISOLATE_REJECTED",record:r.record||null},409);
   return json({success:true,action:"isolate",record:r.record,event:r.event,version:r.version});
  }
  if(action==="restore"){
   const r=await restoreGlobalRecord(env,{storeId,userId:actor.id});
   if(!r.restored)return json({success:false,code:r.code||"GLOBAL_RESTORE_REJECTED",record:r.record||null},409);
   return json({success:true,action:"restore",record:r.record,event:r.event,version:r.version});
  }
  const standardName=String(input.standardName||"").trim();
  if(!standardName)return json({success:false,code:"GLOBAL_CONFLICT_RESOLUTION_INPUT_INVALID",error:"请提供门店ID和确认后的标准名称"},400);
  const result=await resolveGlobalConflict(env,{storeId,standardName,userId:actor.id});
  if(!result.resolved)return json({success:false,code:result.code||"GLOBAL_CONFLICT_RESOLUTION_REJECTED",storeIds:result.storeIds||[]},409);
  return json({success:true,record:result.record,event:result.event,version:result.version});
 }catch(e){
  const code=String(e?.message||"");
  if(code==="GLOBAL_LEARNING_BUSY")return json({success:false,code,error:"全局学习正在更新，请稍后重试"},409);
  if(code==="GLOBAL_ALIAS_DATA_INVALID")return json({success:false,code,error:"全局学习别名数据异常，请先修复数据"},409);
  if(code==="GLOBAL_CONFLICT_RESOLUTION_INPUT_INVALID")return json({success:false,code,error:"冲突恢复参数无效"},400);
  return json({success:false,code:"GLOBAL_LEARNING_ACTION_FAILED",error:"全局学习操作失败"},500);
 }
}
