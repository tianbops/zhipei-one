/* 历史查询页「选择日期」改为主题蓝主按钮 · 静态契约
 * 用户诉求（2026-11-07）：选择日期按钮改为主题蓝色。
 * 实现：.history-date-button 从继承 .zp-btn--secondary 的灰底，改为主题蓝实心 --zp-primary
 *       + --zp-on-primary 白字；:active 显式走 --zp-primary-active（否则被 .zp-btn:active 的灰底抢走）。
 * 仅校验 css/history-overlays.css 与 pages/history.html 源文件，不依赖线上渲染。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const rd = p => readFileSync(join(ROOT, p), 'utf8');

/* 去注释再断言：注释里写的「改前是灰底」不能被误判为生效规则 */
const CSS = rd('css/history-overlays.css').replace(/\/\*[\s\S]*?\*\//g, '');
const BASE = rd('css/ui-base.css').replace(/\/\*[\s\S]*?\*\//g, '');
const THEME = rd('css/ui-theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
const HTML = rd('pages/history.html');

const BTN = CSS.match(/\.history-date-button\{[^}]*\}/g) || [];
const BTN_BASE = BTN[0] || '';
const BTN_ACTIVE = CSS.match(/\.history-date-button:active\{[^}]*\}/)?.[0] || '';
const SECONDARY = BASE.match(/\.zp-btn--secondary\{[^}]*\}/)?.[0] || '';

let n = 0, pass = 0;
const t = (name, cond, extra) => {
  n++;
  if (cond) pass++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
};

console.log('一、主题蓝（背景 / 边框 / 文字）');
{
  t('.history-date-button 定义恰好一组（无重复打架）', BTN.length === 1, BTN.length);
  t('背景取主题蓝令牌 --zp-primary', /background:\s*var\(--zp-primary\)/.test(BTN_BASE), BTN_BASE);
  t('边框同主题蓝（不再是 --zp-line 细边）', /border-color:\s*var\(--zp-primary\)/.test(BTN_BASE), BTN_BASE);
  t('文字取 --zp-on-primary（白字，非 --zp-text）', /color:\s*var\(--zp-on-primary\)/.test(BTN_BASE), BTN_BASE);
  t('不再引用灰底 --zp-surface-2', !/--zp-surface-2/.test(BTN_BASE), BTN_BASE);
  t('不再引用次级边框 --zp-line', !/border-color:\s*var\(--zp-line\)/.test(BTN_BASE), BTN_BASE);
  t('没有写死 hex 颜色（颜色全走令牌）', !/#[0-9a-fA-F]{3,8}/.test(BTN_BASE), BTN_BASE);
}

console.log('\n二、按压态（不被 .zp-btn:active 灰底覆盖）');
{
  t('存在 .history-date-button:active 规则', !!BTN_ACTIVE, BTN_ACTIVE);
  t('按压背景为 --zp-primary-active', /background-color:\s*var\(--zp-primary-active\)/.test(BTN_ACTIVE), BTN_ACTIVE);
  t('按压边框同步 --zp-primary-active', /border-color:\s*var\(--zp-primary-active\)/.test(BTN_ACTIVE), BTN_ACTIVE);
  t('按压文字仍为白字（--zp-on-primary）', /color:\s*var\(--zp-on-primary\)/.test(BTN_ACTIVE), BTN_ACTIVE);
  t('基础层 .zp-btn:active 用的是灰底 --zp-secondary-active（故必须覆盖）',
    /\.zp-btn:active\{[^}]*--zp-secondary-active/.test(BASE), BASE.match(/\.zp-btn:active\{[^}]*\}/)?.[0] || '');
}

console.log('\n三、主题令牌（深浅两套同一支蓝）');
{
  const darkBlock = THEME.slice(THEME.indexOf(':root[data-zp-theme="dark"]'));
  t('深色块 --zp-primary 为 #2C6CE2', /--zp-primary:#2C6CE2/.test(darkBlock), darkBlock.match(/--zp-primary:#[0-9A-Fa-f]+/)?.[0] || '');
  t('深色块 --zp-on-primary 为白', /--zp-on-primary:#FFFFFF/i.test(darkBlock), darkBlock.match(/--zp-on-primary:#[0-9A-Fa-f]+/)?.[0] || '');
  t('深色块有 --zp-primary-active（按压态有值）', /--zp-primary-active:#0B52BC/.test(darkBlock), darkBlock.match(/--zp-primary-active:#[0-9A-Fa-f]+/)?.[0] || '');
}

console.log('\n四、布局未被本次改色破坏（仍为整行宽 48px 居中）');
{
  t('保留 width:100%（整行）', /width:\s*100%/.test(BTN_BASE), BTN_BASE);
  t('保留 min-height:48px', /min-height:\s*48px/.test(BTN_BASE), BTN_BASE);
  t('保留居中 flex 布局', /justify-content:\s*center/.test(BTN_BASE), BTN_BASE);
  t('保留图标 20×20（不改尺寸）', /\.history-date-button svg\{width:20px;height:20px/.test(CSS), CSS.match(/\.history-date-button svg\{[^}]*\}/)?.[0] || '');
  t('图标走 currentColor（随文字转白，无需单独上色）',
    /stroke="currentColor"/.test(HTML), 'svg stroke');
}

console.log('\n五、HTML 结构未动（按钮/图标/文案齐全）');
{
  t('仍为 <button id="historyPickerBtn">', /<button id="historyPickerBtn"[^>]*>/.test(HTML));
  t('保留 .history-date-button 类（CSS 落点）', /class="[^"]*history-date-button[^"]*"/.test(HTML));
  t('保留日历图标 svg', /<svg[^>]*viewBox="0 0 24 24"[^>]*>/.test(HTML));
  t('保留「选择日期」文案', /<span>选择日期<\/span>/.test(HTML));
  t('仍是次级按钮类 + 本类覆盖（不新增第三套按钮家族）',
    /class="zp-btn zp-btn--secondary history-date-button"/.test(HTML), HTML.match(/id="historyPickerBtn"[^>]*/)?.[0] || '');
  t('未新增 .zp-btn--primary 空类依赖（该类目前无规则）',
    !/zp-btn--primary/.test(HTML) && !/\.zp-btn--primary\{/.test(BASE), 'primary class');
}

console.log('\n' + (pass === n ? 'ALL PASS' : 'FAILED') + ` ${pass}/${n}`);
process.exit(pass === n ? 0 : 1);
