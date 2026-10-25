/* 智配One · ESLint flat 配置（P1-2 工程化工具链）
 * ------------------------------------------------------------------
 * 目标：把「语法/逻辑级错误」（重复键、不可达代码、常量自赋值、const 重赋值等）
 * 在提交前暴露，而不是逐字统一代码风格。
 *
 * 为什么规则如此宽松：本仓库前端是**经典脚本 + 跨文件共享全局词法环境 + 大量内联
 * 助手函数（$() 等）**，且 js/*.js、functions/*.js、tests/*.mjs/cjs 的模块类型各异。
 * 若开启 recommended 全套，会产生大量与「非传统架构」相关的误报（no-unused-vars /
 * no-undef 等），反而淹没真正的 bug。故：
 *   · 按文件组分别声明 sourceType（script / module / commonjs）；
 *   · 关掉一切风格类/易误报规则（no-unused-vars / no-undef / no-empty …）；
 *   · 只保留一组**高信号、零误报**的正确性规则；
 *   · 代码风格统一交给 Prettier（见 .prettierrc）。
 *
 * 本配置刻意不接入会阻断 CI 的链（test:node 不含 lint）；lint 作为可选提交前检查。
 */

// Node 全局（内联，避免依赖外部 globals 包的加载顺序问题）
const NODE_GLOBALS = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  module: "writable",
  require: "readonly",
  exports: "writable",
  global: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  Promise: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  fetch: "readonly",
  structuredClone: "readonly",
};

// 高信号、零误报的正确性规则（不碰风格）
const CORRECTNESS_RULES = {
  "no-dupe-keys": "error",
  "no-dupe-else-if": "error",
  "no-duplicate-case": "error",
  "no-unreachable": "error",
  "no-self-assign": "error",
  "no-const-assign": "error",
  "no-func-assign": "error",
  "no-class-assign": "error",
  "no-import-assign": "error",
  "no-cond-assign": "error",
  "no-constant-binary-expression": "error",
  "no-unsafe-negation": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
  // 明确关闭易误报 / 风格类规则
  "no-unused-vars": "off",
  "no-undef": "off",
  "no-empty": "off",
  "no-constant-condition": "off",
  "no-fallthrough": "off",
  "no-prototype-builtins": "off",
  "no-control-regex": "off",
};

module.exports = [
  // 默认忽略：不解析非 JS 资产与第三方代码
  {
    ignores: [
      "node_modules/**",
      "css/**",
      "docs/**",
      "*.min.js",
      "package-lock.json",
      ".workbuddy/**",
    ],
  },

  // 前端经典脚本 + Service Worker：浏览器全局，script 源码类型
  {
    files: ["js/**/*.js", "sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        location: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        indexedDB: "readonly",
        fetch: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Promise: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        crypto: "readonly",
        Blob: "readonly",
        File: "readonly",
        FileReader: "readonly",
        FormData: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        self: "readonly",
        caches: "readonly",
      },
    },
    rules: CORRECTNESS_RULES,
  },

  // Cloudflare Pages Functions：ESM + Workers 运行时
  {
    files: ["functions/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        fetch: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        console: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        crypto: "readonly",
        btoa: "readonly",
        atob: "readonly",
        ReadableStream: "readonly",
      },
    },
    rules: CORRECTNESS_RULES,
  },

  // 测试 ESM（node:test / node:assert）
  {
    files: ["tests/**/*.mjs", "**/*.mjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: NODE_GLOBALS },
    rules: CORRECTNESS_RULES,
  },

  // 测试 CJS
  {
    files: ["tests/**/*.cjs", "**/*.cjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: NODE_GLOBALS },
    rules: CORRECTNESS_RULES,
  },
];
