/**
 * CSS 工具共享依赖加载器
 *
 * CSS 验证工具统一从项目 devDependencies 加载 PostCSS。
 * CI 与本地均应先执行 npm ci，避免使用机器专属的临时 NODE_PATH 或隐藏缺失依赖。
 */

function loadPostcss() {
  try {
    return require("postcss");
  } catch (_) {
    console.error(
      [
        "",
        "[缺少依赖] CSS 验证工具需要项目 devDependency：postcss。",
        "请在仓库根目录执行：npm ci",
        "",
      ].join("\n")
    );
    process.exit(2);
  }
}

module.exports = { loadPostcss };
