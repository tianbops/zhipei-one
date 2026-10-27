'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const attr=v=>esc(v).replace(/'/g,'&#39;');
const navOf=x=>String(x?.navigation||x?.nav||'').trim();
const params=new URLSearchParams(location.search), id=params.get('id')||'', source=params.get('source')||'', targetDate=params.get('date')||'', from=params.get('from')||'', supersededN=Number(params.get('superseded'))||0;
let order=null,menuOpen=false,historyChoices=null;let baseStoreCache=null,baseStoreRoute=null;

function safeUrl(v){try{const raw=String(v??'').trim();if(!raw)return'';const u=new URL(raw,location.origin);return /^(https?:)$/.test(u.protocol)?u.href:''}catch{return''}}
function vehicleText(v){const s=String(v??'').replace(/undefined/gi,'').replace(/\s+/g,'').trim();return s?('车辆 '+s):''}
function cleanVehicle(v){return vehicleText(v).replace(/^车辆\s*/,'')||'车辆待确认'}
// 司机/送货员姓名：OCR 抬头常带装饰性尖括号/箭头（「田波>」），存量数据已落库，
// 渲染层统一剥离尾部 > › » ＞ 〉 》 → 与空白（提取层 _process-extract.js 同步修复，治新数据）
function personName(v){return String(v??'').replace(/[\s>›»＞〉》→]+$/,'').trim()}
function fmtWeight(v){const n=Number(v);return Number.isFinite(n)?(Math.round(n*100)/100).toFixed(2):'0.00'}