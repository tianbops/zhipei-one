/* 运单详情「去卡片化」静态契约（UI 2.6）
 * 与首页门店列表 / 月度统计同一套：运单内容区（线路信息 + 门店列表）改页面底色 + 去边框，
 * 日期板块 order-summary-card 保持原样；门店行细线、列表底部 FAB 避让留白均保留。
 * 仅校验 css/order_detail.css 源文件结构，不依赖线上。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const rd = p => readFileSync(join(ROOT, p), 'utf8');

const CSS = rd('css/order_detail.css');
const SUMMARY_RULE = CSS.match(/\.order-summary-card,\.order-route-card\{[^}]*\}/)?.[0] || '';
const ROUTE_OVERRIDE = CSS.match(/\.order-route-card\{[^}]*background:var\(--zp-bg\)[^}]*\}/)?.[0] || '';
/* 取「末尾」覆盖块（同名基础规则在文件前部，须用包含 padding-left:0 的块锁定末尾覆盖） */
const ROUTE_HEAD = CSS.match(/\.order-route-head\{[^}]*padding-left:0[^}]*padding-right:0[^}]*\}/)?.[0] || '';
const STORE_LIST_BASE = CSS.match(/\.order-store-list\{[^}]*\}/)?.[0] || '';
const STORE_LIST_OVERRIDE = CSS.match(/\.order-store-list\{[^}]*padding-left:0[^}]*padding-right:0[^}]*\}/)?.[0] || '';
const STORE_ITEM = CSS.match(/\.order-store-item\{[^}]*\}/)?.[0] || '';
const MULTI_OVERRIDE = CSS.match(/\.order-shell\.history-multi \.order-route-card\{[^}]*background:var\(--zp-bg\)[^}]*\}/)?.[0] || '';

let n = 0, pass = 0;
const t = (name, cond, extra) => {
  n++;
  if (cond) pass++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
};

console.log('一、日期板块保持卡片底色 + 边框（明确不变）');
{
  t('摘要/路线合并规则仍为 background:var(--zp-card)（日期板块底色未改）',
    /background:var\(--zp-card\)/.test(SUMMARY_RULE), SUMMARY_RULE);
  t('摘要/路线合并规则仍带 border:1px solid var(--zp-tint)（日期板块边框未改）',
    /border:1px solid var\(--zp-tint\)/.test(SUMMARY_RULE), SUMMARY_RULE);
  t('存在独立的 .order-route-card 覆盖块，且取 --zp-bg（仅路线卡改底色）',
    /background:var\(--zp-bg\)/.test(ROUTE_OVERRIDE) && /border:0/.test(ROUTE_OVERRIDE), ROUTE_OVERRIDE);
}

console.log('二、路线卡去卡片化：页面底色 + 去边框 + 去圆角 + 去阴影 + 去内缩');
{
  t('路线卡 background=页面底色 --zp-bg',
    /background:var\(--zp-bg\)/.test(ROUTE_OVERRIDE), ROUTE_OVERRIDE);
  t('路线卡 border:0',
    /border:0/.test(ROUTE_OVERRIDE), ROUTE_OVERRIDE);
  t('路线卡 border-radius:0（圆角随卡片去除）',
    /border-radius:0/.test(ROUTE_OVERRIDE), ROUTE_OVERRIDE);
  t('路线卡 box-shadow:none',
    /box-shadow:none/.test(ROUTE_OVERRIDE), ROUTE_OVERRIDE);
  t('路线卡 padding-left/right:0（通栏铺满，不内缩）',
    /padding-left:0/.test(ROUTE_OVERRIDE) && /padding-right:0/.test(ROUTE_OVERRIDE), ROUTE_OVERRIDE);
  t('路线卡覆盖块不重新声明 card 底色（避免改回去）',
    !/background:var\(--zp-card\)/.test(ROUTE_OVERRIDE), ROUTE_OVERRIDE);
}

console.log('三、线路信息区 / 门店列表通栏对齐到外壳留白');
{
  t('线路信息区 .order-route-head 左右内缩归零',
    /padding-left:0/.test(ROUTE_HEAD) && /padding-right:0/.test(ROUTE_HEAD), ROUTE_HEAD);
  t('门店列表 .order-store-list 左右内缩归零',
    /padding-left:0/.test(STORE_LIST_OVERRIDE) && /padding-right:0/.test(STORE_LIST_OVERRIDE), STORE_LIST_OVERRIDE);
}

console.log('四、门店行细线 + 列表底部留白（FAB 避让）保留，不破坏可读性');
{
  t('门店行仍 border-bottom:1px solid var(--zp-divider)（细线保留）',
    /border-bottom:1px solid var\(--zp-divider\)/.test(STORE_ITEM), STORE_ITEM);
  t('门店列表底部留白保留 calc(88px + env(safe-area-inset-bottom))（FAB 避让，独立于去内缩覆盖块）',
    /calc\(88px \+ env\(safe-area-inset-bottom\)\)/.test(STORE_LIST_BASE), STORE_LIST_BASE);
  t('门店行 min-height:56px 触控下限保留',
    /min-height:56px/.test(STORE_ITEM), STORE_ITEM);
}

console.log('五、历史同日多单：外层容器同样去边框（内部运单卡保留，属交互项）');
{
  t('history-multi 路线卡也 background=页面底色 + border:0',
    /background:var\(--zp-bg\)/.test(MULTI_OVERRIDE) && /border:0/.test(MULTI_OVERRIDE), MULTI_OVERRIDE);
  t('改动仅作用于运单详情页面（不污染首页 task-card/trend-card）',
    !/\.task-card\{/.test(CSS) && !/\.trend-card\{/.test(CSS), { hasTask: /\.task-card\{/.test(CSS), hasTrend: /\.trend-card\{/.test(CSS) });
}

console.log('\n通过 ' + pass + '/' + n + (pass === n ? ' ✓' : ' ✗'));
process.exit(pass === n ? 0 : 1);
