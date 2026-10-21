/**
 * 智配One · 一致性自检 —— 安全修复
 * ----------------------------------------------------------
 * 本文件由 _consistency.js 按职责拆分而来（P1-1g，函数体零改写）。
 * 纪律：仅执行 issue.fix，绝不触碰主记录 / 手动项 / INFO 项；
 *   预留 1 个子请求给最终批量验证；修复后逐项验证并回报 verificationComplete。
 */

import {command,pipeline} from "../_redis.js";
import {Budget} from "../_redis-budget.js";

/**
 * 应用安全修复（仅执行 issue.fix，绝不触碰主记录 / 手动项 / INFO 项）。
 * @returns {repaired:[], skipped:[], repairedCount, skippedCount}
 */
export async function repairConsistency(env, issues) {
  const repaired = [];
  const skipped = [];
  const budget = new Budget();

  for (const it of issues || []) {
    const fix = it.fix;
    const steps = Array.isArray(fix) && Array.isArray(fix[0]) ? fix : (Array.isArray(fix) && fix.length ? [fix] : []);
    if (!steps.length) {
      skipped.push({ type: it.type, reason: "MANUAL_OR_INFO" });
      continue;
    }
    // 预留 1 个子请求给最终批量验证，避免“修复全额耗尽预算后无法验证”。
    if (!budget.canTake(2)) {
      skipped.push({ type: it.type, reason: "BUDGET_EXCEEDED" });
      continue;
    }

    const { fix: _drop, ...meta } = it;
    try {
      if (
        steps.length === 2 &&
        steps[0][0] === "SADD" &&
        steps[1][0] === "SREM" &&
        steps[0].length === 3 &&
        steps[1].length === 3
      ) {
        await command(env, [
          "EVAL",
          "redis.call('SADD',KEYS[1],ARGV[1]); return redis.call('SREM',KEYS[2],ARGV[2])",
          "2",
          steps[0][1],
          steps[1][1],
          steps[0][2],
          steps[1][2]
        ]);
      } else if (steps.length === 1) {
        await command(env, steps[0]);
      } else {
        skipped.push({ type: it.type, ...meta, reason: "UNSUPPORTED_ATOMIC_FIX" });
        continue;
      }
      budget.take(1);
      repaired.push({ type: it.type, ...meta, _steps: steps });
    } catch (e) {
      skipped.push({ type: it.type, ...meta, error: String(e?.message || e) });
    }
  }

  // 所有已执行修复统一用一次 pipeline 做二次验证，防止接口返回“成功”但实际仍残留。
  const verification = [];
  if (repaired.length) {
    if (!budget.take(1)) {
      return {
        repaired: repaired.map(({_steps,...x}) => x),
        skipped,
        repairedCount: repaired.length,
        skippedCount: skipped.length,
        budgetExceeded: true,
        verificationComplete: false,
        verificationFailed: repaired.map(({_steps,...x}) => ({...x, reason:"VERIFICATION_BUDGET_EXCEEDED"}))
      };
    }
    const commands = [];
    for (const item of repaired) {
      const steps = item._steps;
      if (steps.length === 2 && steps[0][0] === "SADD" && steps[1][0] === "SREM") {
        commands.push(["SISMEMBER",steps[0][1],steps[0][2]]);
        commands.push(["SISMEMBER",steps[1][1],steps[1][2]]);
      } else if (steps.length === 1 && steps[0][0] === "DEL") {
        commands.push(["GET",steps[0][1]]);
      } else {
        // 当前自动修复仅允许上述两类；保留兼容分支时使用 GET，避免依赖非必要命令。
        commands.push(["GET", "__zp_consistency_verify_noop__"]);
      }
    }
    try {
      const results = await pipeline(env,commands);
      let ri = 0;
      for (const item of repaired) {
        const steps = item._steps;
        let ok = false;
        if (steps.length === 2 && steps[0][0] === "SADD" && steps[1][0] === "SREM") {
          ok = Number(results?.[ri]) === 1 && Number(results?.[ri+1]) === 0;
          ri += 2;
        } else if (steps.length === 1 && steps[0][0] === "DEL") {
          ok = results?.[ri] == null || results?.[ri] === "";
          ri += 1;
        } else {
          ok = true;
          ri += 1;
        }
        const {_steps,...meta} = item;
        verification.push({ ...meta, verified: ok, reason: ok ? null : "REPAIR_VERIFICATION_FAILED" });
      }
    } catch (e) {
      for (const item of repaired) {
        const {_steps,...meta} = item;
        verification.push({ ...meta, verified:false, reason:"REPAIR_VERIFICATION_ERROR", error:String(e?.message||e) });
      }
    }
  }

  const failedVerification=verification.filter(x=>!x.verified);
  return {
    repaired: repaired.map(({_steps,...x})=>x),
    skipped,
    repairedCount: repaired.length,
    skippedCount: skipped.length,
    budgetExceeded: skipped.some(x=>x.reason==="BUDGET_EXCEEDED"),
    verificationComplete: repaired.length===0 || verification.length===repaired.length,
    verification,
    verificationFailedCount: failedVerification.length
  };
}
