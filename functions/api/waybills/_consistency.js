/**
 * 智配One · 运单数据一致性自检 + 外科手术式修复（1.1 核心增强 · P1.5）
 * ------------------------------------------------------------------
 * 只读扫描 Redis 中运单相关键，比对「索引 / 日去重键 / 内容指纹键 / 事件链 / 主记录」
 * 之间的引用完整性，输出可解释差异报告；并可应用 ONLY 安全修复（删除悬空引用、
 * 按主记录补回缺失索引）。绝不整体重建 Redis、绝不擅自删除主记录
 * （MANUAL 项由运维人工拍板，INFO 项 TTL 自动清理）。
 *
 * 键结构（见 process.js / history.js / _waybill-events.js / _waybill-proc.js）：
 *   主记录   zp:waybill:<id>
 *   索引     zp:route:<routeId>:waybills:<date>  (SET，存 waybill id)
 *   日去重   zp:waybill:dedupe:<dailySig>         (string -> id)
 *   内容指纹 zp:waybill:fingerprint:<fp>           (string -> id)
 *   事件链   zp:waybill:<id>:events                (List)
 *   处理票据 zp:waybill:proc:<requestId>           (TTL 15min)
 */
import { command, pipeline } from "../_redis.js";
import { Budget, SUBREQUEST_LIMIT, scanKeysBudgeted, mgetBatchMap, smembersBatch } from "../_redis-budget.js";
import { businessFingerprint, dailyWaybillKey } from "../_waybill-identity.js";

/* ================================================================
 * 入口（P1-1g 拆分）：实现已按职责拆到三个兄弟模块，本文件只做转发，
 * diagnostic.js 的 import 契约（scanConsistency / repairConsistency / default）
 * 与拆分前逐一对应。
 * ================================================================ */

import {scanConsistency} from "./_consistency-scan.js";
import {repairConsistency} from "./_consistency-repair.js";

export {scanConsistency, repairConsistency};
export default {scanConsistency, repairConsistency};
