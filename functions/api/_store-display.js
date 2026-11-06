/**
 * 门店「简称」——只用于运单显示，不参与识别与匹配。
 * ------------------------------------------------------------------
 * 背景（2026-11-06）：门店全名常带「（临时）」「特渠部…」等前缀后缀，
 * 运单列表被撑成两行。简称只改展示，不得进入任何识别链路：
 *   - 不写入 aliases（学习别名仍由确认流程自动积累，仅用于匹配兜底）；
 *   - 不参与 stableStoreId 生成（否则改简称会生成新门店ID，身份漂移）；
 *   - 不参与基准库门店身份冲突校验（简称允许重复，不承载身份）；
 *   - 不写入全局学习库（学习记录只认标准名 + 别名）。
 * 读取侧统一走 displayNameOf()：运单快照里不存简称，老运单也能实时跟随基准库变化。
 */
const clean=v=>String(v??"").trim();

/** 简称硬上限：与数据中心输入框 maxlength、运单单行截断保持一致 */
export const SHORT_NAME_MAX=16;

/** 归一化简称：折叠空白、去控制字符、按字符截断（代理对不劈半） */
export function normalizeShortName(v){
 const s=clean(v).replace(/[\u0000-\u001f\u007f]/g,"").replace(/[\s\u3000]+/g," ");
 return Array.from(s).slice(0,SHORT_NAME_MAX).join("").trim();
}

/** 运单显示名：基准库简称优先，其次快照里已有的 displayName，最后回退全名。 */
export function displayNameOf(store,baseStore){
 return normalizeShortName(baseStore?.shortName)||clean(store?.displayName)||clean(store?.name)||clean(store?.rawName)||clean(store?.originalName);
}
