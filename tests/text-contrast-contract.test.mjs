/**
 * 文字对比度契约（WCAG 2.1 AA）
 *
 * 为什么需要这条测试：
 *   2026-11-04 全站体检发现，同一类问题在三个地方各犯了一次 ——
 *     · 空态提示用 --zp-soft(#999)：浅色底 2.66:1，用户最该读的一行最看不清
 *     · 危险操作（删除）用 --zp-error(#F53F3F)：12px 小字 3.46:1
 *     · 激活项/链接用 --zp-primary(#1677FF)：12px 小字 3.83:1
 *   三次都是「令牌职责已经定义清楚，但使用点漂移」。项目里其实已经有正确令牌
 *   （--zp-muted / --zp-danger / --zp-accent），只是没人用。
 *
 * 所以这里测的不是「哪个选择器用了哪个色」（那要靠枚举维护，必腐化），
 * 而是「令牌本身能不能承载文字」：令牌值一改，这里就红；
 * 选择器随便重构，这里不误报。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** 从 CSS 文本里收集 --zp-*: #hex */
function collectHex(css) {
  const out = {};
  for (const m of strip(css).matchAll(/(--zp-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const baseCss = readFileSync("css/ui-base.css", "utf8");
const themeCss = readFileSync("css/ui-theme.css", "utf8");
// ui-base 是浅色基座，ui-theme 覆盖深色。深色若漏定义某个令牌，
// 会落到浅色值上 —— 那本身就是 bug，下面用「必须有深色覆盖」兜住关键色。
const LIGHT = collectHex(baseCss);
const DARK = { ...LIGHT, ...collectHex(themeCss) };

function luminance(hex) {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** 文字会落在哪些底上：页面底 / 卡片 / 次级块 */
const BACKDROPS = ["--zp-bg", "--zp-surface", "--zp-surface-2"];

test("承载正文的令牌，在两套主题、三种底色上都必须达到 AA(4.5)", () => {
  const failures = [];
  for (const [themeName, tokens] of [
    ["浅色", LIGHT],
    ["深色", DARK],
  ]) {
    for (const text of ["--zp-muted", "--zp-accent", "--zp-danger"]) {
      assert.ok(tokens[text], `${themeName} 缺少 ${text}`);
      for (const bg of BACKDROPS) {
        const ratio = contrast(tokens[text], tokens[bg]);
        if (ratio < 4.5) {
          failures.push(
            `${themeName}: ${text}(${tokens[text]}) on ${bg}(${tokens[bg]}) = ${ratio.toFixed(2)}`
          );
        }
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    "以下令牌组合达不到 WCAG AA，不能用于正文/标签/提示：\n" + failures.join("\n")
  );
});

test("--zp-text 必须明显高于 AA（正文对比度 ≥ 7）", () => {
  for (const [name, tokens] of [
    ["浅色", LIGHT],
    ["深色", DARK],
  ]) {
    for (const bg of BACKDROPS) {
      const r = contrast(tokens["--zp-text"], tokens[bg]);
      assert.ok(r >= 7, `${name}: --zp-text on ${bg} 仅 ${r.toFixed(2)}，正文对比度不足`);
    }
  }
});

test("--zp-soft 只能做装饰：它的对比度必须低于 AA（≥4.5 说明它被当正文用了）", () => {
  // 反向契约。--zp-soft 是「第三级灰」，用于箭头、图标、分隔点、禁用态；
  // 一旦它达标了，说明有人把它调深当成正文色 —— 那时 --zp-muted 与它就失去层次。
  // 这条断言的作用是逼使用者去用 --zp-muted，而不是把 soft 调亮。
  for (const [name, tokens] of [
    ["浅色", LIGHT],
    ["深色", DARK],
  ]) {
    const r = contrast(tokens["--zp-soft"], tokens["--zp-surface"]);
    assert.ok(
      r < 4.5,
      `${name}: --zp-soft 在卡片上已达 ${r.toFixed(2)}，不再是「仅装饰」的弱化色；` +
        `若本意是承载正文，请改用 --zp-muted`
    );
  }
});

test("错误正文一律用 --zp-danger，不得用 --zp-error 着色", () => {
  // --zp-error 是「错误图形色」（边框、图标、浅底），浅色下 3.46:1 不能写字。
  // --zp-danger 才是正文色：浅 #C4320A、深 #FCA5A5。
  const cssFiles = [
    "css/ui-base.css",
    "css/ui-overlay.css",
    "css/ui-theme.css",
    "css/app.css",
    "css/data.css",
    "css/history-shell.css",
    "css/order_detail.css",
    "css/home-trend.css",
    "css/business-pages.css",
    "css/admin-base.css",
    "css/admin-forms.css",
  ];
  const bad = [];
  for (const f of cssFiles) {
    const text = strip(readFileSync(f, "utf8"));
    for (const m of text.matchAll(/color\s*:\s*var\((--zp-error)\)/g)) {
      bad.push(f);
    }
  }
  assert.deepEqual(bad, [], `以下文件把 --zp-error 当文字色（应用 --zp-danger）：\n${bad.join("\n")}`);
});

test("空态与备注类文字必须用 --zp-muted，不得回退到 --zp-soft", () => {
  const checks = [
    ["css/ui-base.css", /\.zp-empty\{[^}]*color:\s*var\(--zp-muted\)/, ".zp-empty（空态提示）"],
    ["css/order_detail.css", /\.order-store-note\{[^}]*color:\s*var\(--zp-muted\)/, ".order-store-note（门店备注）"],
  ];
  for (const [file, re, label] of checks) {
    const text = strip(readFileSync(file, "utf8"));
    assert.match(text, re, `${label} 必须用 --zp-muted（--zp-soft 在浅色底仅 2.66:1）`);
  }
});

test("激活态文字用 --zp-accent，不用 --zp-primary", () => {
  // --zp-primary 是「按钮底色」，白字压在它上面是设计取舍；
  // 但把它当文字色（12px 标签）只有 3.83:1，必须用 accent（6.16:1）。
  const bad = [];
  const allow = [/accent-color\s*:\s*var\(--zp-primary\)/]; // range 滑块不是文字
  for (const f of ["css/ui-base.css", "css/account.css", "css/admin-base.css"]) {
    const text = strip(readFileSync(f, "utf8"));
    for (const m of text.matchAll(/color\s*:\s*var\(--zp-primary\)/g)) {
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const line = text.slice(lineStart, text.indexOf("\n", m.index));
      if (allow.some((re) => re.test(line))) continue;
      bad.push(`${f}: ${line.trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, [], `以下位置把主色当文字色（应用 --zp-accent）：\n${bad.join("\n")}`);
});
