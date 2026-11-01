// 智配One · 管理员第五页布局一致性回归（P0 #2）
// ------------------------------------------------------------------
// 静态校验 admin.html 的「5 标签页」布局模型自洽：
//   CSS  .pages 宽度 = 500%（5 页）且 .page 宽度 = 20%；
//   JS   page(i){ S.page=Math.max(0,Math.min(4,i)); translateX(-S.page*20%) }
//   即 5 × 20% = 100%，与 JS 五页模型（下标 0..4）严格一致。
// 此前缺陷：.pages=400% / .page=25% 与 JS 五页(20%)模型错配，第五页被压出视口。
//
// 2026-10-21 更新：admin.html 已拆分为「骨架 + 4 个 CSS + 11 个 JS 模块」，
// 内联样式与脚本都不在 admin.html 里了。这里改为**按目录聚合**读取
// （css/admin-*.css 全部拼接 + js/admin/*.js 全部拼接），
// 这样断言的是"这套模块合起来是否仍然自洽"，后续再挪文件也不会误报。
// 运行：node tests/integration-admin-fifthpage.cjs
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function concat(dir, pattern) {
  return fs.readdirSync(dir)
    .filter(n => pattern.test(n))
    .sort()
    .map(n => fs.readFileSync(path.join(dir, n), "utf8"))
    .join("\n");
}

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

(async () => {
  // 拆分后：CSS 在 css/admin-*.css，JS 在 js/admin/*.js，admin.html 只剩骨架
  const cssAll = concat(path.join(ROOT, "css"), /^admin-.*\.css$/);
  const jsAll = concat(path.join(ROOT, "js", "admin"), /^.*\.js$/);
  const html = cssAll + "\n" + jsAll;
  const adminHtml = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  check("性能诊断复制优先使用 Clipboard API，并保留 execCommand 兼容回退",
    jsAll.includes('const perfCopyButton=$("perfCopy")')
      && jsAll.includes("navigator.clipboard")
      && jsAll.includes('document.execCommand("copy")'));
  const diagnosticsJs = fs.readFileSync(path.join(ROOT, "js", "admin", "diagnostics.js"), "utf8");
  check("运单诊断复制从 payload 索引读取完整诊断，不将大段 JSON 塞入 DOM",
    /document\.querySelectorAll\("#diagnostics \.diag-copy"\)[\s\S]*?copyPayloads\[copyIndex\]/.test(diagnosticsJs)
      && diagnosticsJs.includes('data-copy-index="')
      && diagnosticsJs.includes("JSON.stringify(w,null,2)")
      && !diagnosticsJs.includes('data-copy="'));
  check("运单诊断复制的临时文本框清理具备异常保护",
    /finally\{try\{if\(ta&&ta\.parentNode\)ta\.parentNode\.removeChild\(ta\);\}catch\(e\)\{\}\}/.test(diagnosticsJs));
  check("复制点击处理完整兜底：剪贴板、DOM回退和提示异常均不会向全局冒泡",
    jsAll.includes("if(perfCopyButton)perfCopyButton.onclick=async()=>{")
      && jsAll.includes("catch(e){copied=false;}")
      && jsAll.includes("if(ta&&ta.parentNode)ta.parentNode.removeChild(ta)")
      && jsAll.includes("[zp-perf-copy] 提示显示失败"));
  check("失败记录自动归档提示收纳在独立查询面板底部，不挤压筛选控件",
    /class="diag-query-panel"[\s\S]*?class="diag-filters"[\s\S]*?class="diag-query-foot"[\s\S]*?失败记录自动归档/.test(adminHtml)
      && !/<div class="diag-filters"[\s\S]*?class="meta diag-archive-hint"/.test(adminHtml));
  check("拆分产物存在：css/admin-*.css 与 js/admin/*.js 均非空",
    cssAll.length > 1000 && jsAll.length > 1000,
    `css=${cssAll.length}B js=${jsAll.length}B`);

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
