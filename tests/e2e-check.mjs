import { matchStores, formatCompareKey } from '../functions/api/waybills/_store-match.js';

// 复刻 process.js 中的去重与规划逻辑，验证新匹配结果能正常流通
const clean=v=>String(v??"").trim();
const number=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
function dedupe(items){
  const seen=new Map(),out=[],conflicts=[],removed=[];let merged=0;
  for(const s of items){
    const identityKey=formatCompareKey(s.name||s.rawName);
    let key=s.storeId?"id:"+s.storeId:"pending:"+identityKey;
    if(s.storeId&&seen.has(key)){
      const prev=seen.get(key);
      const prevId=formatCompareKey(prev.name||prev.rawName);
      if(prevId!==identityKey){key="id-conflict:"+s.storeId+":"+identityKey;conflicts.push({storeId:s.storeId})}
      else{merged++;removed.push({rawName:s.rawName});continue}
    }
    seen.set(key,s);out.push(s);
  }
  return{items:out,merged,conflicts,removed};
}
function plan(items,useRouteOrder=true){
  const list=useRouteOrder?[...items].sort((a,b)=>(number(a.routeOrder)??100000)-(number(b.routeOrder)??100000)):[...items];
  return list.map((s,i)=>({...s,routeOrder:i+1}));
}

const base=[
 {storeId:"S1",name:"华润万家(龙华店)",originalName:"华润万家龙华店",aliases:["华润万家龙华"],routeOrder:2},
 {storeId:"S2",name:"沃尔玛(坂田店)",originalName:"沃尔玛坂田店",aliases:[],routeOrder:1},
 {storeId:"S3",name:"大润发(龙华店)",originalName:"大润发龙华店",aliases:[],routeOrder:3},
];
// 模拟一次真实提取结果：含格式差异、重复门店、待定门店
const extracted=[
 {rawName:"沃尔玛（坂田店）"},      // → S2 顺序1
 {rawName:"华润万家·龙华店"},      // → S1 顺序2
 {rawName:"大润发龙华店"},         // → S3 顺序3
 {rawName:"华润万家 龙华店"},      // → S1 重复，应被去重
 {rawName:"某新开张店铺"},         // → 待定
];

const matched=matchStores(extracted,base);
console.log("【步骤1 匹配】");
matched.forEach((m,i)=>console.log(" ",extracted[i].rawName.padEnd(16),"→",m.pending?"待定["+m.matchDiagnostics.reason+"]":m.storeId+" ("+m.matchMethod+")"));

const d=dedupe(matched);
console.log("\n【步骤2 去重】合并",d.merged,"家 | 冲突",d.conflicts.length,"| 剩余",d.items.length,"家");
d.items.forEach(x=>console.log("  ",x.name,x.pending?"[待定]":"["+x.storeId+"]"));

const planned=plan(d.items,true);
console.log("\n【步骤3 规划】最终顺序：");
planned.forEach(p=>console.log("   "+String(p.routeOrder).padStart(2,"0"),p.name,p.pending?"(待确认)":""));

// 断言
const ok1=planned.filter(p=>!p.pending).length===3;
const ok2=d.merged===1;
const ok3=planned.filter(p=>p.pending).length===1;
const ok4=planned[planned.length-1].pending===true; // 待定排末尾
const orderOk=planned.filter(p=>!p.pending).map(p=>p.storeId).join(",")==="S2,S1,S3";
console.log("\n【校验】");
console.log(ok1?"  ✓":"  ✗","3家自动匹配");
console.log(ok2?"  ✓":"  ✗","重复门店已合并");
console.log(ok3?"  ✓":"  ✗","1家待定");
console.log(ok4?"  ✓":"  ✗","待定门店排在末尾");
console.log(orderOk?"  ✓":"  ✗","按基准库routeOrder排序 (S2→S1→S3)");
// P0 身份碰撞回归：两个不同 OCR 识别项若被错误指向同一 storeId，第二项必须进入待定，绝不能被去重吞掉。
const collisionBase=[{storeId:"S9",name:"测试基准店",aliases:["甲店","乙店"],routeOrder:1}];
const collisionInput=[{rawName:"甲店"},{rawName:"乙店"}];
const collisionMatched=matchStores(collisionInput,collisionBase);
const collisionSafe=
  collisionMatched.length===2 &&
  collisionMatched[0].pending===false &&
  collisionMatched[0].storeId==="S9" &&
  collisionMatched[1].pending===true &&
  collisionMatched[1].storeId===null &&
  collisionMatched[1].matchConfidence?.reason==="STORE_ID_COLLISION";
console.log(collisionSafe?"  ✓":"  ✗","不同识别项争用同一storeId时转待定，不吞店");

console.log([ok1,ok2,ok3,ok4,orderOk,collisionSafe].every(Boolean)?"\n✅ 端到端链路验证通过":"\n❌ 存在问题");
