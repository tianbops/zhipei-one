import fs from 'node:fs';
import { formatCompareKey } from '../functions/api/waybills/_store-match.js';
import { businessFingerprint, dailyWaybillKey } from '../functions/api/_waybill-identity.js';

const source=fs.readFileSync(new URL('../functions/api/waybills/process.js',import.meta.url),'utf8');
const start=source.indexOf('function baseIdentityNames');
const end=source.indexOf('\n/**\n * 记录运单生命周期',start);
if(start<0||end<0)throw new Error('extract segmentation helpers not found');
const helperSource=source.slice(start,end);
const clean=v=>String(v??'').trim();
const factory=new Function('clean','formatCompareKey','number',helperSource+'\nreturn {splitByRouteBase,dedupe,plan};');
const number=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
const {splitByRouteBase,dedupe,plan}=factory(clean,formatCompareKey,number);

const base=[
 {storeId:'S1',name:'重庆门店甲',originalName:'重庆门店甲',aliases:['甲店'],routeOrder:1},
 {storeId:'S2',name:'重庆门店乙',originalName:'重庆门店乙',aliases:['乙店'],routeOrder:2},
 {storeId:'S3',name:'重庆门店丙',originalName:'重庆门店丙',aliases:['丙店'],routeOrder:3}
];

const merged=[{rawName:'重庆门店甲重庆门店乙',name:'重庆门店甲重庆门店乙',sourceLine:'重庆门店甲重庆门店乙'}];
const recovered=splitByRouteBase(merged,base);
if(recovered.length!==2)throw new Error('merged OCR item was not recovered into two stores');
if(recovered[0].storeId!=='S1'||recovered[1].storeId!=='S2')throw new Error('recovered identities are incorrect');
if(recovered[0].extractionMethod!=='route-base-segment'||recovered[1].extractionMethod!=='route-base-segment')throw new Error('recovery diagnostics missing');

const single=splitByRouteBase([{rawName:'重庆门店甲'}],base);
if(single.length!==1||single[0].storeId)throw new Error('single store was incorrectly pre-matched');

console.log('extract segmentation regression passed');

const three=splitByRouteBase([{rawName:'重庆门店甲重庆门店乙重庆门店丙',name:'重庆门店甲重庆门店乙重庆门店丙',sourceLine:'merged'}],base);
if(three.length!==3||three.map(x=>x.storeId).join(',')!=='S1,S2,S3')throw new Error('three-store merge recovery failed');

const aliasSingle=splitByRouteBase([{rawName:'重庆门店甲',name:'重庆门店甲'}],base);
if(aliasSingle.length!==1)throw new Error('single known store was split unexpectedly');

const overlapping=splitByRouteBase([{rawName:'重庆门店甲重庆门店甲',name:'重庆门店甲重庆门店甲'}],base);
if(overlapping.length!==1)throw new Error('overlapping same-store text was incorrectly split');


// Containment guard: a short identity embedded inside a longer identity must not
// create a second store; the longest overlapping identity wins.
const containmentBase=[
 {storeId:'L1',name:'重庆门店甲乙',originalName:'重庆门店甲乙',aliases:[]},
 {storeId:'L2',name:'门店甲乙',originalName:'门店甲乙',aliases:[]}
];
const containment=splitByRouteBase([{rawName:'重庆门店甲乙',name:'重庆门店甲乙'}],containmentBase);
if(containment.length!==1)throw new Error('contained store identity was incorrectly split');
if(containment[0].storeId)throw new Error('single contained identity must remain pre-match');

const unresolved=splitByRouteBase([{rawName:'完全未知门店甲完全未知门店乙',name:'完全未知门店甲完全未知门店乙'}],base);
if(unresolved.length!==1||unresolved[0].storeId)throw new Error('unresolved merged text must remain unresolved');


// Downstream regression: recovered distinct stores must survive match/dedupe/plan.
const recoveredForPipeline=recovered.map((x,i)=>({...x,rawName:x.name,name:x.name,routeOrder:i+1,pending:false}));
const dedupedRecovered=dedupe(recoveredForPipeline);
if(dedupedRecovered.items.length!==2)throw new Error('recovered distinct stores were collapsed by dedupe');
if(dedupedRecovered.merged!==0)throw new Error('recovered distinct stores must not be counted as merged');
const plannedRecovered=plan(dedupedRecovered.items,true);
if(plannedRecovered.length!==2||plannedRecovered[0].routeOrder!==1||plannedRecovered[1].routeOrder!==2)throw new Error('recovered stores were lost during route planning');
console.log('downstream recovery pipeline regression passed');


// Save-identity regression: recovered final stores must participate in both
// fingerprints, so a 24-store intermediate result cannot dedupe a 25-store final result.
const identityBase={routeId:'17',date:'2026-10-08',vehicle:'渝DK7692',totalWeight:1.64};
const twentyFour={...identityBase,stores:Array.from({length:24},(_,i)=>({storeId:'S'+(i+1),name:'门店'+(i+1),routeOrder:i+1,pending:false}))};
const twentyFive={...identityBase,stores:[...twentyFour.stores,{storeId:'S25',name:'门店25',routeOrder:25,pending:false}]};
if(await businessFingerprint(twentyFour)===await businessFingerprint(twentyFive))throw new Error('business fingerprint ignored recovered store');
if(await dailyWaybillKey(twentyFour)===await dailyWaybillKey(twentyFive))throw new Error('daily dedupe key ignored recovered store');
console.log('save identity recovery regression passed');
