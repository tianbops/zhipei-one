#!/usr/bin/env node
/**
 * compare_header.js —— 将当前 inspect_header.js 输出与基线逐字节比对（阶段 8 后续 · 5D 零回归门）
 *
 * 用法：node compare_header.js <baseline.ndjson> <current.ndjson>
 *   相等 → 打印 BASELINE_MATCH，退出 0
 *   有差异（几何或颜色任一字段）→ 逐条打印 DIFF，退出 1
 *   读取侧部分失败（navOk=false）也计为差异，绝不谎报 success。
 */
const fs = require('fs');
function load(p) {
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
const [bp, cp] = process.argv.slice(2);
if (!bp || !cp) { console.error('usage: node compare_header.js <baseline.ndjson> <current.ndjson>'); process.exit(2); }
let base, cur;
try { base = load(bp); } catch (e) { console.error('BASELINE_READ_FAIL: ' + e.message); process.exit(2); }
try { cur = load(cp); } catch (e) { console.error('CURRENT_READ_FAIL: ' + e.message); process.exit(2); }

const byUrl = (m) => { const o = {}; for (const x of m) o[x.url] = x; return o; };
const b = byUrl(base), c = byUrl(cur);
const keys = new Set([...base, ...cur].flatMap((o) => Object.keys(o)));
// url 是分组键不比；其余（含 navOk / headerHeight / backSize / overflowX / topbarHook / appBackHook / backColor / titleColor）全比
keys.delete('url');

let diffs = 0;
const urls = [...new Set([...Object.keys(b), ...Object.keys(c)])];
for (const u of urls) {
  const x = b[u], y = c[u];
  if (!x) { console.log('NEW   ' + u); diffs++; continue; }
  if (!y) { console.log('GONE  ' + u); diffs++; continue; }
  for (const k of keys) {
    if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) {
      console.log('DIFF  ' + u + '  ' + k + ': ' + JSON.stringify(x[k]) + ' -> ' + JSON.stringify(y[k]));
      diffs++;
    }
  }
}
if (diffs === 0) { console.log('BASELINE_MATCH: ' + base.length + ' pages identical (geometry+color)'); process.exit(0); }
else { console.log('BASELINE_DIFF: ' + diffs + ' diff(s)'); process.exit(1); }
