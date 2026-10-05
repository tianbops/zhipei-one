const clean=v=>String(v??"").trim();

async function sha256Hex(data){
  const buf=await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

function stableStore(store){
  return {
    storeId:clean(store?.storeId)||null,
    name:clean(store?.name),
    routeOrder:Number.isFinite(Number(store?.routeOrder))?Number(store.routeOrder):null,
    pending:!!store?.pending
  };
}

function canonicalWaybill(input){
  const stores=Array.isArray(input?.stores)?input.stores.map(stableStore):[];
  return {
    routeId:clean(input?.routeId),
    date:clean(input?.date),
    vehicle:clean(input?.vehicle),
    totalWeight:input?.totalWeight==null?null:Number(input.totalWeight),
    stores
  };
}

function canonicalString(input){
  return JSON.stringify(canonicalWaybill(input));
}

export async function businessFingerprint(input){
  return sha256Hex(canonicalString(input));
}

// 当日业务去重签名：线路 + 日期 + 车辆 + 重量 + 门店名称(归一化排序) + 门店数量。
// 同一车辆当天多趟（门店/重量不同）→ 签名不同 → 视为不同运单，不会被误合并。
// 忽略 storeId / routeOrder / pending 等易变字段，使 PLANNED 与 CONFIRMED 同一趟也能命中。
// OCR 抖动导致的门店名微小差异仍可能绕过，故以「确认后标准化门店名」为准。
function dailySignature(input){
  const stores=Array.isArray(input?.stores)?input.stores:[];
  const names=stores.map(s=>clean(s?.name)).filter(Boolean).sort();
  return JSON.stringify({
    routeId:clean(input?.routeId),
    date:clean(input?.date),
    vehicle:clean(input?.vehicle),
    totalWeight:input?.totalWeight==null?null:Number(input.totalWeight),
    storeCount:names.length,
    storeNames:names
  });
}

export function dailyWaybillSignatureString(input){
  return dailySignature(input);
}

export async function dailyWaybillKey(input){
  return sha256Hex(dailySignature(input));
}
