/**
 * 智配One · 运单处理 —— 共享常量层
 * ----------------------------------------------------------
 * 本文件由 process.js 按职责拆分而来（P1-1g，零改写）。
 * waybillIndexKey：历史/删除/一致性三处共用的索引键构造（改此处即改全局，慎）。
 * todayCN：Asia/Shanghai 日期兜底——OCR 未识别日期且未手填时兜到「今天」，
 *   并保留 dateInferred 标记供追溯；杜绝空日期桶导致运单在历史/诊断两侧「消失」。
 */

export const waybillIndexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;
// 运单日期兜底（1.1 数据一致性）：OCR 未识别日期且未手填时，原实现会写 null，
// 导致其后 indexKey = zp:route:<routeId>:waybills: （空日期桶）——历史查询按日期枚举
// 取不到、诊断列表按日期格式过滤也取不到，运单在两侧同时「消失」。
// 兜底到「今天（Asia/Shanghai）」与司机实际上传日一致，并保留 dateInferred 标记供追溯。
export const todayCN=()=>{const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const v=Object.fromEntries(p.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return `${v.year}-${v.month}-${v.day}`};
export const number=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
