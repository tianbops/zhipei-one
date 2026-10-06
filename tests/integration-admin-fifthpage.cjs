// 智配One · 管理员第五页布局一致性回归（P0 #2）
// ------------------------------------------------------------------
// 静态校验 admin.html 的「5 标签页」布局模型自洽：
//   CSS  .pages 宽度 = 500%（5 页）且 .page 宽度 = 20%；
//   JS   page(i){ S.page=Math.max(0,Math.min(4,i)); translateX(-S.page*20%) }
//   即 5 × 20% = 100%，与 JS 五页模型（下标 0..4）严格一致。
// 此前缺陷：.pages=400% / .page=25% 与 JS 五页(20%)模型错配，第五页被压出视口。
// 运行：node tests/integration-admin-fifthpage.cjs
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin.html"), "utf8");

  console.log("\n【P0-2】管理员第五页布局：CSS 宽度与 JS 五页模型一致");
  // CSS：.pages 总宽度应为 500%（5 个等宽页）
  const pagesW = (html.match(/\.pages\{[^}]*width:\s*(\d+)%/) || [])[1];
  check(".pages 总宽度 = 500%（5 页）", pagesW === "500", "width=" + (pagesW || "缺失"));
  // CSS：.page 单页宽度应为 20%
  const pageW = (html.match(/\.page\{[^}]*width:\s*(\d+)%/) || [])[1];
  check(".page 单页宽度 = 20%", pageW === "20", "width=" + (pageW || "缺失"));
  // 数学自洽：.pages=500% 容器正好容纳 5 个「每页 100% 视口」的页（500/100=5）；
  // .page=20% 是相对 500% 容器而言（100/20=5 个），与 JS 5 页模型自洽。
  check("布局自洽：.pages=500% 容纳 5 个整屏页（500/100=5）", Number(pagesW) === 500 && (Number(pagesW) / 100) === 5);
  const numPagesCss = Number(pagesW) / 100;     // 500/100 = 5 个整屏页
  const numPagesStep = 100 / Number(pageW);     // 100/20 = 5 个（每页占容器 20%）
  check("布局自洽：CSS 总宽(500%)与单页步长(20%)共同指向同一 5 页模型", numPagesCss === 5 && numPagesStep === 5 && numPagesCss === numPagesStep);

  // JS：page() 下标上限为 4（即 5 页：0..4）
  const pageFn = html.match(/function page\(i\)\{([^}]*)\}/);
  check("JS page() 存在", !!pageFn, pageFn ? pageFn[0].slice(0, 40) + "…" : "");
  const hasClamp = /Math\.max\(0,\s*Math\.min\(4,i\)\)/.test(html);
  check("JS page() 下标钳制为 0..4（共 5 页）", hasClamp);
  const translate20 = /translateX\(\s*-\s*"\s*\+\s*S\.page\s*\*\s*20/.test(html) || /S\.page\s*\*\s*20\s*%/.test(html);
  check("JS 翻页位移步长 = page*20%（与单页 20% 对齐）", translate20);

  // 旧缺陷不应残留：400% / 25% 模式已修复
  check("旧缺陷已清除：不再存在 .pages{width:400%}", !/\.pages\{[^}]*width:\s*400%/.test(html));
  check("旧缺陷已清除：不再存在 .page{width:25%}", !/\.page\{[^}]*width:\s*25%/.test(html));

  // 第五页渲染钩子存在（运单诊断 + 学习冲突隔离两个看板在最后一页渲染）
  check("第五页渲染钩子存在：S.page===4 触发诊断渲染", /S\.page===4/.test(html) && /renderDiagnostics\(\)/.test(html));

  console.log("─".repeat(56));
  console.log("管理员第五页布局回归：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
