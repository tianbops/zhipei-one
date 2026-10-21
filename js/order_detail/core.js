'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const attr=v=>esc(v).replace(/'/g,'&#39;');
const navOf=x=>String(x?.navigation||x?.nav||'').trim();
const params=new URLSearchParams(location.search), id=params.get('id')||'', source=params.get('source')||'', targetDate=params.get('date')||'', from=params.get('from')||'';
let order=null,menuOpen=false,historyChoices=null;let baseStoreCache=null,baseStoreRoute=null;

function safeUrl(v){try{const raw=String(v??'').trim();if(!raw)return'';const u=new URL(raw,location.origin);return /^(https?:)$/.test(u.protocol)?u.href:''}catch{return''}}
function vehicleText(v){const s=String(v??'').replace(/undefined/gi,'').replace(/\s+/g,'').trim();return s?('车辆 '+s):''}
function cleanVehicle(v){return vehicleText(v).replace(/^车辆\s*/,'')||'车辆待确认'}
function fmtWeight(v){const n=Number(v);return Number.isFinite(n)?(Math.round(n*100)/100).toFixed(2):'0.00'}