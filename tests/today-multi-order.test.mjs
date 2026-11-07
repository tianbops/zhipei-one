/* 同日多单 · 首页单卡切换契约测试（2026-11-06）
 * ------------------------------------------------------------------
 * 需求：一天多单时首页今日配送不再「只显示最后一单」，
 *   1) 一张卡内按单切页：点 tab 或左右滑动；
 *   2) 顺序按运单上传时间（uploadedAt）升序，左旧右新；
 *   3) 切换只换视图不请求（orders 随 latest 一次带回）；
 *   4) 选中单记在本次会话，跨天失效；
 *   5) 首页门店名改单行省略，横向手势让给切页（详情页仍保留左滑）。
 * 这里只锁契约与关键参数，真实交互在 tests/e2e-today-multi-order.cjs。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const latest = read('functions/api/waybills/latest.js');
const today = read('js/home/today.js');
const core = read('js/home/core.js');
const html = read('home.html');
const dashboard = read('css/home-dashboard.css');
const render = read('js/order_detail/render.js');

let n = 0;
const ok = (cond, msg) => { n++; if (!cond) { console.error('FAIL ' + msg); process.exitCode = 1; } };

/* 1. 接口：orders 与 dayCount 同源，按上传时间升序 */
ok(/dayCount:list\.length/.test(latest), 'dayCount 仍按当日有效单数返回（首页「X单」口径不变）');
ok(/const orders=await Promise\.all/.test(latest), 'latest 须一次带回当天全部单（orders），切页不再二次请求');
ok(/orders:orders/.test(latest) || /orders\}/.test(latest), '响应体须带 orders 字段');
ok(/timeOf=w=>String\(w\?\.uploadedAt\|\|w\?\.createdAt/.test(latest), '同一批单须按 uploadedAt（回退 createdAt）排序');
ok(/waybill:orders\[orders\.length-1\]/.test(latest), 'waybill 仍返回最后一单，兼容旧调用方');
ok(!/brief=\(w\)[\s\S]{0,300}sourceLine/.test(latest), 'orders 不得带调试字段');

/* 2. 首页渲染：tab + 页轨道 + 单页 */
ok(/id="todayTabs"/.test(html) && /role="tablist"/.test(html), '今日卡须有 tab 容器');
ok(/class="today-tab"[\s\S]{0,120}aria-selected/.test(today), 'tab 须带 aria-selected（读屏可感知当前单）');
ok(/todayTabs\.hidden=list\.length<2/.test(today), '只有 1 单时 tab 整行隐藏（日常与旧版一致）');
/* 2026-11-07 用户要求：tab 只留「第X单」序号，不显示上传时间（浮层更简洁紧凑）。
   排序仍按 uploadedAt，只是不再把时间渲染到按钮上。 */
ok(!/zpTodayHM/.test(today), '不得再保留 zpTodayHM 时间格式化死代码');
ok(/第'\+\(i\+1\)\+'单<\/button>/.test(today) && !/\+hm|zpTodayHM\(/.test(today), 'tab 文本须只有「第X单」，不得拼接时间');
ok(/class="today-view"><div class="today-track"/.test(today), '列表须包在 view / track 两层内（view 负责裁切相邻页）');
ok(/class="today-page" data-i=/.test(today), '每单渲染成一个 page，序号在页内从 1 重排');
ok(/zpRenderToday\(orders,dayOrders,false\)/.test(today), '三层数据源须汇总成 orders 后统一渲染');

/* 3. 排序与默认单 */
ok(/uploadedAt\|\|a\.createdAt/.test(today), '当日历史降级路径同样按 uploadedAt 排序');
ok(/zpTodaySelId\(\)/.test(today) && /zp_home_today_sel/.test(today), '须记住本次会话选中的单');
ok(/list\.findIndex\(o=>String\(o\.id\)===saved\)/.test(today), '按 waybillId 而非序号恢复选择（新单插入后序号会变）');
ok(/let idx=list\.length-1/.test(today), '没有记录时默认最新一单（新单到达即可见）');
ok(/date===zpTodayKey\(\)/.test(today), '选中单须按日期失效，不能跨天沿用');
ok(/zp_home_today_v2/.test(today), '快照结构已升级为 v2（旧快照直接丢弃）');

/* 4. 手势：方向判定 / 边界 / 误触 */
ok(/Math\.abs\(ax\)<8&&Math\.abs\(ay\)<8/.test(today), '须有 8px 死区，轻点不进入滑动');
ok(/Math\.abs\(ax\)>Math\.abs\(ay\)\*1\.2\?"x":"y"/.test(today), '竖向位移占优时须判为纵向（滚列表不切单）');
ok(/lock==="y"[\s\S]{0,80}return/.test(today) || /if\(lock!=="x"\)return/.test(today), '判为纵向后本次触点不得再切单');
ok(/e\.clientX<24/.test(today), '屏幕左缘 24px 不接管（iOS 返回手势）');
ok(/dx\*0\.35/.test(today), '首尾边界须阻尼，不循环翻页');
ok(/Math\.abs\(dx\)>w\*0\.18/.test(today), '位移超过 18% 卡宽才切页，避免误切');
ok(/zpSwiped/.test(today) && /stopPropagation/.test(today), '滑动结束后须吞掉一次 click，防止误开导航');
ok(/touch-action:pan-y/.test(dashboard) || /touch-action:pan-y/.test(read('css/ui-base.css')), '裁切容器须保留纵向原生滚动（pan-y）');

/* 5. 首页名称：单行省略，不再左滑 */
ok(/class="zp-store-name"/.test(today) && !/zpBindStoreNameScroll/.test(today), '首页改单行省略，不再绑定左滑');
ok(/\.today-store-row \.zp-store-name\{[\s\S]{0,320}text-overflow:ellipsis/.test(dashboard), '首页名称须 ellipsis 单行省略');
ok(/overflow:hidden/.test(dashboard) && /\.today-view\{[\s\S]{0,80}overflow:hidden/.test(dashboard), 'view 层须 overflow hidden 才能挡住相邻页');
ok(/\.today-track\{[\s\S]{0,80}display:flex/.test(dashboard), '轨道须横向排列');
ok(/\.today-page\{[\s\S]{0,60}flex:0 0 100%/.test(dashboard), '每页占满一屏宽');
ok(/zpStoreNameHtml/.test(render) && /zpBindStoreNameScroll/.test(render), '运单详情保持原样：仍用共享左滑组件');

/* 6. 空态收起切换器与页高 */
ok(/todayTabs\.hidden=true/.test(core), '空态须收起 tab，避免留下死按钮');
ok(/todayStoreList\.style\.height=""/.test(core), '空态须清掉页高锁定，否则「暂无门店」被压在空白里');

/* 7. 高度跟随当前页（避免切换时下面的趋势卡跳动） */
ok(/zpSyncTodayHeight/.test(today) && /offsetHeight/.test(today), '页高须按当前页实测并锁定，切换瞬时跟随');

if (!process.exitCode) console.log('✅ today-multi-order 契约 ' + n + ' 条通过');
