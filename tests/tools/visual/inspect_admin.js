/* admin.html Token 订阅验证（阶段 8 子集 · ⑥ 闭环）
 * 用法：node tests/tools/visual/inspect_admin.js <url> [outPng]
 *
 * 依赖（仅本地视觉验证用，与 inspect_page.js 同源）：
 *   puppeteer-core（系统 Chromium，CHROME_PATH 可覆盖）
 *
 * 双重验证（证明 admin 内联 :root 已订阅 --zp-* 单一真相源，而非写死）：
 *   1) 基线：6 个 token 经静态 shell 元素的 computed 值 == 预期十六进制
 *      （body→--bg / #who→--soft / .admin-nav→--bg&--line / .nav-item→--muted / .nav-item.active→--card）
 *      证明改动「零视觉回归」。
 *   2) 订阅证明：注入 :root{--zp-*:彩色!important}，断言上述元素颜色「跟随」--zp-*。
 *      若 admin 仍写死旧值则不会跟随；跟随即实锤已订阅真相源。
 */
const puppeteer = require("/tmp/visualtools/node_modules/puppeteer-core");

// 预期基线（admin 内联 :root 原值，逐字节对应 --zp-* 真相源）
const EXPECT = {
  bodyBg: "rgb(5, 7, 10)",          // --bg = --zp-bg #05070A
  whoColor: "rgb(127, 138, 149)",   // --soft = --zp-soft #7F8A95
  tabsBg: "rgb(5, 7, 10)",          // --bg = --zp-bg #05070A
  tabsBorder: "rgb(42, 53, 64)",    // --line = --zp-line #2A3540
  tabColor: "rgb(184, 194, 204)",   // --muted = --zp-muted #B8C2CC
  tabActiveBg: "rgb(28, 37, 48)",   // --card = --zp-card #1C2530
};

// 订阅证明注入值（与 EXPECT 一一对应，故意用醒目彩色）
const INJECT = `:root{
  --zp-bg:#FF0000!important;
  --zp-surface-2:#00FF00!important;
  --zp-line:#0000FF!important;
  --zp-muted:#FFFF00!important;
  --zp-soft:#FF00FF!important;
  --zp-card:#000000!important;
}`;
const INJECTED = {
  bodyBg: "rgb(255, 0, 0)",
  whoColor: "rgb(255, 0, 255)",
  tabsBg: "rgb(255, 0, 0)",
  tabsBorder: "rgb(0, 0, 255)",
  tabColor: "rgb(255, 255, 0)",
  tabActiveBg: "rgb(0, 0, 0)",
};

(async () => {
  const [url, out] = process.argv.slice(2);
  if (!url) { console.error("用法: node inspect_admin.js <url> [outPng]"); process.exit(2); }

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  // 仅验证静态 shell 的计算样式（.head/.admin-nav/.nav-item/#who 均为静态 HTML，无需 JS）。
  // 禁用 JS 可避免 admin 在 mock 未认证下重定向到登录页，保证订阅证明确定可复现。
  await page.setJavaScriptEnabled(false);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 900));

  const read = () => page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return getComputedStyle(el)[prop];
    };
    return {
      bodyBg: cs("body", "backgroundColor"),
      whoColor: cs("#who", "color"),
      tabsBg: cs(".admin-nav", "backgroundColor"),
      tabsBorder: cs(".admin-nav", "borderTopColor"),
      tabColor: cs(".nav-item:not(.active)", "color"),
      tabActiveBg: cs(".nav-item.active", "backgroundColor"),
    };
  });

  const baseline = await read();
  if (out) await page.screenshot({ path: out });

  // 订阅证明：注入 --zp-* 覆盖，再读
  await page.addStyleTag({ content: INJECT });
  await new Promise((r) => setTimeout(r, 300));
  if (out) await page.screenshot({ path: out.replace(/\.png$/, ".subscribed.png") });
  const subscribed = await read();
  await browser.close();

  const cmp = (obj, exp) => Object.fromEntries(
    Object.keys(exp).map((k) => [k, { actual: obj[k], expect: exp[k], ok: obj[k] === exp[k] }])
  );
  const baseChk = cmp(baseline, EXPECT);
  const subChk = cmp(subscribed, INJECTED);
  const basePass = Object.values(baseChk).every((x) => x.ok);
  const subPass = Object.values(subChk).every((x) => x.ok);

  const report = {
    url,
    baseline: baseChk,
    baselinePass: basePass,
    subscription: subChk,
    subscriptionPass: subPass,
    pageErrors: errors,
    overall: basePass && subPass,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.overall ? 0 : 1);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
