/* 数据资料「去卡片化」静态契约（UI 2.7）
 * 仅「当前调度线路」(.data-route-card) 保留卡片；批量操作区 (.data-tools-card) 与
 * 门店资料列表 (.data-list-card) 改为页面底色 + 去边框 + 去圆角 + 去阴影，
 * 与首页 / 运单详情统一。仅校验 css/data.css 源文件结构，不依赖线上。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const rd = p => readFileSync(join(ROOT, p), 'utf8');

const CSS = rd('css/data.css');

/* 取「末尾」覆盖块：同名基础规则在前部，须用包含 background:var(--zp-bg) 的块锁定末尾覆盖 */
const TOOLS_OVERRIDE = CSS.match(/\.data-tools-card\{[^}]*background:var\(--zp-bg\)[^}]*\}/)?.[0] || '';
const LIST_OVERRIDE = CSS.match(/\.data-list-card\{[^}]*background:var\(--zp-bg\)[^}]*\}/)?.[0] || '';

let n = 0, pass = 0;
const t = (name, cond, extra) => {
  n++;
  if (cond) pass++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
};

console.log('一、批量操作区 .data-tools-card 去卡片化：页面底色 + 去边框 + 去圆角 + 去阴影');
{
  t('存在末尾覆盖块且 background=页面底色 --zp-bg',
    /background:var\(--zp-bg\)/.test(TOOLS_OVERRIDE), TOOLS_OVERRIDE);
  t('.data-tools-card border:0',
    /border:0/.test(TOOLS_OVERRIDE), TOOLS_OVERRIDE);
  t('.data-tools-card border-radius:0（圆角随卡片去除）',
    /border-radius:0/.test(TOOLS_OVERRIDE), TOOLS_OVERRIDE);
  t('.data-tools-card box-shadow:none',
    /box-shadow:none/.test(TOOLS_OVERRIDE), TOOLS_OVERRIDE);
  t('覆盖块不重新声明 card 底色（避免改回去）',
    !/background:var\(--zp-card\)/.test(TOOLS_OVERRIDE), TOOLS_OVERRIDE);
}

console.log('二、门店资料列表 .data-list-card 去卡片化：页面底色 + 去边框 + 去圆角 + 去阴影');
{
  t('存在末尾覆盖块且 background=页面底色 --zp-bg',
    /background:var\(--zp-bg\)/.test(LIST_OVERRIDE), LIST_OVERRIDE);
  t('.data-list-card border:0',
    /border:0/.test(LIST_OVERRIDE), LIST_OVERRIDE);
  t('.data-list-card border-radius:0（圆角随卡片去除）',
    /border-radius:0/.test(LIST_OVERRIDE), LIST_OVERRIDE);
  t('.data-list-card box-shadow:none',
    /box-shadow:none/.test(LIST_OVERRIDE), LIST_OVERRIDE);
  t('覆盖块不重新声明 card 底色（避免改回去）',
    !/background:var\(--zp-card\)/.test(LIST_OVERRIDE), LIST_OVERRIDE);
}

console.log('三、当前调度线路 .data-route-card 保持不变（仍为卡片，未被去卡片化）');
{
  t('data.css 没有把 .data-route-card 改成页面底色（保留卡片）',
    !/\.data-route-card\{[^}]*background:var\(--zp-bg\)/.test(CSS),
    { routeBgOverride: /\.data-route-card\{[^}]*background:var\(--zp-bg\)/.test(CSS) });
  t('去卡片化只作用于 data 页面（不污染其它 page2-card 站点，如 account/route_apply）',
    !/\.page2-card\{[^}]*background:var\(--zp-bg\)/.test(CSS),
    { page2Override: /\.page2-card\{[^}]*background:var\(--zp-bg\)/.test(CSS) });
}

console.log('\n通过 ' + pass + '/' + n + (pass === n ? ' ✓' : ' ✗'));
process.exit(pass === n ? 0 : 1);
