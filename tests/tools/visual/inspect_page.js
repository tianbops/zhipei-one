/* 页面几何体检：横向溢出 + 关键元素几何 + 截图。
 * 用法：node tests/tools/visual/inspect_page.js <url> <outPng>
 *
 * 依赖（可选安装，仅本地视觉验证用）：
 *   pnpm add puppeteer-core   （浏览器用系统 Chromium，可用 CHROME_PATH 覆盖）
 *
 * 检查项：
 *   overflowX        横向溢出（>0 即溢出，并列出溢出源元素）
 *   topbar           页头高度（方案第十一章标准 54px）
 *   cards / rows     Card 与 Row 的几何 + 分隔线（第十四章/十五章标准）
 */
let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch {
  console.error("缺少依赖：先执行 `pnpm add puppeteer-core`（可选，仅本地视觉验证用）。");
  console.error("本工具必须显式失败，不允许假装检查通过。");
  process.exit(2);
}

(async () => {
  const [url, out] = process.argv.slice(2);
  if (!url) { console.error("用法: node inspect_page.js <url> [outPng]"); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 600));

  const geo = await page.evaluate(() => {
    const de = document.documentElement;
    const overflowX = de.scrollWidth - de.clientWidth;
    // 找出超出视口右缘的元素（溢出源）
    const culprits = [];
    if (overflowX > 0) {
      for (const el of document.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.right > de.clientWidth + 1 && r.width > 0) {
          culprits.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 2).join(".") : ""} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
          if (culprits.length >= 8) break;
        }
      }
    }
    const cards = [...document.querySelectorAll(".page2-card,.card,.data-list-card")].slice(0, 6).map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return `${el.className.split(" ").slice(0, 2).join(".")}: left=${Math.round(r.left)} right=${Math.round(r.right)} w=${Math.round(r.width)} pad=${cs.padding} radius=${cs.borderRadius} border=${cs.borderTopWidth}`;
    });
    const rows = [...document.querySelectorAll("[class*=row],[class*=store-item]")].slice(0, 4).map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return `${el.className.split(" ").slice(0, 2).join(".")}: h=${Math.round(r.height)} borderB=${cs.borderBottomWidth} ${cs.borderBottomColor}`;
    });
    return {
      layoutWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      overflowX,
      title: document.title,
      topbar: (() => { const t = document.querySelector("[class*=topbar]"); if (!t) return null; const r = t.getBoundingClientRect(); const c = getComputedStyle(t); return `h=${Math.round(r.height)} align=${c.alignItems}`; })(),
      cards, rows, culprits,
    };
  });
  console.log(JSON.stringify(geo, null, 2));
  if (out) await page.screenshot({ path: out });
  await browser.close();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
