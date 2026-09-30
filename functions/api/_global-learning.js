import {get,set,newId,command} from "./_redis.js";

const KEY="global:learning";
const RECORDS=KEY+":records";
const ALIASES=KEY+":aliases";
const EVENTS=KEY+":events";
const META=KEY+":meta";
const LOCK=KEY+":lock";
const MIGRATION_LOCK=KEY+":migration-lock";
const clean=v=>String(v??"").trim();
export const normalizeLearningName=v=>clean(v).replace(/[\u3000\s]+/g,"").replace(/[（）()【】\[\]{}<>《》“”"'‘’]/g,"").replace(/[·•、,，。；;:：!！?？\-_—]/g,"").replace(/Ⅱl|Il|II|ⅱ/gi,"II").toLowerCase();

function candidate(r){return{storeId:r.storeId,name:r.standardName||"",originalName:r.originalName||r.standardName||"",aliases:Array.isArray(r.aliases)?r.aliases:[],navigation:r.navigation||null}}
function parse(v,fallback){try{return typeof v==="string"?JSON.parse(v):v}catch{return fallback}}
async function legacy(env){const raw=await get(env,KEY);const x=parse(raw,null);return x&&typeof x==="object"&&x.records&&typeof x.records==="object"?x:null}
async function ensureMeta(env,{lockHeld=false}={}){const syncVersion=async meta=>{const target=Math.max(1,Number(meta?.version)||1);await command(env,["EVAL",'local v=tonumber(redis.call("GET",KEYS[1]) or "0") or 0; local t=tonumber(ARGV[1]) or 1; if v<t then redis.call("SET",KEYS[1],t); return t end; return v',"1","zp:"+META+":version",String(target)]);return meta};const existing=parse(await get(env,META),null);if(existing&&typeof existing==="object")return syncVersion(existing);let token=null;if(!lockHeld){token=newId();const ok=await command(env,["SET","zp:"+MIGRATION_LOCK,token,"NX","EX","60"]);if(ok!=="OK")throw new Error("GLOBAL_LEARNING_BUSY")}try{const again=parse(await get(env,META),null);if(again&&typeof again==="object")return syncVersion(again);const old=await legacy(env);if(old){for(const [id,r] of Object.entries(old.records||{}))await command(env,["HSET","zp:"+RECORDS,id,JSON.stringify(r)]);for(const [k,ids] of Object.entries(old.aliases||{}))await command(env,["HSET","zp:"+ALIASES,k,JSON.stringify(ids)]);const events=Array.isArray(old.events)?old.events.slice(-5000):[];const existingEvents=Number(await command(env,["LLEN","zp:"+EVENTS]))||0;if(existingEvents<events.length){const missing=events.slice(existingEvents);for(const e of missing)await command(env,["RPUSH","zp:"+EVENTS,JSON.stringify(e)])}const meta={schemaVersion:"2",version:Number(old.version)||1};await set(env,META,meta);return syncVersion(meta)}const meta={schemaVersion:"2",version:1};await set(env,META,meta);return syncVersion(meta)}finally{if(token)await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1","zp:"+MIGRATION_LOCK,token]).catch(()=>{})}}
async function recordsFor(env,ids){if(!ids.length)return[];const vals=await command(env,["HMGET","zp:"+RECORDS,...ids]);return ids.map((id,i)=>parse(vals?.[i],null))}
async function aliasesFor(env,keys){if(!keys.length)return[];const vals=await command(env,["HMGET","zp:"+ALIASES,...keys]);return vals.map(v=>{const parsed=parse(v,null);if(v!==null&&v!==undefined&&(!Array.isArray(parsed)||parsed.some(id=>typeof id!=="string"||!id.trim())))return null;return Array.isArray(parsed)?parsed.filter(id=>typeof id==="string"&&id.trim()):[]})}
export async function findGlobalMatches(env,items){
 await ensureMeta(env);
 const keys=items.map(x=>normalizeLearningName(x.rawName||x.name));
 const idLists=await aliasesFor(env,keys);
 const ids=[...new Set(idLists.flatMap(list=>Array.isArray(list)?list:[]))];
 const recs=await recordsFor(env,ids);const byId=new Map(recs.filter(r=>r&&r.status==="VERIFIED").map(r=>[r.storeId,r]));
 return items.map((item,i)=>{const rawName=clean(item.rawName||item.name),list=Array.isArray(idLists[i])?idLists[i]:[];let target=null,method=null;if(item.storeId&&byId.has(item.storeId)){target=byId.get(item.storeId);method="global-identity"}else if(list.length===1&&byId.has(list[0])){target=byId.get(list[0]);method="global-alias"}return target?{...item,storeId:target.storeId,name:target.standardName||rawName,originalName:target.originalName||rawName,globalMatchStatus:"matched",globalMatchMethod:method,pending:false}:{...item,globalMatchStatus:"unresolved"}})
}
export async function learnGlobal(env,input){
 const storeId=clean(input.storeId),rawName=clean(input.rawName||input.name),standardName=clean(input.standardName||input.name||rawName),routeId=clean(input.routeId),waybillId=clean(input.waybillId),learningEventId=clean(input.learningEventId);
 if(!storeId||!rawName||!standardName)throw new Error("GLOBAL_LEARNING_INPUT_INVALID");
 const eventKey=learningEventId?["learning-event",learningEventId].join(":"):waybillId?["learning-event",routeId,waybillId,storeId,normalizeLearningName(rawName)].join(":"):"";
 const lockToken=newId();const lock=await command(env,["SET","zp:"+LOCK,lockToken,"NX","EX","30"]);if(lock!=="OK")throw new Error("GLOBAL_LEARNING_BUSY");
 try{
  await ensureMeta(env,{lockHeld:true});
  if(eventKey&&await get(env,eventKey)){const old=parse(await command(env,["HGET","zp:"+RECORDS,storeId]),null);return{record:old,event:null,duplicate:true}}
  const current=parse(await command(env,["HGET","zp:"+RECORDS,storeId]),null)||{storeId,standardName,originalName:clean(input.originalName||rawName),aliases:[],navigation:input.navigation||null,status:"CANDIDATE",confirmations:0,conflicts:0,createdAt:new Date().toISOString()};
  let conflictDetected=false;
  if(current.standardName&&current.standardName!==standardName){current.conflicts=Number(current.conflicts||0)+1;current.status="CONFLICT";conflictDetected=true}else current.standardName=standardName;
  current.aliases=Array.isArray(current.aliases)?current.aliases:[];const nk=normalizeLearningName(rawName);if(!conflictDetected&&nk&&nk!==normalizeLearningName(current.standardName)&&!current.aliases.some(x=>normalizeLearningName(x)===nk))current.aliases.push(rawName);
  if(current.status!=="CONFLICT"){if(current.status==="ROUTE_REFERENCE")current.status="CANDIDATE";current.confirmations=Number(current.confirmations||0)+1;if(current.confirmations>=2)current.status="VERIFIED"}current.updatedAt=new Date().toISOString();
  const aliasKeys=[normalizeLearningName(current.standardName),...(conflictDetected?[]:[nk])].filter(Boolean);
  const aliasValues=[];
  for(const key of aliasKeys){const oldRaw=await command(env,["HGET","zp:"+ALIASES,key]);const oldParsed=parse(oldRaw,null);if(oldRaw!==null&&oldRaw!==undefined&&(!Array.isArray(oldParsed)||oldParsed.some(id=>typeof id!=="string"||!id.trim())))throw new Error("GLOBAL_ALIAS_DATA_INVALID");const oldAliases=Array.isArray(oldParsed)?oldParsed:[];aliasValues.push([key,oldAliases.includes(storeId)?oldAliases:[...oldAliases,storeId]])}
  const event={id:newId(),type:"CONFIRMED",storeId,rawName,standardName,routeId:routeId||null,waybillId:waybillId||null,userId:clean(input.userId)||null,createdAt:new Date().toISOString()};
  const script=`local eventKey=ARGV[1]
if eventKey~="__none__" and redis.call("GET",eventKey) then return {"DUPLICATE"} end
redis.call("HSET",KEYS[1],ARGV[2],ARGV[3])
local n=5
for i=1,tonumber(ARGV[4]) do local k=ARGV[n];local v=ARGV[n+1];redis.call("HSET",KEYS[2],k,v);n=n+2 end
redis.call("RPUSH",KEYS[3],ARGV[n]);redis.call("LTRIM",KEYS[3],"-5000","-1")
local version=redis.call("INCR",KEYS[4])
redis.call("SET",KEYS[5],cjson.encode({schemaVersion="2",version=version}))
if eventKey~="__none__" then redis.call("SET",eventKey,ARGV[n+2]) end
return {"OK",tostring(version)}`;
  const args=[eventKey||"__none__",storeId,JSON.stringify(current),String(aliasValues.length),...aliasValues.flatMap(([k,v])=>[k,JSON.stringify(v)]),JSON.stringify(event),JSON.stringify({schemaVersion:"2",version:0}),event.id];
  const result=await command(env,["EVAL",script,"5","zp:"+RECORDS,"zp:"+ALIASES,"zp:"+EVENTS,"zp:"+META+":version","zp:"+META,...args]);
  if(Array.isArray(result)&&result[0]==="DUPLICATE")return{record:current,event:null,duplicate:true};
  return{record:current,event,duplicate:false}
 }finally{await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1","zp:"+LOCK,lockToken]).catch(()=>{})}
}


export async function listGlobalConflicts(env,{limit=100,cursor="0"}={}){const size=Math.min(200,Math.max(1,Number(limit)||100));let cur=String(cursor||"0");const out=[];do{const r=await command(env,["HSCAN","zp:"+RECORDS,cur,"COUNT",String(Math.min(200,size*2))]);cur=String(r?.[0]??"0");const data=Array.isArray(r?.[1])?r[1]:[];for(let i=0;i<data.length;i+=2){const rec=parse(data[i+1],null);if(rec&&rec.status==="CONFLICT")out.push(rec);if(out.length>=size)break}if(out.length>=size||cur==="0")break}while(true);out.sort((a,b)=>String(b.updatedAt||b.createdAt||"").localeCompare(String(a.updatedAt||a.createdAt||"")));return{records:out,cursor:cur,hasMore:cur!=="0"}}

export async function resolveGlobalConflict(env,input){
 const storeId=clean(input.storeId),standardName=clean(input.standardName),userId=clean(input.userId);
 if(!storeId||!standardName)throw new Error("GLOBAL_CONFLICT_RESOLUTION_INPUT_INVALID");
 const lockToken=newId(),locked=await command(env,["SET","zp:"+LOCK,lockToken,"NX","EX","30"]);
 if(locked!=="OK")throw new Error("GLOBAL_LEARNING_BUSY");
 try{
  await ensureMeta(env,{lockHeld:true});
  const raw=await command(env,["HGET","zp:"+RECORDS,storeId]),record=parse(raw,null);
  if(!record)return{resolved:false,code:"GLOBAL_RECORD_NOT_FOUND"};
  if(record.status!=="CONFLICT")return{resolved:false,code:"GLOBAL_RECORD_NOT_CONFLICT"};
  const canonicalKey=normalizeLearningName(standardName);
  if(!canonicalKey)throw new Error("GLOBAL_CONFLICT_RESOLUTION_INPUT_INVALID");
  const existingRaw=await command(env,["HGET","zp:"+ALIASES,canonicalKey]),existing=parse(existingRaw,null);
  if(existingRaw!==null&&existingRaw!==undefined&&(!Array.isArray(existing)||existing.some(id=>typeof id!=="string"||!id.trim())))throw new Error("GLOBAL_ALIAS_DATA_INVALID");
  const owners=Array.isArray(existing)?existing.filter(id=>id!==storeId):[];
  if(owners.length)return{resolved:false,code:"GLOBAL_CANONICAL_NAME_CONFLICT",storeIds:owners};
  const previousStandardName=record.standardName||"";
  record.standardName=standardName;
  record.aliases=[];
  record.status="CANDIDATE";
  record.confirmations=0;
  record.updatedAt=new Date().toISOString();
  record.resolvedAt=record.updatedAt;
  record.resolvedBy=userId||null;
  const event={id:newId(),type:"CONFLICT_RESOLVED",storeId,standardName,previousStandardName,routeId:null,waybillId:null,userId:userId||null,createdAt:record.updatedAt};
  const script=`local cursor="0"
repeat
 local scan=redis.call("HSCAN",KEYS[2],cursor,"COUNT","200")
 cursor=scan[1]
 local vals=scan[2]
 for i=1,#vals,2 do
  local key=vals[i]
  local ok,parsed=pcall(cjson.decode,vals[i+1])
  if ok and type(parsed)=="table" then
   local next={}
   for _,id in ipairs(parsed) do if id~=ARGV[1] then table.insert(next,id) end end
   if #next==0 then redis.call("HDEL",KEYS[2],key) else redis.call("HSET",KEYS[2],key,cjson.encode(next)) end
  end
 end
until cursor=="0"
redis.call("HSET",KEYS[1],ARGV[1],ARGV[2])
redis.call("HSET",KEYS[2],ARGV[3],ARGV[4])
redis.call("RPUSH",KEYS[3],ARGV[5])
redis.call("LTRIM",KEYS[3],"-5000","-1")
local version=redis.call("INCR",KEYS[4])
redis.call("SET",KEYS[5],cjson.encode({schemaVersion="2",version=version}))
return tostring(version)`;
  const version=Number(await command(env,["EVAL",script,"5","zp:"+RECORDS,"zp:"+ALIASES,"zp:"+EVENTS,"zp:"+META+":version","zp:"+META,storeId,JSON.stringify(record),canonicalKey,JSON.stringify([storeId]),JSON.stringify(event)]));
  return{resolved:true,record,event,version};
 }finally{await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1","zp:"+LOCK,lockToken]).catch(()=>{})}
}

export async function seedRouteStores(env,routeId,stores){
 const lockToken=newId();const locked=await command(env,["SET","zp:"+LOCK,lockToken,"NX","EX","60"]);if(locked!=="OK")throw new Error("GLOBAL_LEARNING_BUSY");
 try{await ensureMeta(env,{lockHeld:true});let changed=false;
  for(const s of Array.isArray(stores)?stores:[]){const storeId=clean(s.storeId),standardName=clean(s.name||s.displayName),originalName=clean(s.originalName||standardName);if(!storeId||!standardName)continue;const existing=parse(await command(env,["HGET","zp:"+RECORDS,storeId]),null);
   if(existing&&existing.standardName!==standardName){existing.conflicts=Number(existing.conflicts||0)+1;existing.status="CONFLICT";await command(env,["HSET","zp:"+RECORDS,storeId,JSON.stringify(existing)]);changed=true;continue}
   const record=existing||{storeId,standardName,originalName,aliases:Array.isArray(s.aliases)?s.aliases.filter(Boolean):[],navigation:s.navigation||null,status:"ROUTE_REFERENCE",confirmations:0,conflicts:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),sourceRoutes:[routeId]};
   record.sourceRoutes=Array.from(new Set([...(record.sourceRoutes||[]),routeId]));for(const alias of Array.isArray(s.aliases)?s.aliases:[])if(alias&&!record.aliases.includes(alias))record.aliases.push(alias);record.updatedAt=new Date().toISOString();
   await command(env,["HSET","zp:"+RECORDS,storeId,JSON.stringify(record)]);for(const key of [normalizeLearningName(standardName),...(Array.isArray(s.aliases)?s.aliases:[]).map(normalizeLearningName)]){if(!key)continue;const oldRaw=await command(env,["HGET","zp:"+ALIASES,key]);const oldAliases=parse(oldRaw,null);if(oldRaw!==null&&oldRaw!==undefined&&(!Array.isArray(oldAliases)||oldAliases.some(id=>typeof id!=="string"||!id.trim())))throw new Error("GLOBAL_ALIAS_DATA_INVALID");const safeOldAliases=Array.isArray(oldAliases)?oldAliases:[];if(!safeOldAliases.includes(storeId)){await command(env,["HSET","zp:"+ALIASES,key,JSON.stringify([...safeOldAliases,storeId])]);changed=true}}
  }
  if(changed){const version=Number(await command(env,["INCR","zp:"+META+":version"]));await set(env,META,{schemaVersion:"2",version})}return{schemaVersion:"2",version:Number(parse(await get(env,META),{}).version)||1}
 }finally{await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1","zp:"+LOCK,lockToken]).catch(()=>{})}}
