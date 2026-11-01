/**
 * 智配One · 运单处理 —— 匹配后处理族
 * ----------------------------------------------------------
 * 本文件由 process.js 按职责拆分而来（P1-1g，零改写）。
 * 依赖：_store-match.js（匹配引擎，对外契约不可篡改）。
 * 纪律：dedupe 的身份占用保护（不同识别项争用同一 storeId 不吞店）、
 *   plan 的 routeOrder 全排序（tie 用名称 localeCompare）均为基准顺序契约。
 */

import {clean,formatCompareKey,matchStores,createMatchIndex} from "./_store-match.js";
import {number} from "./_process-common.js";

export function baseIdentityNames(store){
  return [store?.name,store?.originalName,...(Array.isArray(store?.aliases)?store.aliases:[])]
    .map(v=>clean(v).split('•')[0].split('·')[0].trim()).filter(v=>v.length>=2);
}

const ROUTE_BASE_INDEX_KIND="zp-route-base-match-index";
const ROUTE_BASE_INDEX_CACHE=new Map();
const ROUTE_BASE_INDEX_CACHE_MAX=16;

/** Compile route-base identity keys and the store matcher once per versioned snapshot. */
export function createRouteBaseIndex(baseStores){
  const stores=Array.isArray(baseStores)?baseStores:[];
  const knownKeys=new Set();
  const unique=new Map();
  for(const store of stores){
    for(const name of baseIdentityNames(store)){
      const key=formatCompareKey(name);
      if(key)knownKeys.add(key);
      if(key.length<4)continue;
      const id=clean(store?.storeId)||key;
      const old=unique.get(id);
      if(!old||key.length>old.key.length)unique.set(id,{store,name,key});
    }
  }
  return {
    kind:ROUTE_BASE_INDEX_KIND,
    stores,
    knownKeys,
    segmentEntries:[...unique.values()],
    matchIndex:createMatchIndex(stores)
  };
}

/** Isolate-local LRU cache. Never stores global-learning records; max 16 route-base versions. */
export function getCachedRouteBaseIndex(userId,routeId,baseVersion,baseStores){
  const version=Number(baseVersion);
  if(!clean(userId)||!clean(routeId)||!Number.isSafeInteger(version)||version<1){
    return createRouteBaseIndex(baseStores);
  }
  const key=JSON.stringify([clean(userId),clean(routeId),version]);
  if(ROUTE_BASE_INDEX_CACHE.has(key)){
    const hit=ROUTE_BASE_INDEX_CACHE.get(key);
    ROUTE_BASE_INDEX_CACHE.delete(key);
    ROUTE_BASE_INDEX_CACHE.set(key,hit);
    return hit;
  }
  const index=createRouteBaseIndex(baseStores);
  ROUTE_BASE_INDEX_CACHE.set(key,index);
  while(ROUTE_BASE_INDEX_CACHE.size>ROUTE_BASE_INDEX_CACHE_MAX){
    ROUTE_BASE_INDEX_CACHE.delete(ROUTE_BASE_INDEX_CACHE.keys().next().value);
  }
  return index;
}

export function splitByRouteBase(items,baseStoresOrIndex){
  const index=baseStoresOrIndex?.kind===ROUTE_BASE_INDEX_KIND
    ?baseStoresOrIndex
    :createRouteBaseIndex(baseStoresOrIndex);
  if(!index.stores.length)return items;
  return items.flatMap(item=>{
    const rawName=clean(item?.rawName||item?.name);
    const rawKey=formatCompareKey(rawName);
    const hits=[];
    for(const entry of index.segmentEntries){
      const pos=rawKey.indexOf(entry.key);
      if(pos>=0)hits.push({...entry,pos});
    }
    const candidates=[...hits].sort((a,b)=>b.key.length-a.key.length||a.pos-b.pos);
    const selected=[];
    for(const candidate of candidates){
      const start=candidate.pos;
      const end=start+candidate.key.length;
      const overlaps=selected.some(hit=>{
        const hitStart=hit.pos;
        const hitEnd=hitStart+hit.key.length;
        return start<hitEnd&&hitStart<end;
      });
      if(!overlaps)selected.push(candidate);
    }
    selected.sort((a,b)=>a.pos-b.pos||b.key.length-a.key.length);
    if(selected.length<2)return [item];
    return selected.map((hit,index)=>({...item,rawName:hit.name,name:hit.name,storeId:clean(hit.store?.storeId)||null,extractionMethod:"route-base-segment",extractionSegment:index+1,extractionSegments:selected.length}));
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
  const removeDuplicate=(s,previous)=>{
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
  };
  for(const s of items){
    // 门店身份判断必须优先使用“原始识别名”。
    // matchStores / global learning 会把 name 标准化为基准库名称；
    // 如果这里再用 name 判断，不同 OCR 门店被错误映射到同一 storeId 后
    // 会被误认为“同名重复”并直接吞店。
    const identityKey=formatCompareKey(s.rawName||s.name);
    const displayName=clean(s.name||s.rawName);
    const key=s.storeId?"id:"+s.storeId:"pending:"+identityKey;
    const previous=seen.get(key);
    if(previous){
      if(!s.storeId){
        // 待确认门店只合并归一化后完全相同的识别名；不做模糊合并。
        removeDuplicate(s,previous);
        continue;
      }
      const previousIdentity=formatCompareKey(previous.rawName||previous.name);
      if(previousIdentity===identityKey){
        removeDuplicate(s,previous);
        continue;
      }
      // 不同识别项争用同一 storeId：安全转待定，保留真实条目并要求人工确认。
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
      const pendingKey="pending:"+formatCompareKey(pending.rawName||pending.name);
      const existingPending=seen.get(pendingKey);
      if(existingPending){
        removeDuplicate(pending,existingPending);
      }else{
        seen.set(pendingKey,pending);
        out.push(pending);
      }
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
