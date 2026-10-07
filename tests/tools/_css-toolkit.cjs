/**
 * CSS 工具共享依赖加载器
 *
 * 三个验证工具（css-fingerprint / css-beautify / css-var-resolve / css-rules-diff）都依赖 postcss，
 * 而 postcss 属于项目 devDependencies，CI 或本地未安装时不该抛一段看不懂的 MODULE_NOT_FOUND。
 * 这里统一处理：优先本地 node_modules → 其次 /tmp/csstools（本次改造的沙箱安装位）→ 兜底给清晰指引。
 */

function loadPostcss() {
  try {
    return require("postcss");
  } catch (_) {
    // 本地未装，尝试本次改造在沙箱中的安装位
  }
  try {
    process.env.NODE_PATH = "/tmp/csstools/node_modules";
    require("module").Module._initPaths();
    return require("postcss");
  } catch (_) {
    console.error(
      [
        "",
        "[缺少依赖] 需要 postcss 才能运行 CSS 验证工具。",
        "请执行：  npm install --save-dev postcss",
        "然后重跑本工具。",
        "",
      ].join("\n")
    );
    process.exit(2);
  }
}

module.exports = { loadPostcss };
