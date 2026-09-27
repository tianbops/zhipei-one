const clean=v=>String(v??"").trim();

export const normalizeStoreName=v=>{
  let s=clean(v);
  try{s=s.normalize("NFKC")}catch{}
  return s
    .replace(/[\p{Z}\p{Cf}\p{P}\p{S}]+/gu,"")
    .replace(/Ⅱl|Il|II|ⅱ/gi,"II")
    .toLowerCase();
};

export const correctionKey=v=>
  normalizeStoreName(v).replace(/(?:jm|a|q)\d{3,12}/gi,"");

export const businessStoreCode=v=>{
  const m=clean(v).match(/(?:^|[^A-Z0-9])(JM|A|Q)[-_ ]?(\d{3,12})(?=$|[^A-Z0-9])/i);
  return m?(m[1]+m[2]).toUpperCase():null;
};

const identityFields=s=>[
  s?.name,
  s?.originalName,
  ...(Array.isArray(s?.aliases)?s.aliases:[])
].map(clean).filter(Boolean);

const similarity=(a,b)=>{
  const x=normalizeStoreName(a),y=normalizeStoreName(b);
  if(!x||!y)return 0;
  if(x===y)return 1;
  if(x.includes(y)||y.includes(x))return Math.min(x.length,y.length)/Math.max(x.length,y.length);
  const sx=new Set([...x]),sy=new Set([...y]);
  let common=0;
  for(const c of sx)if(sy.has(c))common++;
  return common/(new Set([...sx,...sy]).size||1);
};

export function matchStores(items,baseStores){
  const byId=new Map();
  const byCode=new Map();
  const byName=new Map();

  for(const store of Array.isArray(baseStores)?baseStores:[]){
    const id=clean(store?.storeId);
    if(id)byId.set(id,store);

    for(const field of identityFields(store)){
      const key=normalizeStoreName(field);
      if(!key)continue;
      const current=byName.get(key);
      byName.set(key,current&&current.storeId!==store.storeId?null:store);
    }

    for(const field of [store?.storeId,store?.name,store?.originalName,...(Array.isArray(store?.aliases)?store.aliases:[])]){
      const code=businessStoreCode(field);
      if(!code)continue;
      const current=byCode.get(code);
      byCode.set(code,current&&current.storeId!==store.storeId?null:store);
    }
  }

  return (items||[]).map((item,index)=>{
    const rawName=clean(item?.rawName||item?.name);
    const incomingId=clean(item?.storeId);
    const incomingCode=businessStoreCode(rawName)||businessStoreCode(item?.name)||businessStoreCode(incomingId);
    let target=null;
    let method=null;

    if(incomingId) {
      target=byId.get(incomingId)||null;
      if(target)method="identity";
    }

    if(!target&&incomingCode){
      target=byCode.get(incomingCode)||null;
      if(target)method="identity-code";
    }

    if(!target){
      const key=normalizeStoreName(rawName);
      const exact=byName.get(key)||null;
      if(exact){
        const candidateCode=businessStoreCode(exact.name)||businessStoreCode(exact.originalName);
        if(!incomingCode||!candidateCode||candidateCode===incomingCode){
          target=exact;
          method="exact";
        }
      }
    }

    let candidates=[];
    if(!target){
      candidates=baseStores.map(store=>{
        const candidateCode=businessStoreCode(store?.name)||businessStoreCode(store?.originalName);
        if(incomingCode&&candidateCode&&incomingCode!==candidateCode)return null;
        const score=Math.max(...identityFields(store).map(field=>similarity(rawName,field)),0);
        return {store,score};
      }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,5);
      const best=candidates[0];
      const second=candidates[1]?.score||0;
      if(best&&best.score>=0.86&&best.score-second>=0.08){
        target=best.store;
        method="similarity";
        candidates=[];
      }
    }

    if(!target){
      return {
        ...item,
        rawName,
        name:rawName,
        storeId:null,
        routeOrder:100000+index,
        matchStatus:"pending",
        matchMethod:null,
        correction:false,
        pending:true,
        candidates:candidates.map(x=>({
          storeId:clean(x.store?.storeId),
          name:clean(x.store?.name||x.store?.originalName),
          score:Number(x.score.toFixed(3))
        })),
        matchDiagnostics:{
          baseStoreCount:Array.isArray(baseStores)?baseStores.length:0,
          normalizedName:normalizeStoreName(rawName)
        }
      };
    }

    const standard=clean(target.name)||rawName;
    return {
      ...item,
      rawName,
      storeId:clean(target.storeId),
      name:standard,
      originalName:clean(target.originalName)||rawName,
      routeOrder:Number(target.routeOrder)||index+1,
      matchStatus:"matched",
      matchMethod:method,
      correction:correctionKey(rawName)!==correctionKey(standard),
      pending:false,
      candidates:[]
    };
  });
}
