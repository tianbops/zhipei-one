/**
 * 智配One · 运单处理 —— 匹配后处理族
 * ----------------------------------------------------------
 * 本文件由 process.js 按职责拆分而来（P1-1g，零改写）。
 * 依赖：_store-match.js（匹配引擎，对外契约不可篡改）。
 * 纪律：dedupe 的身份占用保护（不同识别项争用同一 storeId 不吞店）、
 *   plan 的 routeOrder 全排序（tie 用名称 localeCompare）均为基准顺序契约。
 */

import {clean,formatCompareKey,matchStores} from "./_store-match.js";
import {number} from "./_process-common.js";

export function baseIdentityNames(store){
  return [store?.name,store?.originalName,...(Array.isArray(store?.aliases)?store.aliases:[])]
    .map(v=>clean(v).split('•')[0].split('·')[0].trim()).filter(v=>v.length>=2);
}

export function splitByRouteBase(items,baseStores){
  const bases=Array.isArray(baseStores)?baseStores:[];
  if(!bases.length)return items;
  return items.flatMap(item=>{
    const rawName=clean(item?.rawName||item?.name);
    const rawKey=formatCompareKey(rawName);
    const hits=[];
    for(const store of bases){
      for(const name of baseIdentityNames(store)){
        const key=formatCompareKey(name);
        if(key.length>=4&&rawKey.includes(key))hits.push({store,name,key,pos:rawKey.indexOf(key)});
      }
    }
    const unique=new Map();
    for(const hit of hits){const id=clean(hit.store?.storeId)||hit.key;const old=unique.get(id);if(!old||hit.key.length>old.key.length)unique.set(id,hit);}
    const candidates=[...unique.values()].sort((a,b)=>b.key.length-a.key.length||a.pos-b.pos);
    const selected=[];
    for(const candidate of candidates){
      const start=candidate.pos;
      const end=start+candidate.key.length;
      const overlaps=selected.some(hit=>{
        const hitStart=hit.pos;
        const hitEnd=hitStart+hit.key.length;
        return start< hitEnd && hitStart<end;
      });
      if(!overlaps)selected.push(candidate);
    }
    selected.sort((a,b)=>a.pos-b.pos||b.key.length-a.key.length);
    if(selected.length<2)return [item];
    return selected.map((hit,index)=>({...item,rawName:hit.name,name:hit.name,storeId:clean(hit.store?.storeId)||null,extractionMethod:'route-base-segment',extractionSegment:index+1,extractionSegments:selected.length}));
  });
}

export function validateResult(order){
  const errors=[];
  if(!order.date)errors.push("缺少运单日期");
  if(!order.vehicle)errors.push("缺少车辆信息");
  if(!Array.isArray(order.stores)||!order.stores.length)errors.push("没有规划门店");
  const seen=new Set();const seenOrders=new Set();for(const s of order.stores||[]){const k=s.storeId?"id:"+s.storeId:"pending:"+formatCompareKey(s.rawName);if(seen.has(k))errors.push("规划结果存在重复门店");seen.add(k);const ro=number(s.routeOrder);if(ro==null||ro<1||!Number.isInteger(ro))errors.push("规划结果存在无效线路顺序");else if(seenOrders.has(ro))errors.push("规划结果存在重复线路顺序");else seenOrders.add(ro)}
  if((order.stores||[]).some((s,i)=>s.routeOrder!==i+1))errors.push("线路顺序不连续");
  return {valid:errors.length===0,errors};
}
export function dedupe(items){
  const seen=new Map(),out=[],conflicts=[],removed=[];
  let merged=0;
  for(const s of items){
    // 门店身份判断必须优先使用“原始识别名”。
    // matchStores / global learning 会把 name 标准化为基准库名称；
    // 如果这里再用 name 判断，不同 OCR 门店被错误映射到同一 storeId 后
    // 会被误认为“同名重复”并直接吞掉。
    const identityKey=formatCompareKey(s.rawName||s.name);
    const displayName=clean(s.name||s.rawName);
    let key=s.storeId?"id:"+s.storeId:"pending:"+identityKey;
    if(s.storeId&&seen.has(key)){
      const previous=seen.get(key);
      const previousIdentity=formatCompareKey(previous.rawName||previous.name);
      if(previousIdentity!==identityKey){
        // 不再把冲突项留在 matched/storeId 状态；安全转待定，
        // 让最终数量保留，并要求人工确认真实门店。
        conflicts.push({
          storeId:s.storeId,
          firstName:previous.rawName||previous.name,
          conflictName:s.rawName||s.name,
        });
        const pending={
          ...s,
          storeId:null,
          name:clean(s.rawName||s.name),
          originalName:clean(s.rawName||s.name),
          pending:true,
          matchStatus:"pending",
          matchMethod:null,
          correction:false,
          candidates:[{
            storeId:s.storeId,
            name:displayName,
            reason:"同一运单中不同识别项指向同一门店，存在身份冲突",
          }],
          matchConfidence:{
            level:"PENDING",
            reason:"STORE_ID_COLLISION",
            score:null,
            candidateCount:1,
            topScore:null,
            secondScore:null,
            scoreGap:null,
          },
          matchDiagnostics:{
            ...(s.matchDiagnostics||{}),
            reason:"STORE_ID_COLLISION",
            storeId:s.storeId,
            previousRawName:previous.rawName||previous.name,
          },
        };
        out.push(pending);
        continue;
      }
      merged++;
      removed.push({
        rawName:s.rawName,
        name:s.name,
        storeId:s.storeId||null,
        mergedInto:{
          rawName:previous.rawName,
          name:previous.name,
          storeId:previous.storeId||null,
        },
      });
      continue;
    }
    seen.set(key,s);
    out.push(s);
  }
  return{items:out,merged,conflicts,removed};
}
export function plan(items,useRouteOrder=true){const list=useRouteOrder?[...items].sort((a,b)=>(number(a.routeOrder)??100000)-(number(b.routeOrder)??100000)||formatCompareKey(a.name).localeCompare(formatCompareKey(b.name),"zh-CN")):[...items];return list.map((s,i)=>({...s,routeOrder:i+1}))}

/**
 * 记录运单生命周期事件链（append-only，best-effort）。
 * 仅用于运维追溯，失败不影响主保存流程。
 */
