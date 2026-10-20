/**
 * 页面跳转预取 + 无扩展名页面缓存头 回归测试
 * ------------------------------------------------------------------
 * 针对中国大陆跨境链路（实测每连接 TLS 2~13s、文档 TTFB 0.35~7.4s）做的两项优化，
 * 这里是它们的守门测试：任何一端被改回去都会在这里失败。
 *
 * 覆盖：
 *   1. _headers：SW 不缓存；无扩展名页面路由必须给出「短 TTL + stale-while-revalidate」；
 *      哈希化的 JS/CSS 仍必须 immutable（防止有人图省事改成通配规则把它们一起吞掉）。
 *   2. js/ui-unified.js：预取实现的三条铁律——只预取同源静态页面、
 *      跳过 /api 与第三方、弱网/省流量模式不预取；以及幂等上限。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const headers = readFileSync(path.join(root, "_headers"), "utf8");
const ui = readFileSync(path.join(root, "js/ui-unified.js"), "utf8");

let failures = 0;
const check = (cond, label) => {
  console.log((cond ? "  ✓" : "  ✗") + " " + label);
  if (!cond) failures++;
};

console.log("【1】_headers 缓存策略");
{
  const rule = p => {
    const re = new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\n([\\s\\S]*?)(?=\\n[^ \\t\\n]|$)", "m");
    const m = headers.match(re);
    return m ? m[1] : "";
  };
  const swBlock = rule("/sw.js");
  check(/no-store/.test(swBlock), "/sw.js 仍然 no-store（新版本 SW 必须能下发）");

  // 无扩展名页面路由：Pages 的 /*.html 规则匹配不到它们，必须单独给策略
  // "/" 是站点唯一入口（冷启动 + 登录守卫跳转目标），漏掉它就等于每次进入都跨境重下外壳，
  // 其余页面再快也补不回来，所以它是这条防线里优先级最高的一个。
  const pretty = ["/", "/home", "/pages/*", "/history", "/dispatch", "/today", "/account", "/data", "/admin", "/login", "/register", "/setup", "/admin-bootstrap"];
  for (const p of pretty) {
    const b = rule(p);
    check(/max-age=120/.test(b) && /stale-while-revalidate=86400/.test(b),
      `${p}：max-age=120 + stale-while-revalidate=86400（跳转秒开 + 后台静默更新）`);
  }

  const jsBlock = rule("/js/*"), cssBlock = rule("/css/*");
  check(/immutable/.test(jsBlock) && /max-age=31536000/.test(jsBlock), "/js/* 仍 immutable-year（哈希化资产不能被通配规则波及）");
  check(/immutable/.test(cssBlock) && /max-age=31536000/.test(cssBlock), "/css/* 仍 immutable-year");
}

console.log("\n【2】js/ui-unified.js 预取实现的三条铁律");
{
  check(/rel="prefetch"/.test(ui), "使用 link rel=prefetch（低优先级，不与当前页争带宽）");
  check(/if\(u\.origin!==location\.origin\)return null;/.test(ui), "铁律1：跨源目标直接放弃");
  check(/if\(p\.indexOf\("\/api\/"\)===0\)return null;/.test(ui), "铁律1：/api/* 永不预取");
  const allowed = (ui.match(/const allowed=\(\)=>\{[\s\S]*?\n  \};/) || [""])[0];
  check(/c\.saveData/.test(allowed), "铁律2：省流量模式（saveData）不预取");
  check(/effectiveType/.test(allowed) && /slow-2g|2g/.test(allowed), "铁律2：2g/slow-2g 弱网不预取");
  check(/return true;\s*\}/.test(allowed), "铁律2：正常网络下才放行预取");
  check(/MAX=4/.test(ui) && /done\.size>=MAX/.test(ui), "有幂等 + 次数上限，避免弱网被预取挤爆");
  check(/__zpNavPrefetchInstalled/.test(ui), "安装一次，重复引入不会重复注册监听");
  check(/requestIdleCallback/.test(ui) && /setTimeout\(warmOnIdle,1500\)/.test(ui), "空闲才预热，首屏不受影响；无 rIC 时有兜底");
  check(/\(document\.head\|\|document\.documentElement\)\.appendChild\(link\)/.test(ui), "插入位置有兜底（head 缺失时不抛错）");
  const pointerCount = (ui.match(/pointerdown|touchstart/g) || []).length;
  check(pointerCount >= 2, "支持意图预取（pointerdown / touchstart 早于 click 起跑）");
}

console.log("\n【3】预取目标表不含动态业务页的危险项");
{
  const targetBlock = (ui.match(/const TARGETS=\{[\s\S]*?\};/) || [""])[0];
  check(targetBlock.length > 0, "目标表存在");
  check(!/\/api\//.test(targetBlock), "目标表里没有任何 /api/ 路径");
  check(!/https?:\/\//.test(targetBlock), "目标表里没有任何外站 URL");
  // 详情页只预取基础路径，不带业务参数，避免把某一天的查询结果塞进缓存
  check(/\/pages\/order_detail"/.test(targetBlock) && !/order_detail\?/.test(targetBlock), "详情页只预热基础路径（不带业务参数）");
}

console.log(failures ? `\n结果：${failures} 项失败` : "\n结果：全部通过");
process.exit(failures ? 1 : 0);
