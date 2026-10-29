const fs = require("fs");
const path = require("path");
const postcss = require("postcss");
const { execSync } = require("child_process");

const ROOT = process.argv[2] || "/tmp/zhipei";
const GIT = process.argv.includes("--git");
const files = fs.readdirSync(path.join(ROOT, "css"))
  .filter((f) => f.endsWith(".css") && f !== "home.bundle.css")
  .map((f) => "css/" + f);

function scan(cssText) {
  const root = postcss.parse(cssText);
  let dup = 0;
  let decls = 0;
  const seen = new Map();
  const walk = (node, inAt) => {
    node.each((n) => {
      if (n.type === "atrule") {
        if (/^media|supports/.test(n.name)) walk(n, true);
        return;
      }
      if (n.type !== "rule" || inAt) return;
      if (!seen.has(n.selector)) seen.set(n.selector, new Set());
      const props = seen.get(n.selector);
      n.each((d) => {
        if (d.type !== "decl") return;
        decls++;
        if (props.has(d.prop)) dup++;
        props.add(d.prop);
      });
    });
  };
  walk(root, false);
  return { dup, decls };
}

let tb = { dup: 0, decls: 0 }, ta = { dup: 0, decls: 0 };
for (const rel of files) {
  const cur = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const a = scan(cur);
  ta.dup += a.dup; ta.decls += a.decls;
  if (GIT) {
    const old = execSync(`git -C ${ROOT} show HEAD:${rel}`, { encoding: "utf8", maxBuffer: 1 << 26 });
    const b = scan(old);
    tb.dup += b.dup; tb.decls += b.decls;
  }
}
if (GIT) console.log(`重复声明 ${tb.dup} -> ${ta.dup} | 声明总数 ${tb.decls} -> ${ta.decls}`);
else console.log(`重复声明 ${ta.dup} | 声明总数 ${ta.decls}`);
