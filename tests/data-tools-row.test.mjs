/* 数据资料页「批量操作四按钮一行」静态契约
 * 用户诉求（2026-11-07）：批量替换 / 单独追加 / 恢复数据 / 提交更新 四个按钮整合到一排，兼顾美观。
 * 实现：.data-maintenance 改 4 列等宽网格，两个 .data-maintenance-group 用 display:contents 拆掉，
 *       四个按钮直接成为 4 个网格子项；高度 44、字号 clamp(12,3.4vw,14)、padding 4px 保证不换行。
 * 仅校验 css/data.css 与 pages/data.html 源结构，不依赖线上。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const rd = p => readFileSync(join(ROOT, p), 'utf8');

/* 去掉注释再断言：避免注释里提到的「旧写法」被误判为生效规则 */
const CSS = rd('css/data.css').replace(/\/\*[\s\S]*?\*\//g, '');
const HTML = rd('pages/data.html');

const MAINT = CSS.match(/\.data-maintenance\{[^}]*grid-template-columns:repeat\(4[^}]*\}/)?.[0] || '';
const GROUP = CSS.match(/\.data-maintenance-group\{[^}]*\}/g) || [];
const BTN = CSS.match(/\.data-maintenance \.data-action-btn\{[^}]*\}/)?.[0] || '';

let n = 0, pass = 0;
const t = (name, cond, extra) => {
  n++;
  if (cond) pass++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
};

console.log('一、四列等宽网格（一行排满的基础）');
{
  t('存在 4 列等宽网格规则', !!MAINT, MAINT);
  t('grid-template-columns 为 repeat(4,minmax(0,1fr))（可收缩、不溢出）',
    /repeat\(4,minmax\(0,1fr\)\)/.test(MAINT), MAINT);
  t('间距收紧为 8px', /gap:8px/.test(MAINT), MAINT);
}

console.log('二、两个分组用 display:contents 拆掉（否则仍是 2×2 两行）');
{
  const flat = GROUP.join('\n');
  t('存在 .data-maintenance-group 覆盖规则', GROUP.length > 0, flat);
  t('分组 display:contents（不生成盒子，子项直升 4 列）', /display:contents/.test(flat), flat);
  t('分组不再使用 1fr 1fr 两列网格（原 2×2 的成因）',
    !/\.data-maintenance-group\{[^}]*grid-template-columns:1fr 1fr/.test(CSS));
}

console.log('三、按钮适配一行后的排版（不换行、可点、不溢出）');
{
  t('存在 .data-maintenance 作用域的按钮覆盖', !!BTN, BTN);
  t('高度 44px（一行 4 个沿用 48 偏笨重）', /min-height:44px/.test(BTN), BTN);
  t('左右 padding 收到 4px（把宽度让给文字）', /padding:0 4px/.test(BTN), BTN);
  t('字号随屏宽自适应 clamp(12px,3.4vw,14px)', /font-size:clamp\(12px,3\.4vw/.test(BTN), BTN);
  t('white-space:nowrap（四字标签不换行）', /white-space:nowrap/.test(BTN), BTN);
  t('overflow:hidden + text-overflow:ellipsis（极端窄屏兜底不溢出）',
    /overflow:hidden/.test(BTN) && /text-overflow:ellipsis/.test(BTN), BTN);
  t('width:100%/min-width:0（等宽且可收缩）', /width:100%/.test(BTN) && /min-width:0/.test(BTN), BTN);
}

console.log('四、HTML 仍是四按钮、顺序与强调不变');
{
  const card = HTML.match(/<section class="card data-tools-card"[\s\S]*?<\/section>/)?.[0] || '';
  const btns = [...card.matchAll(/<button id="(\w+)" class="([^"]*)"[^>]*>([^<]+)<\/button>/g)]
    .map(m => ({ id: m[1], cls: m[2], text: m[3].trim() }));
  t('批量操作区恰好 4 个按钮', btns.length === 4, btns.map(b => b.id));
  t('顺序为 批量替换 → 单独追加 → 恢复数据 → 提交更新',
    btns.map(b => b.text).join('|') === '批量替换|单独追加|恢复数据|提交更新', btns.map(b => b.text));
  t('全部带 .data-action-btn（统一规格）', btns.every(b => /data-action-btn/.test(b.cls)));
  t('仅最后一个为蓝色主按钮 data-action-primary',
    /data-action-primary/.test(btns[3].cls) && btns.slice(0, 3).every(b => !/data-action-primary/.test(b.cls)));
  t('两个分组容器仍存在（供 display:contents 拆解）', (card.match(/data-maintenance-group/g) || []).length === 2);
}

console.log('\n' + pass + '/' + n + (pass === n ? ' ALL-GREEN' : ' FAIL'));
process.exit(pass === n ? 0 : 1);
