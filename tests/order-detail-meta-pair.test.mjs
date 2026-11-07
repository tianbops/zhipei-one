/* 运单详情线路卡「字段两对左右并排」静态契约
 * 用户诉求（2026-11-07）：线路/车辆 一排一左一右；司机/送货员 一排一左一右。
 * 实现：.order-meta-main 用 1fr 1fr 两列网格，4 个 .order-meta-row 按文档序自动排成两行；
 *       每个 .order-meta-row 用 flex 把「标签+值」横排（不再用 display:contents 融入单列网格）。
 * 仅校验 css/order_detail.css 与 pages/order_detail.html 源结构，不依赖线上。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const rd = p => readFileSync(join(ROOT, p), 'utf8');

const CSS = rd('css/order_detail.css');
const HTML = rd('pages/order_detail.html');

const META_MAIN = CSS.match(/\.order-meta-main\{[^}]*\}/)?.[0] || '';
const META_ROW = CSS.match(/\.order-meta-row\{[^}]*\}/)?.[0] || '';
const ROW_VALUE = CSS.match(/\.order-meta-row>\.order-route-name,\.order-meta-row>\.order-vehicle\{[^}]*\}/)?.[0] || '';

let n = 0, pass = 0;
const t = (name, cond, extra) => {
  n++;
  if (cond) pass++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
};

console.log('一、.order-meta-main 为两列网格（两对并排的基础）');
{
  t('grid-template-columns 为 1fr 1fr（两列等宽）',
    /grid-template-columns:1fr 1fr/.test(META_MAIN), META_MAIN);
  t('不再使用「标签列+值列」的 max-content minmax(0,1fr) 单列网格',
    !/grid-template-columns:max-content/.test(META_MAIN), META_MAIN);
  t('保留 display:grid', /display:grid/.test(META_MAIN), META_MAIN);
  t('保留 column-gap 间距', /column-gap:\s*\d+px/.test(META_MAIN), META_MAIN);
  t('保留 row-gap 行距', /row-gap:\s*\d+px/.test(META_MAIN), META_MAIN);
}

console.log('二、.order-meta-row 为 flex 横排（组内 标签+值 左→右）');
{
  t('display:flex（不再 display:contents）', /display:flex/.test(META_ROW), META_ROW);
  t('不再出现 display:contents', !/display:contents/.test(META_ROW), META_ROW);
  t('align-items:baseline（标签与值基线对齐）', /align-items:baseline/.test(META_ROW), META_ROW);
  t('带 gap（标签与值之间留白）', /gap:\s*\d+px/.test(META_ROW), META_ROW);
  t('min-width:0（允许值收缩）', /min-width:0/.test(META_ROW), META_ROW);
  t('值列可省略防溢出（overflow:hidden + text-overflow:ellipsis）',
    /overflow:hidden/.test(ROW_VALUE) && /text-overflow:ellipsis/.test(ROW_VALUE), ROW_VALUE);
}

console.log('二·补、标签列宽统一（右列「车辆/送货员」等宽 → 值左边缘对齐、左右对称）');
{
  const META_LABEL = CSS.match(/\.order-meta-label\{[^}]*flex:0 0 [^}]*\}/)?.[0] || '';
  t('存在带固定 flex-basis 的 .order-meta-label 规则', !!META_LABEL, META_LABEL);
  t('标签固定宽度为 3.4em（容纳「送货员」3 字并随字号缩放）', /flex:0 0 3\.4em/.test(META_LABEL), META_LABEL);
  t('标签不换行（white-space:nowrap）', /white-space:nowrap/.test(META_LABEL), META_LABEL);
}

console.log('二·补2、右列贴右（车辆/送货员 整组推到列右端，重心回正）');
{
  const RIGHT_ROW = CSS.match(/\.order-meta-main>\.order-meta-row:nth-child\(even\)\{[^}]*\}/)?.[0] || '';
  const RIGHT_VAL = CSS.match(/\.order-meta-main>\.order-meta-row:nth-child\(even\)>\.order-vehicle\{[^}]*\}/)?.[0] || '';
  t('存在「偶数行贴右」规则（第 2、4 行 = 车辆/送货员）', !!RIGHT_ROW, RIGHT_ROW);
  t('偶数行 justify-content:flex-end', /justify-content:flex-end/.test(RIGHT_ROW), RIGHT_ROW);
  t('存在「右列值不拉伸」规则', !!RIGHT_VAL, RIGHT_VAL);
  t('右列值 flex:0 1 auto（不再占满剩余宽度）', /flex:0 1 auto/.test(RIGHT_VAL), RIGHT_VAL);
  t('基础规则仍为 flex:1 1 auto（左列值保持贴标签）', /flex:1 1 auto/.test(ROW_VALUE), ROW_VALUE);
  t('未对奇数行/全体行加 flex-end（左列不受影响）',
    !/nth-child\(odd\)/.test(CSS) && !/\.order-meta-row\{[^}]*justify-content:flex-end/.test(CSS));
}

console.log('三、HTML 字段顺序（决定两行两列的排列）');
{
  const labels = [...HTML.matchAll(/<span class="order-meta-label">([^<]+)<\/span>/g)].map(m => m[1].trim());
  t('恰好 4 个标签', labels.length === 4, labels);
  t('顺序为 线路 → 车辆 → 司机 → 送货员（前两为第一行、后两为第二行）',
    labels[0] === '线路' && labels[1] === '车辆' && labels[2] === '司机' && labels[3] === '送货员', labels);
  t('线路值 id=routeName 存在', /id="routeName"/.test(HTML));
  t('车辆值 id=vehicle 存在', /id="vehicle"/.test(HTML));
  t('司机值 id=driver 存在', /id="driver"/.test(HTML));
  t('送货员值 id=deliveryPerson 存在', /id="deliveryPerson"/.test(HTML));
}

console.log('四、多运单布局不受影响（头部仍隐藏）');
{
  t('history-multi 下 .order-route-head 仍 display:none',
    /\.order-shell\.history-multi \.order-route-head\{display:none\}/.test(CSS),
    CSS.match(/\.order-shell\.history-multi \.order-route-head\{[^}]*\}/)?.[0] || '');
}

console.log('\n' + pass + '/' + n + (pass === n ? ' ALL-GREEN' : ' FAIL'));
process.exit(pass === n ? 0 : 1);
