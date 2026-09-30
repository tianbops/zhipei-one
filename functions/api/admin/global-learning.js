import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {resolveGlobalConflict,listGlobalConflicts} from "../_global-learning.js";

function admin(u){return u&&(u.role==="system_admin"||(u.role==="system_admin"||(u.role==="system_admin"||u.role==="admin")))}


export async function onRequestGet({request,env}){const actor=await currentUser(request,env);if(!admin(actor))return json({success:false,error:"无权限"},403);const url=new URL(request.url);const limit=Math.min(200,Math.max(1,Number(url.searchParams.get("limit")||"100")));const cursor=String(url.searchParams.get("cursor")||"0");try{const result=await listGlobalConflicts(env,{limit,cursor});return json({success:true,...result})}catch(e){return json({success:false,code:"GLOBAL_CONFLICT_LIST_FAILED",error:"全局学习冲突读取失败"},500)}}

export async function onRequestPost({request,env}){
 const actor=await currentUser(request,env);
 if(!admin(actor))return json({success:false,error:"无权限"},403);
 const input=await body(request);
 const storeId=String(input.storeId||"").trim();
 const standardName=String(input.standardName||"").trim();
 if(!storeId||!standardName)return json({success:false,code:"GLOBAL_CONFLICT_RESOLUTION_INPUT_INVALID",error:"请提供门店ID和确认后的标准名称"},400);
 try{
  const result=await resolveGlobalConflict(env,{storeId,standardName,userId:actor.id});
  if(!result.resolved)return json({success:false,code:result.code||"GLOBAL_CONFLICT_RESOLUTION_REJECTED",storeIds:result.storeIds||[]},409);
  return json({success:true,record:result.record,event:result.event,version:result.version});
 }catch(e){
  const code=String(e?.message||"");
  if(code==="GLOBAL_LEARNING_BUSY")return json({success:false,code,error:"全局学习正在更新，请稍后重试"},409);
  if(code==="GLOBAL_ALIAS_DATA_INVALID")return json({success:false,code,error:"全局学习别名数据异常，请先修复数据"},409);
  if(code==="GLOBAL_CONFLICT_RESOLUTION_INPUT_INVALID")return json({success:false,code,error:"冲突恢复参数无效"},400);
  return json({success:false,code:"GLOBAL_CONFLICT_RESOLUTION_FAILED",error:"全局学习冲突恢复失败"},500);
 }
}
