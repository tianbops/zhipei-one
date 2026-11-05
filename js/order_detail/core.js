'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const attr=v=>esc(v).replace(/'/g,'&#39;');
/* 门店导航目标统一由 js/ui/mapnav.js 的 window.zpMapNav 提供。
   不要在渲染层再用 new URL(v, location.origin)：纯文本（如 "A栋B1"）会被解析成
   站内路径，点门店名直接 404，且 back.js 的 replace 让返回键也救不回来。 */
const params=new URLSearchParams(location.search), id=params.get('id')||'', source=params.get('source')||'', targetDate=params.get('date')||'', from=params.get('from')||'', supersededN=Number(params.get('superseded'))||0;
let order=null,historyChoices=null;let baseStoreCache=null,baseStoreRoute=null;
/* 确认提交进行中（核对页）：点「确认」后请求在途，此时返回/关闭弹窗都必须被拦下——
   否则会出现「服务端已落库、用户以为没保存」的分裂状态。由 confirm.js 置位，
   js/ui/back.js 的 zpBusyMessage 与 boot.js 的弹窗关闭入口读取。 */
let confirming=false;
window.zpIsConfirming=()=>confirming;

function vehicleText(v){const s=String(v??'').replace(/undefined/gi,'').replace(/\s+/g,'').trim();return s?('车辆 '+s):''}
function cleanVehicle(v){return vehicleText(v).replace(/^车辆\s*/,'')||'车辆待确认'}
// 司机/送货员姓名：OCR 抬头常带装饰性尖括号/箭头（「田波>」），存量数据已落库，
// 渲染层统一剥离尾部 > › » ＞ 〉 》 → 与空白（提取层 _process-extract.js 同步修复，治新数据）
function personName(v){return String(v??'').replace(/[\s>›»＞〉》→]+$/,'').trim()}
function fmtWeight(v){const n=Number(v);return Number.isFinite(n)?(Math.round(n*1000)/1000).toFixed(3):'0.000'}