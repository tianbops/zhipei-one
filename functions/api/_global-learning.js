import {get,set,newId} from "./_redis.js";

const clean=v=>String(v??"").trim();
export const normalizeLearningName=v=>clean(v)
  .replace(/[\u3000\s]+/g,"")
  .replace(/[（）()【】\[\]{}<>《》“”"'‘’]/g,"")
  .replace(/[·•、,，。；;:：!！?？\-_—]/g,"")
  .replace(/Ⅱl|Il|II|ⅱ/gi,"II")
  .toLowerCase();

async function read(env){
  const raw=await get(env,"global:learning");
  if(!raw)return {schemaVersion:"1",version:1,records:{},aliases:{},events:[]};
  try{
    const x=typeof raw==="string"?JSON.parse(raw):raw;
    return {
      schemaVersion:"1",
      version:Number(x.version)||1,
      records:x.records&&typeof x.records==="object"?x.records:{},
      aliases:x.aliases&&typeof x.aliases==="object"?x.aliases:{},
      events:Array.isArray(x.events)?x.events.slice(-5000):[]
    };
  }catch{
    return {schemaVersion:"1",version:1,records:{},aliases:{},events:[]};
  }
}

function addAlias(index,key,storeId){
  if(!key||!storeId)return;
  const old=Array.isArray(index[key])?index[key]:[];
  if(!old.includes(storeId))index[key]=[...old,storeId];
}

function candidateFromRecord(record){
  return {
    storeId:record.storeId,
    name:record.standardName||"",
    originalName:record.originalName||record.standardName||"",
    aliases:Array.isArray(record.aliases)?record.aliases:[],
    navigation:record.navigation||null
  };
}

export async function findGlobalMatches(env,items){
  const data=await read(env);
  const out=[];
  for(const item of items){
    const rawName=clean(item.rawName||item.name);
    const key=normalizeLearningName(rawName);
    const ids=Array.isArray(data.aliases[key])?data.aliases[key]:[];
    let target=null,method=null;
    if(item.storeId&&data.records[item.storeId]){
      target=candidateFromRecord(data.records[item.storeId]);
      method="global-identity";
    }else if(ids.length===1&&data.records[ids[0]]){
      target=candidateFromRecord(data.records[ids[0]]);
      method="global-alias";
    }
    if(target){
      out.push({...item,storeId:target.storeId,name:target.name||rawName,originalName:target.originalName||rawName,globalMatchStatus:"matched",globalMatchMethod:method,pending:false});
    }else{
      out.push({...item,globalMatchStatus:"unresolved"});
    }
  }
  return out;
}

export async function learnGlobal(env,input){
  const storeId=clean(input.storeId);
  const rawName=clean(input.rawName||input.name);
  const standardName=clean(input.standardName||input.name||rawName);
  if(!storeId||!rawName||!standardName)throw new Error("GLOBAL_LEARNING_INPUT_INVALID");
  const data=await read(env);
  const current=data.records[storeId]||{
    storeId,
    standardName,
    originalName:clean(input.originalName||rawName),
    aliases:[],
    navigation:input.navigation||null,
    status:"CANDIDATE",
    confirmations:0,
    conflicts:0,
    createdAt:new Date().toISOString()
  };
  current.standardName=standardName||current.standardName;
  current.aliases=Array.isArray(current.aliases)?current.aliases:[];
  const nk=normalizeLearningName(rawName);
  if(nk&&nk!==normalizeLearningName(current.standardName)&&!current.aliases.some(x=>normalizeLearningName(x)===nk))current.aliases.push(rawName);
  current.confirmations=Number(current.confirmations||0)+1;
  current.updatedAt=new Date().toISOString();
  if(current.confirmations>=2)current.status="VERIFIED";
  data.records[storeId]=current;
  addAlias(data.aliases,normalizeLearningName(current.standardName),storeId);
  addAlias(data.aliases,nk,storeId);
  const event={id:newId(),type:"CONFIRMED",storeId,rawName,standardName,routeId:clean(input.routeId)||null,waybillId:clean(input.waybillId)||null,userId:clean(input.userId)||null,createdAt:new Date().toISOString()};
  data.events.push(event);
  data.version++;
  await set(env,"global:learning",data);
  return {record:current,event};
}

export async function seedRouteStores(env,routeId,stores){
  const data=await read(env);
  let changed=false;
  for(const s of Array.isArray(stores)?stores:[]){
    const storeId=clean(s.storeId),standardName=clean(s.name||s.displayName),originalName=clean(s.originalName||standardName);
    if(!storeId||!standardName)continue;
    const existing=data.records[storeId];
    if(existing&&existing.standardName!==standardName)continue;
    if(!existing){
      data.records[storeId]={storeId,standardName,originalName,aliases:Array.isArray(s.aliases)?s.aliases.filter(Boolean):[],navigation:s.navigation||null,status:"ROUTE_REFERENCE",confirmations:0,conflicts:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),sourceRoutes:[routeId]};
      changed=true;
    }else{
      existing.sourceRoutes=Array.from(new Set([...(existing.sourceRoutes||[]),routeId]));
      for(const alias of Array.isArray(s.aliases)?s.aliases:[]){
        if(alias&&!existing.aliases.includes(alias)){existing.aliases.push(alias);changed=true}
      }
    }
    addAlias(data.aliases,normalizeLearningName(standardName),storeId);
    for(const alias of Array.isArray(s.aliases)?s.aliases:[])addAlias(data.aliases,normalizeLearningName(alias),storeId);
  }
  if(changed){data.version++;await set(env,"global:learning",data)}
  return data;
}
