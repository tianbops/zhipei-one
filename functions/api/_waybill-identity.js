const clean=v=>String(v??"").trim();

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
  const data=new TextEncoder().encode(canonicalString(input));
  const digest=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
