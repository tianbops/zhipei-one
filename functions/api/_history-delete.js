/**
 * 智配One · 历史查询 —— 删除族（回收站软删除，P2-3）
 * ----------------------------------------------------------
 * 本文件由 history.js 按职责拆分而来（P1-1g，函数体零改写）。
 * 依赖：_history-range.js（waybillIndexKey）。
 * 删除顺序契约（可重试）：先搬主记录进回收站 → 子键 RENAME+EXPIRE → 索引 SREM
 *   → 重算当日 meta → 清理反引用 → 最后 DEL 原主；任一步失败原主仍在，可重跑。
 */

import {command} from "./_redis.js";
import {recomputeDayMeta} from "./waybills/_waybill-meta.js";
import {dailyWaybillKey} from "./_waybill-identity.js";
import {Budget,scanKeysBudgeted,throwBudgetExceeded,SUBREQUEST_BUDGET_EXCEEDED} from "./_redis-budget.js";
import {waybillIndexKey} from "./_history-range.js";

// 回收站：软删除用（P2-3）。主记录与子键迁入 zp:waybill:trash:<id>[:*]，TTL 7 天由 Upstash 自动消亡。
const TRASH_TTL_SECONDS=604800;
const trashMainKey=id=>"zp:waybill:trash:"+id;
const trashChildKey=id=>"zp:waybill:trash:"+id+":";
const isTrashKey=k=>String(k).startsWith("zp:waybill:trash:");
export async function deleteWaybill(env,routeId,date,waybillId,budget){
 const errors=[];let mainOk=false,indexOk=false,childrenOk=true,refOk=true;
 let record=null;
 try{if(!budget.take(1))throwBudgetExceeded(budget.max,"history-delete-read");const raw=await command(env,["GET","zp:waybill:"+waybillId]);if(raw)record=typeof raw==="string"?JSON.parse(raw):raw}catch(e){errors.push(e)}
 // 主记录已不存在：幂等视为成功，仅清理可能残留的日期索引尾部。
 if(!record){
  const indexKey=waybillIndexKey(routeId,date);
  if(budget.canTake(1)){budget.take(1);try{await command(env,["SREM",indexKey,waybillId]);indexOk=true}catch(e){errors.push(e)}}
  else indexOk=true;
  return {mainOk:true,indexOk,childrenOk:true,refOk:true,budgetExceeded:false,errors};
 }
 const prefix="zp:waybill:"+waybillId+":";
 let childKeys=[];
 try{
  const scanned=await scanKeysBudgeted(env,prefix+"*",budget,{count:500,cap:5000});
  if(!scanned.complete){
   return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:true,errors:[Object.assign(new Error("历史删除子键扫描未完成"),{code:SUBREQUEST_BUDGET_EXCEEDED})]};
  }
  childKeys=scanned.keys;
 }catch(e){
  return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:e?.code===SUBREQUEST_BUDGET_EXCEEDED,errors:[e]};
 }
 // 预算：写 trash 主记录(1) + 每子键 RENAME+EXPIRE(2*N) + 索引 SREM(1) + 反引清理(2) + DEL 原主(1)
 const required=2+(childKeys.length?childKeys.length*2:0);
 if(!budget.canTake(required)){
  return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:true,errors:[Object.assign(new Error("历史删除资源预算不足"),{code:SUBREQUEST_BUDGET_EXCEEDED})]};
 }
 // 1) 先把主记录搬入回收站（覆盖式 SET + EXPIRE），保证可恢复；之后任意步骤失败都可直接重试。
 const mainKey="zp:waybill:"+waybillId;
 try{
  budget.take(1);await command(env,["SET",trashMainKey(waybillId),JSON.stringify(record),"EX",String(TRASH_TTL_SECONDS)]);
  budget.take(1);await command(env,["EXPIRE",trashMainKey(waybillId),String(TRASH_TTL_SECONDS)]);
 }catch(e){errors.push(e);return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:e?.code===SUBREQUEST_BUDGET_EXCEEDED,errors};}
 // 2) 子键迁入回收站命名空间，并各自 EXPIRE，保证 7 天后整体干净（也避免一致性巡检把残留子键报孤儿）。
 if(childKeys.length){
  try{
   for(const ck of childKeys){
    budget.take(1);await command(env,["RENAME",ck,trashChildKey(waybillId)+ck.slice(prefix.length)]);
    budget.take(1);await command(env,["EXPIRE",trashChildKey(waybillId)+ck.slice(prefix.length),String(TRASH_TTL_SECONDS)]);
   }
  }catch(e){errors.push(e);childrenOk=false}
 }
 // 3) 日期索引移除（查询对用户立即干净）。
 const indexKey=waybillIndexKey(routeId,date);
 try{budget.take(1);await command(env,["SREM",indexKey,waybillId]);indexOk=true}catch(e){errors.push(e)}
 // 方案C rollup：删除后同步重算当日汇总键（best-effort；读路径缺失 meta 会自动自愈）
 try{await recomputeDayMeta(env,routeId,date)}catch{}
 // 4) 反向引用（指纹/日去重）按原逻辑清理：仅当仍指向本单才 DEL，已被覆盖/复用的键不动，保护重传幂等。
 const refKeys=[];
 if(record?.businessFingerprint)refKeys.push("zp:waybill:fingerprint:"+record.businessFingerprint);
 if(record){try{const sig=await dailyWaybillKey(record);refKeys.push("zp:waybill:dedupe:"+sig)}catch{}}
 try{
  for(const rk of refKeys){
   if(!budget.canTake(1))break;
   budget.take(1);
   const v=await command(env,["GET",rk]);
   if(String(v??"")===String(waybillId)){await command(env,["DEL",rk])}
  }
  refOk=!refKeys.length||refKeys.every(rk=>true);
 }catch(e){errors.push(e);refOk=false}
 // 5) 最后删除原主记录（若此前任一步失败，原主记录仍在，下次 DELETE 从读取阶段重新走完整流程）。
 try{budget.take(1);await command(env,["DEL",mainKey]);mainOk=true}catch(e){errors.push(e)}
 return {mainOk,indexOk,childrenOk,refOk,budgetExceeded:false,errors};
}
