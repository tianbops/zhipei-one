/* 运单详情 · 同日多运单「去卡片化」静态契约（UI 2.7）
 * 日期板块 (.order-summary-card) 保持卡片不变；下方运单卡 (.order-history-choice)
 * 改为页面底色 + 去边框 + 去圆角 + 去阴影，与单运单路线卡统一。
 * 外层 .order-route-card 已在 UI 2.6 去卡片化，此处只锁运单卡自身的去卡片化。
 * 仅校验 css/order_detail.css 源文件结构，不依赖线上。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const rd = p => readFileSync(join(ROOT, p), 'utf8');

const CSS = rd('css/order_detail.css');

/* 取末尾覆盖块：同名基础规则（.order-history-choice{...} 在文件前部定义 card 样式）
   须用包含 history-multi + background:var(--zp-bg) 的块锁定末尾覆盖。 */
const CHOICE_OVERRIDE = CSS.match(/\.order-shell\.history-multi \.order-history-choice\{[^}]*background:var\(--zp-bg\)[^}]*\}/)?.[0] || '';
/* 文件前部已有同名规则（margin-bottom / width），须用包含 border-radius:0 的块锁定末尾覆盖 */
const SWIPE_OVERRIDE = CSS.match(/\.order-shell\.history-multi \.order-history-swipe-row\{[^}]*border-radius:0[^}]*\}/)?.[0] || '';
const DELETE_OVERRIDE = CSS.match(/\.order-shell\.history-multi \.history-choice-delete\{[^}]*border-radius:0[^}]*\}/)?.[0] || '';

let n = 0, pass = 0;
const t = (name, cond, extra) => {
  n++;
  if (cond) pass++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
};

console.log('一、日期板块保持卡片底色 + 边框（明确不变）');
{
  const SUMMARY_RULE = CSS.match(/\.order-summary-card,\.order-route-card\{[^}]*\}/)?.[0] || '';
  t('摘要/路线合并规则仍为 background:var(--zp-card)（日期板块底色未改）',
    /background:var\(--zp-card\)/.test(SUMMARY_RULE), SUMMARY_RULE);
  t('摘要/路线合并规则仍带 border:1px solid var(--zp-tint)（日期板块边框未改）',
    /border:1px solid var\(--zp-tint\)/.test(SUMMARY_RULE), SUMMARY_RULE);
}

console.log('二、同日多运单卡 .order-history-choice 去卡片化：页面底色 + 去边框 + 去圆角 + 去阴影');
{
  t('存在末尾覆盖块且 background=页面底色 --zp-bg',
    /background:var\(--zp-bg\)/.test(CHOICE_OVERRIDE), CHOICE_OVERRIDE);
  t('运单卡 border:0',
    /border:0/.test(CHOICE_OVERRIDE), CHOICE_OVERRIDE);
  t('运单卡 border-radius:0（圆角随卡片去除）',
    /border-radius:0/.test(CHOICE_OVERRIDE), CHOICE_OVERRIDE);
  t('运单卡 box-shadow:none',
    /box-shadow:none/.test(CHOICE_OVERRIDE), CHOICE_OVERRIDE);
  t('覆盖块不重新声明 card 底色（避免改回去）',
    !/background:var\(--zp-card\)/.test(CHOICE_OVERRIDE), CHOICE_OVERRIDE);
}

console.log('三、滑动容器与删除键圆角归一（去卡片后边角不再圆）');
{
  t('.order-history-swipe-row border-radius:0',
    /border-radius:0/.test(SWIPE_OVERRIDE), SWIPE_OVERRIDE);
  t('.history-choice-delete border-radius:0（与去卡片统一）',
    /border-radius:0/.test(DELETE_OVERRIDE), DELETE_OVERRIDE);
}

console.log('四、改动仅作用于 same-day 多运单（不污染单运单布局）');
{
  t('去卡片化规则全部带 .history-multi 限定',
    /\.order-shell\.history-multi \.order-history-choice\{/.test(CSS) &&
    !/\.order-history-choice\{[^}]*background:var\(--zp-bg\)/.test(CSS.replace(CHOICE_OVERRIDE, '')),
    { hasBareOverride: /\.order-history-choice\{[^}]*background:var\(--zp-bg\)/.test(CSS.replace(CHOICE_OVERRIDE, '')) });
}

console.log('\n通过 ' + pass + '/' + n + (pass === n ? ' ✓' : ' ✗'));
process.exit(pass === n ? 0 : 1);
