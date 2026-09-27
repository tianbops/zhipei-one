import {get,set,del,newId,command} from "./_redis.js";

const KEY="global:learning";
const RECORDS=KEY+":records";
const ALIASES=KEY+":aliases";
const EVENTS=KEY+":events";
const META=KEY+":meta";
const LOCK=KEY+":lock";
const clean=v=>String(v??"").trim();
export const normalizeLearningName=v=>clean(v).replace(/[\u3000\s]+/g,"").replace(/[（）()【】\[\]{}<>《》“”"'‘’]/g,"").replace(/[·•、,，。；;:：!！?？\-_—]/g,"").replace(/Ⅱl|Il|II|ⅱ/gi,"II").toLowerCase();

function candidate(r){return{storeId:r.storeId,name:r.standardName||"",originalName:r.originalName||r.standardName||"",aliases:Array.isArray(r.aliases)?r.aliases:[],navigation:r.navigation||null}}
function parse(v,fallback){try{return typeof v==="string"?JSON.parse(v):v}catch{return fallback}}
async function legacy(env){const raw=await get(env,KEY);const x=parse(raw,null);return x&&typeof x==="object"&&x.records&&typeof x.records==="object"?x:null}
async function ensureMeta(env){const m=parse(await get(env,META),null);if(m)return m;const old=await legacy(env);if(old){for(const [id,r] of Object.entries(old.records||{}))await command(env,["HSET","zp:"+RECORDS,id,JSON.stringify(r)]);for(const [k,ids] of Object.entries(old.aliases||{}))await command(env,["HSET","zp:"+ALIASES,k,JSON.stringify(ids)]);for(const e of Array.isArray(old.events)?old.events.slice(-5000):[])await command(env,["RPUSH","zp:"+EVENTS,JSON.stringify(e)]);const meta={schemaVersion:"2",version:Number(old.version)||1};await set(env,META,meta);return meta}const meta={schemaVersion:"2",version:1};await set(env,META,meta);return meta}
async function recordsFor(env,ids){if(!ids.length)return[];const vals=await command(env,["HMGET","zp:"+RECORDS,...ids]);return ids.map((id,i)=>parse(vals?.[i],null))}
async function aliasesFor(env,keys){if(!keys.length)return[];const vals=await command(env,["HMGET","zp:"+ALIASES,...keys]);return vals.map(v=>parse(v,[]))}
export async function findGlobalMatches(env,items){
 await ensureMeta(env);
 const keys=items.map(x=>normalizeLearningName(x.rawName||x.name));
 const idLists=await aliasesFor(env,keys);
 const ids=[...new Set(idLists.flat().filter(Boolean))];
 const recs=await recordsFor(env,ids);const byId=new Map(recs.filter(Boolean).map(r=>[r.storeId,r]));
 return items.map((item,i)=>{const rawName=clean(item.rawName||item.name),list=idLists[i]||[];let target=null,method=null;if(item.storeId&&byId.has(item.storeId)){target=byId.get(item.storeId);method="global-identity"}else if(list.length===1&&byId.has(list[0])){target=byId.get(list[0]);method="global-alias"}return target?{...item,storeId:target.storeId,name:target.standardName||rawName,originalName:target.originalName||rawName,globalMatchStatus:"matched",globalMatchMethod:method,pending:false}:{...item,globalMatchStatus:"unresolved"}})
}
export async function learnGlobal(env,input){
 const storeId=clean(input.storeId),rawName=clean(input.rawName||input.name),standardName=clean(input.standardName||input.name||rawName),routeId=clean(input.routeId),waybillId=clean(input.waybillId);
 if(!storeId||!rawName||!standardName)throw new Error("GLOBAL_LEARNING_INPUT_INVALID");
 const eventKey=waybillId?["learning-event",routeId,waybillId,storeId,normalizeLearningName(rawName)].join(":"):"";
 const lock=await command(env,["SET","zp:"+LOCK,"1","NX","EX","30"]);if(lock!=="OK")throw new Error("GLOBAL_LEARNING_BUSY");
 try{
  await ensureMeta(env);
  if(eventKey&&await get(env,eventKey)){const old=parse(await command(env,["HGET","zp:"+RECORDS,storeId]),null);return{record:old,event:null,duplicate:true}}
  const current=parse(await command(env,["HGET","zp:"+RECORDS,storeId]),null)||{storeId,standardName,originalName:clean(input.originalName||rawName),aliases:[],navigation:input.navigation||null,status:"CANDIDATE",confirmations:0,conflicts:0,createdAt:new Date().toISOString()};
  if(current.standardName&&current.standardName!==standardName){current.conflicts=Number(current.conflicts||0)+1;current.status="CONFLICT"}else current.standardName=standardName;
  current.aliases=Array.isArray(current.aliases)?current.aliases:[];const nk=normalizeLearningName(rawName);if(nk&&nk!==normalizeLearningName(current.standardName)&&!current.aliases.some(x=>normalizeLearningName(x)===nk))current.aliases.push(rawName);
  if(current.status!=="CONFLICT"){current.confirmations=Number(current.confirmations||0)+1;if(current.confirmations>=2)current.status="VERIFIED"}current.updatedAt=new Date().toISOString();
  await command(env,["HSET","zp:"+RECORDS,storeId,JSON.stringify(current)]);
  const aliasKeys=[normalizeLearningName(current.standardName),nk].filter(Boolean);
  for(const key of aliasKeys){const old=parse(await command(env,["HGET","zp:"+ALIASES,key]),[]);if(!old.includes(storeId))await command(env,["HSET","zp:"+ALIASES,key,JSON.stringify([...old,storeId])])}
  const event={id:newId(),type:"CONFIRMED",storeId,rawName,standardName,routeId:routeId||null,waybillId:waybillId||null,userId:clean(input.userId)||null,createdAt:new Date().toISOString()};
  await command(env,["RPUSH","zp:"+EVENTS,JSON.stringify(event)]);await command(env,["LTRIM","zp:"+EVENTS,"-5000","-1"]);const version=Number(await command(env,["INCR","zp:"+META+":version"]));
  await set(env,META,{schemaVersion:"2",version});if(eventKey)await set(env,eventKey,event.id);return{record:current,event,duplicate:false}
 }finally{await del(env,LOCK).catch(()=>{})}
}
export async function seedRouteStores(env,routeId,stores){
 await ensureMeta(env);let changed=false;
 for(const s of Array.isArray(stores)?stores:[]){const storeId=clean(s.storeId),standardName=clean(s.name||s.displayName),originalName=clean(s.originalName||standardName);if(!storeId||!standardName)continue;const existing=parse(await command(env,["HGET","zp:"+RECORDS,storeId]),null);
  if(existing&&existing.standardName!==standardName){existing.conflicts=Number(existing.conflicts||0)+1;existing.status="CONFLICT";await command(env,["HSET","zp:"+RECORDS,storeId,JSON.stringify(existing)]);changed=true;continue}
  const record=existing||{storeId,standardName,originalName,aliases:Array.isArray(s.aliases)?s.aliases.filter(Boolean):[],navigation:s.navigation||null,status:"ROUTE_REFERENCE",confirmations:0,conflicts:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),sourceRoutes:[routeId]};
  record.sourceRoutes=Array.from(new Set([...(record.sourceRoutes||[]),routeId]));for(const alias of Array.isArray(s.aliases)?s.aliases:[])if(alias&&!record.aliases.includes(alias))record.aliases.push(alias);record.updatedAt=new Date().toISOString();
  await command(env,["HSET","zp:"+RECORDS,storeId,JSON.stringify(record)]);for(const key of [normalizeLearningName(standardName),...(Array.isArray(s.aliases)?s.aliases:[]).map(normalizeLearningName)]){if(!key)continue;const old=parse(await command(env,["HGET","zp:"+ALIASES,key]),[]);if(!old.includes(storeId)){await command(env,["HSET","zp:"+ALIASES,key,JSON.stringify([...old,storeId])]);changed=true}}
 }
 if(changed){const version=Number(await command(env,["INCR","zp:"+META+":version"]));await set(env,META,{schemaVersion:"2",version})}return{schemaVersion:"2",version:Number(parse(await get(env,META),{}).version)||1}
}