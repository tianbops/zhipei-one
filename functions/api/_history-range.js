/**
 * 智配One · 历史查询 —— 第 0 层：日期与范围工具
 * ----------------------------------------------------------
 * 本文件由 history.js 按职责拆分而来（P1-1g，函数体零改写）。
 * 原公开面（history-export.js / history-lookup.js 依赖）经入口 re-export 保持不变：
 *   clean / historyRange / validDate / inRange / monthInRange
 * historyRange 语义：默认 13 个月滚动窗口、止于次月末（不可篡改，删除范围依赖它）。
 */

export const clean=v=>String(v??"").trim();
export const todayCN=()=>{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const values=Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));return `${values.year}-${values.month}-${values.day}`;};
const endOfNextMonth=date=>{const [y,m]=date.split("-").map(Number);return new Date(Date.UTC(y,m+1,0)).toISOString().slice(0,10)};
// 历史查询/保存窗口：默认 13 个月滚动窗口，止于次月末。可经 WAYBILL_HISTORY_MONTHS 调整（仅影响可查询范围，不启用任何破坏性自动清理）。
export const historyRange=(today,months)=>{const n=Math.max(1,Math.min(120,Math.floor(Number(months)||13)));const [y,m]=today.split("-").map(Number);let startIdx=(y*12+(m-1))-(n-2);const sy=Math.floor(startIdx/12),sm=startIdx%12+1;return {start:`${sy}-${String(sm).padStart(2,"0")}-01`,end:endOfNextMonth(today),months:n};};
export const validDate=date=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const [y,m,d]=date.split("-").map(Number);const parsed=new Date(Date.UTC(y,m-1,d));return parsed.getUTCFullYear()===y&&parsed.getUTCMonth()===m-1&&parsed.getUTCDate()===d;};
export const inRange=(date,range)=>date>=range.start&&date<=range.end;
export const monthInRange=(month,range)=>month>=range.start.slice(0,7)&&month<=range.end.slice(0,7);
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary&&x.historyStatus!=="SUPERSEDED";
export const historyReadable=x=>validWaybill(x)&&["PLANNED","CONFIRMED"].includes(x.stage);
export const waybillIndexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;
