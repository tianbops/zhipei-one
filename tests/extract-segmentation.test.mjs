import fs from 'node:fs';
import { formatCompareKey } from '../functions/api/waybills/_store-match.js';

const source=fs.readFileSync(new URL('../functions/api/waybills/process.js',import.meta.url),'utf8');
const start=source.indexOf('function baseIdentityNames');
const end=source.indexOf('\nfunction validateResult',start);
if(start<0||end<0)throw new Error('extract segmentation helpers not found');
const helperSource=source.slice(start,end);
const clean=v=>String(v??'').trim();
const factory=new Function('clean','formatCompareKey',helperSource+'\nreturn splitByRouteBase;');
const splitByRouteBase=factory(clean,formatCompareKey);

const base=[
 {storeId:'S1',name:'重庆门店甲',originalName:'重庆门店甲',aliases:[],routeOrder:1},
 {storeId:'S2',name:'重庆门店乙',originalName:'重庆门店乙',aliases:[],routeOrder:2}
];

const merged=[{rawName:'重庆门店甲重庆门店乙',name:'重庆门店甲重庆门店乙',sourceLine:'重庆门店甲重庆门店乙'}];
const recovered=splitByRouteBase(merged,base);
if(recovered.length!==2)throw new Error('merged OCR item was not recovered into two stores');
if(recovered[0].storeId!=='S1'||recovered[1].storeId!=='S2')throw new Error('recovered identities are incorrect');
if(recovered[0].extractionMethod!=='route-base-segment'||recovered[1].extractionMethod!=='route-base-segment')throw new Error('recovery diagnostics missing');

const single=splitByRouteBase([{rawName:'重庆门店甲'}],base);
if(single.length!==1||single[0].storeId)throw new Error('single store was incorrectly pre-matched');

console.log('extract segmentation regression passed');
