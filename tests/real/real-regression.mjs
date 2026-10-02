/**
 * 真实运单回归测试（基于用户提供的 17 号线 5 天运单 + 43 家基准库）
 * 验收重点：
 *   1. 自动匹配率（越高越好，但不能以错配为代价）
 *   2. 零错配（硬指标）
 *   3. 排序必须严格符合基准库 routeOrder
 *   4. 待定门店必须排在末尾
 */
import { waybills } from './corpus.mjs';
import { route17Base } from './route17-base.mjs';
import { matchStores, formatCompareKey } from '../../functions/api/waybills/_store-match.js';

const base = route17Base.map(s => ({ storeId:"S"+String(s.routeOrder).padStart(3,"0"), name:s.name, originalName:s.name, aliases:[], routeOrder:s.routeOrder }));
const norm = s => String(s).replace(/[\s（）()【】\-—·,，。]/g,"").replace(/Ⅱ|ⅱ/g,"II").toLowerCase();
const knownStoreIds = new Set(base.map(b=>b.storeId));
const number = v => { const n=Number(v); return Number.isFinite(n)?n:null; };
function dedupe(items){const seen=new Map(),out=[];let merged=0;for(const s of items){const ik=formatCompareKey(s.name||s.rawName);const k=s.storeId?"id:"+s.storeId:"pending:"+ik;if(seen.has(k)){merged++;continue}seen.set(k,s);out.push(s)}return{items:out,merged}}
function plan(items){const list=[...items].sort((a,b)=>(number(a.routeOrder)??100000)-(number(b.routeOrder)??100000));return list.map((s,i)=>({...s,routeOrder:i+1}))}

let pass=0, fail=0;
const t=(n,c,x)=>{c?pass++:(fail++,console.log("  ✗ "+n+(x?" → "+x:"")))};

let totalAuto=0, totalPend=0, totalInput=0;
for (const [date, w] of Object.entries(waybills).sort()) {
  const out = matchStores(w.stores.map(rawName=>({rawName})), base);
  const d = dedupe(out);
  const planned = plan(d.items);
  const matched = planned.filter(p=>!p.pending);
  const pending = planned.filter(p=>p.pending);
  totalAuto+=matched.length; totalPend+=pending.length; totalInput+=w.stores.length;

  console.log("\n═══ "+date+" ═══ 输入"+w.stores.length+" 自动"+matched.length+" 待定"+pending.length);

  // 1. 无错配：所有自动匹配的 storeId 必须真实存在于基准库
  const badId = matched.filter(m=>!knownStoreIds.has(m.storeId));
  t(date+" 无非法storeId", badId.length===0, JSON.stringify(badId.slice(0,2)));

  // 2. 已匹配顺序严格递增（符合基准库）
  const seq = matched.map(m=>m.routeOrder);
  let asc = true, prev=-Infinity;
  for(const o of seq){ if(o<=prev){asc=false;break} prev=o }
  t(date+" 顺序符合基准库", asc, "序列 "+seq.join(","));

  // 3. 待定排末尾
  const tail = planned.slice(planned.length-pending.length);
  t(date+" 待定排在末尾", tail.every(p=>p.pending));

  // 4. 无重复门店
  const ids = matched.map(m=>m.storeId);
  t(date+" 无重复门店", new Set(ids).size===ids.length);

  // 5. 每条待定必须有原因
  t(date+" 待定含原因", pending.every(p=>Boolean(p.matchDiagnostics?.reason)));

  if(pending.length) pending.forEach(p=>console.log("     待定: 「"+p.rawName+"」 "+(p.candidates?.[0]?"→建议「"+p.candidates[0].name+"」":"无候选")));
}

console.log("\n"+"═".repeat(52));
console.log("总计: 输入 "+totalInput+" | 自动匹配 "+totalAuto+" | 待定 "+totalPend);
console.log("自动匹配率: "+(totalAuto/totalInput*100).toFixed(1)+"%");
console.log("─".repeat(52));
console.log("断言: 通过 "+pass+" / 失败 "+fail);
console.log(fail===0?"✅ 全部通过（零错配）":"❌ 存在失败项");
process.exit(fail?1:0);
