# CHANGELOG 2026-10-18（v1.0.7 定版日）

> 范围：v1.0.0（da5cc134）之后的全部整改 + 定版日收尾。
> 完整归档说明见 `docs/RELEASE-v1.0.7.md`。

## 一、视觉与交互整改（继承自本轮早期提交）

| 主题 | 内容 | 验证 |
|---|---|---|
| Uber 双主题色系 | 统一设计 Token；主按钮反相（深 #FFFFFF / 浅 #0A0A0A）；26 处按钮硬编码白字改 `--zp-on-primary`；去蓝中性灰阶 | 两主题 14 项对比度全过 AA（禁用态按 WCAG 1.4.3 豁免） |
| 底部导航死区 | `main{padding-bottom:82px}` 遗留规则清零；`.zp-scroll` 底留白 84→72px；order_detail/today 列表底 24/12→72px | 像素复测：白色按钮内容延伸至横线，黑区消失 |
| 全局滚动条 | 全站隐藏常驻滚动条（移动端成熟做法，滚动/惯性不变） | 线上 CSS 规则在位 |
| 顶栏统一 | 全站顶部栏吸顶 + 统一背景/安全区避让；zp-shell 外壳统一（flex 静止子项 + 内部滚动） | 8 个业务页一致 |
| 性能 | 静态资源 SWR 强缓存；logo/插画转无损 WebP（410KB→69KB） | `?v=` 哈希戳全量对齐 |

## 二、安全整改（security(auth)，11 提交）

- **根因**：原无路由守卫，受保护页先渲染完整 DOM 再靠异步 `/api/me` 判定，
  Web 直链与「返回」操作均可绕过鉴权（`ui-unified.js` 的 `zpGuard` 实为双击退出控制器）。
- **措施**：
  - 9 个受保护页 `<head>` 首行注入**同步守卫**：渲染前判定 `sessionStorage.zpAuth!=="1"`
    即清空页面并 `location.replace` 登录页（带 `redirect` 深链 + `reason=auth`）；
  - `pageshow` 监听兜底，拦截 bfcache「返回」恢复；
  - 登录成功 / `/api/me` 成功写 `zpAuth="1"`；登出与 401 清除；
  - 登录页已登录自动直达意图页；`redirect` 深链白名单校验（防开放重定向）；
  - home / admin / account / route_apply 的 `/api/me` 401 兜底回登录。
- **验证**：无头 Chrome 三场景（未登录直链 / 已登录 / 未登录 account）全过；
  线上各页守卫在位。

## 三、账号页结构调整

- 「关于」板块下移至「账号与安全」下方；
- 「危险操作」整体并入「账号与安全」：注销账号成为列表末行（危险红），
  点击展开确认面板；管理员自动隐藏该行；
- 最终板块顺序：外观与显示 → 账号与安全（含注销账号）→ 关于 → 退出登录。

## 四、安装下载链路（三期演进）

1. **单行化**：兜底长说明改为「下载应用 | 安卓安装包 · 复制网址」单行，
   左标签点击触发安装/引导，右侧一步直达下载；
2. **同域托管**：私有仓库 Release 匿名不可达 + GitHub 资产域名国内不稳定，
   安装包改托管站点同域 `/downloads/`，国内可达、零外部依赖；
3. **版本清单**：稳定文件名 `zhipei-one-latest-release.apk` + `manifest.json`，
   页面动态读取生成链接并显示版本号；**发新版只需替换 APK + 更新清单，页面零改动**。

## 五、定版日收尾（2026-10-18）

### 发现的问题（定版审计）

| # | 问题 | 级别 | 处理 |
|---|---|---|---|
| 1 | 4 个运维工具页（consistency-repair / verify-checklist / e2e-helper / e2e-launcher）无守卫匿名暴露，其中 2 个可调用数据 API（含删线路） | 高 | ✅ 已注入同步守卫 |
| 2 | Android 工程版本落后：gradle versionName 1.0 / versionCode 1、package.json 1.0.0，与实际发行 1.0.7 不符 | 中 | ✅ 已对齐 1.0.7 / versionCode 7 |
| 3 | SW 运行时版本自 v1.0.0 起未随大批静态变更 bump（zp-pwa-57） | 中 | ✅ 已升至 zp-pwa-58 |
| 4 | 仓库行尾混乱：API 推送保留 CRLF，git 历史为 LF，25 个文件哈希不一致 | 低 | ✅ 全仓库统一规范化为 LF（一次原子提交） |
| 5 | version.json 与 manifest 日期不一致 | 低 | ✅ 已对齐 2026-10-18 |
| 6 | CI 自 Uber 主题整改起持续红：主题测试仍断言旧浅色 token（#F4F6F8/#17202A/#D7DDE3），新 token 为 #F2F2F2/#141414/#E0E0E0 | 中 | ✅ 测试更新至现行 Uber 浅色 token，其余断言逐项核验仍成立 |

### 审计结论（修复后全绿）

- 守卫覆盖 14/14；JS 语法 0 失败；静态重复 ID 0；`?v=` 戳 0 处待更新；四端版本对齐；
- 本地 ↔ 线上全量文件 parity 一致（双边 LF 规范化后逐一哈希比对）；
- 本地 43 项 node 测试全绿（含修复后的主题 token 断言），CI 转绿；
- 线上匿名实测：APK 200 + MIME 正确 + 文件头校验；manifest 正常；账号页显示「安卓安装包 v1.0.7」。

### 有意保留的决策

- `tests/tools/visual/fixtures/observer_probe.html`（无害静态空列表夹具）不设守卫——
  加了会破坏开发期视觉检查工具；建议下版将 dev 产物从生产构建剔除。

### 新增工具脚本（工作区侧，未随仓库分发）

- `scripts/audit_release.py`：定版审计（守卫/语法/ID/戳/版本矩阵）
- `scripts/check_parity.py`：本地 ↔ GitHub 全量文件比对（双边 LF 规范化后哈希）
- `scripts/push_release_v107.py`：定版推送（含行尾规范化）
- `scripts/push_download_apk.py`：安装包 + manifest 推送（发新版用）

### 发新版标准流程

1. 用新 APK 覆盖 `repo-web/downloads/zhipei-one-latest-release.apk`；
2. 更新 `repo-web/downloads/manifest.json` 的 `version` / `updated`；
3. 跑 `scripts/push_download_apk.py`；
4. （如需）更新 `version.json` 与 `docs/` 归档说明，bump `sw.js` 的 `VERSION`。

---

## 定版后热修复（v1.0.7 线上问题，2026-10-18）

| # | 问题 | 严重度 | 修复 |
|---|------|--------|------|
| 7 | 线路页底部导航**间歇性**渲染成巨型纯黑房子图标：导航 5 个 SVG 无内联宽高/填充，唯一尺寸规则（21px + fill/stroke）在外部 ui-unified.css 且以 body 的 `zp-business-nav-page` 类为作用域；CSS 未生效/旧缓存/类缺失时按 SVG 默认 100% 宽度渲染成约 400px 纯黑图标，5 个导航项纵向堆叠、仅首项「首页」露出并被屏幕底边截断（用户手机截图实锤；本地 CDP 三场景复现：屏蔽 CSS → 398×398、屏蔽 JS → 468×468） | 高 | ✅ dispatch/home 静态导航 5 个 SVG 与顶栏返回箭头、ui-unified.js 注入导航模板全部补内联 width/height/fill/stroke 呈现属性——任何 CSS 缺失/陈化态下图标恒为 21px 描边；修复后三场景探针实测 21×21；ui-unified.js `?v=` 击穿至 ba869ff1（9 个引用页同步） |
| 8 | 线路页「读取中…」永久卡死：`api()` 的 fetch 无超时，移动网络挂起时 `Promise.all` 永不 settle，catch 永不触发，界面连失败态都不渲染 | 高 | ✅ `api()` 增加 10s AbortController 超时；失败态由无按钮的死文案「请重试」改为可点击的重试按钮（点击回读取态并重新 load） |

- 根因备注：用户截图中顶栏返回箭头正常、仅导航爆炸 → 设备上 ui-unified.css 实为不含业务导航规则的历史旧版（SW/边缘缓存陈化、间歇 Serve），或 body 类未加上；三条触发路径产物相同，已由内联呈现属性一次性免疫。
- 验证：本地 43 项 node 测试全绿；CDP 三场景（基线/屏蔽 CSS/屏蔽 JS）homeIcon 恒 21×21；`?v=` 9 个引用页同步刷新。

---

## PWA/SW 缓存治理（2026-10-18 夜间，commit 见 main）

| # | 项目 | 内容 |
|---|------|------|
| 9 | SW 预缓存死条目 | 历史 PRECACHE 中 19 个 CSS/JS 条目**不带 ?v=**，而 SWR 缓存键是完整 URL——预缓存与页面请求永远匹配不上，首屏壳资源仍全额回源。现由脚本按 HTML 真实引用重建：32 条预缓存全部带正确 ?v=，install 即全覆盖 |
| 10 | ?v= 哈希漂移 | 历史哈希按 CRLF 内容计算，LF 规范化后 15 个引用全部失真（改文件不换 URL → 设备永久命中旧资产）。现统一约定为**入库内容 md5[:8]**，脚本一键重算刷新（本次 14 个 HTML / 51 处） |
| 11 | 版本号治理缺测试 | 新增 `tests/sw-precache.test.mjs`（CI 第 44 项）：①HTML 每个版本化引用必须原样进 PRECACHE；②?v= 必须等于文件 md5[:8]；③PRECACHE 无死条目、文件均存在。配套 `scripts/bump_asset_versions.py`（幂等，无变化不 bump 版本） |

- SW VERSION：zp-pwa-58 → **zp-pwa-59**（activate 清理旧缓存，设备全量刷新预缓存——顺带根治「旧版 ui-unified.css 无导航规则」的缓存陈化路径）。
- 预缓存页面集：/、/home、/pages/today、/pages/dispatch、/pages/history、/pages/route_apply、/pages/account、/register、/offline（admin/setup 属办公侧低频，不入预缓存）。
- CDP 三阶段实测（本地干净 profile）：①SW activated，PRECACHE **32/32 命中**；②清空 HTTP 缓存后二次访问，版本化 CSS/JS **网络请求 0**；③模拟离线打开线路页——页面完整渲染（导航 fixed、图标 21px），接口区显示「线路读取失败 + 重试按钮」。
- 本地 44 项 node 测试全绿（新增 sw-precache 94 断言）。

---

## 接口合并/提速（2026-10-18 深夜，commit 见 main）

**服务端**

| 文件 | 变更 |
|------|------|
| `functions/api/routes.js` | 抽出 `readRoutes(env,user)`；校验循环与构建循环合并，逐条 `getRoute`/base GET 改为**两次批量 MGET**（走既有 `mgetBatchMap` + Budget）。3 条线路的读从 **13 条 Redis 命令降至 6 条**，且与线路数无关（历史 4M+2 线性增长）。管理员巡检修复逻辑原样保留，修复后重读保证返回值一致 |
| `functions/api/dispatch.js` | 抽出 `resolveDispatchRoute(env,user)` 供聚合接口复用，GET 行为不变 |
| `functions/api/dispatch-bootstrap.js`（新） | 线路页聚合：一次往返返回「调度线路 + 可选线路列表」。错误契约逐字保留：401 未登录 / 403 管理员 / 409 数据异常（消息与 /api/routes 一致） |
| `functions/api/home-bootstrap.js`（新） | 首页聚合：一次往返返回「调度线路 + 当前用户」，user 字段与 /api/me 逐字段一致；鉴权只做一次 |

**客户端**

- `pages/dispatch.html`：`Promise.all([/api/routes, /api/dispatch])` → 单请求 `/api/dispatch-bootstrap`
- `js/home.js` loadHome：`Promise.all([/api/dispatch, /api/me])` → 单请求 `/api/home-bootstrap`（401 兜底、sessionStorage 标记、错误消息语义不变）

**测试与治理**

- 新增 `tests/integration-bootstrap-aggregate.cjs`（CI 第 45 项，15 断言）：聚合响应与 /api/routes、/api/me 逐字段一致；401/403/409 契约；**命令数实证**（≤8、必须用 MGET、逐条 GET ≤1）
- 踩坑记录（两个都已被测试实锤后修复）：① `mgetBatchMap` 收**全限定键**（含 `zp:`），与 `get()` 内部加前缀的约定不同——首版漏前缀导致全员 409；② 重构时漏写「从 routeMap 灌入 routeById」的循环，同样 409。教训：批量 helper 的键约定 + 重构后必须有集成测试兜底
- 全量 45 项 node 测试绿（721 ✅）

---

## 历史页左滑删除交互重做（2026-10-18 夜间，commit 见 main）

**用户反馈**：历史查询页「右侧 UI 修正优化，左滑删除按钮露出」。CDP 探针实测旧实现：**拖动过程中 tx 恒为 0——完全不跟手**，界面零反馈，只有松手瞬间才突然滑出；且露出的按钮是无图标的纯文字 76px 浅色块。

| 文件 | 变更 |
|------|------|
| `js/history.js` | `bindSwipe` 重写为跟手式：touchmove 实时 `translate3d` 跟手平移（删除按钮随手指逐渐露出），左滑超出 84px 后 0.45 阻尼、右滑 0.35 阻尼限 24px 橡皮筋；松手按「位移 >42px 或速度 < -0.35px/ms」速度感知吸附；已展开行再次触摸从 -84px 基准跟手（右滑可直接收回）；`suppress` 由伴随式布尔改为**一次性时间窗**（拖拽后 400ms 内抑制 Chrome 合成 click，避免拖完立即点删除被吞——探针实测抓出的真 bug）；删除按钮 icon 化（垃圾桶 SVG + 文字） |
| `css/history.css` | `.history-swipe-row` 加 `touch-action:pan-y`（横向手势交 JS，纵向滚动归浏览器，从根上消除抢占）；删除按钮 76→**84px**（小屏 80px），红渐变 + 白字 + 左侧圆角 + 内描边，flex 纵向居中；展开态 surface 加投影强化浮起层级；右侧统计数字 `tabular-nums` 等宽对齐（「15家 · 0.96t」多行整齐） |
| `pages/history.html` | `?v=` 随哈希刷新（history.css 4def5789 / history.js cc33919b）；SW VERSION → zp-pwa-62 |

**验证**：CDP 四阶段探针（`scripts/probe_history_swipe.py`）：①跟手 tx=-60（修复前 0）②松手吸附 -84px ③点击删除 → 确认弹窗（日期行动态文案「确定删除10月18日历史记录吗？删除后可在回收站恢复（7天内）。」）④行外点击收起。全量 45 项 node 测试绿（736 ✅）。

**踩坑**：① 探针阶段3 连挫两次——`touchEnd(0,0)` 使 click 合成到页面外；坐标 `surfRight-42` 又落到行表面误触「收起」，正确中心 = `surfRight + delW/2`；manual `.click()` 验证 onclick 链路本身完好。② suppress 布尔标志拖尾吞点击——改时间窗。

---

## 紧急修复：未左滑却露出删除按钮（2026-10-18 夜间，commit 见 main）

**用户反馈（带截图）**：「删除按钮没有滑动的情况下，依然能看见，没滑动的情况下，按钮不应该能看见」。截图显示**多个行无规律地同时露出**删除按钮（10月18日/10日/9日/8日/6日/5日……）。

**根因（上一轮跟手重写引入，探针双指场景实锤）**：双指触摸（如两拇指滚动页面）时——
1. 指1 在某行横向拖动 → `decided=true`、`paint()` 写入 inline transform；
2. 指2 落在同一行 → 第二个 `touchstart` 把 `dragged` 重置为 `false`（若指2 落点在行外，行的 touchstart 守卫根本看不到 `touches.length=2`——触摸事件从 target 向上冒泡，不会向下传到其他行）；
3. 指1 抬起 → `finish` 因 `!dragged` **提前 return，inline transform 永久残留** → 行表面永远左移、删除按钮常露，且 `swiped` 类不在，`closeOpen`/`openSwipe` 均清不到它。

指2 落行外的场景更隐蔽：行内 `moving/decided` 保持，指1 抬起时 `finish` 正常走 far 判定，dx≈-35px + 速度快即**误判为展开**。

**修复（三层多指守卫 + 无条件清理）**：
- `touchstart`：`e.touches.length>1` → 放弃并清理（两指同时落本行）；
- `touchmove`：`e.touches.length>1` → 立即放弃并清理（第二指中途加入，覆盖落点在本行外的场景）；
- `touchend`（finish）：`e.touches.length>0`（屏幕上还有其他手指）→ 放弃并清理（双指中一指先抬）；
- `painted` 标志跟踪 inline 写入，`clear()` 幂等清理；`finish` 不再因 `!dragged` 提前 return，`far` 判定增加 `decided` 前提。

**验证**：探针新增阶段5/6 回归——① 双指污染序列（指1 拖动 painted → 指2 落行外 → 指1 抬）连施 3 行，全部 tx=0 无残留（修复前第 4 行误展开至 -84px）；② 单指左滑链路无回归（跟手 tx=-60 → 吸附 -84 → 删除弹窗 → 行外收起）。全量 45 项测试 736 ✅ 绿（sw-precache 抓到此轮改码忘刷哈希的时序倒置，刷后复绿）。

**教训**：跟手式 swipe 的 inline transform 必须配「无条件清理 + 多指放弃」；双指守卫必须三层齐全——只守 touchstart 守不住「第二指落在行外」（事件不向下传播）。

---

## 根因复核：删除按钮透视 + 圆角直角混绘（2026-10-18 深夜，commit 见 main）

**用户两次纠偏**：①「应该是上层透明导致的，删除按钮能在没滑动的时候显现，从新核查」②「按钮左边圆角，同时还能看到直角」。**用户判断正确**——上一轮的双指守卫修的是真 bug（探针实测残留），但**不是**用户截图的主因。

**主因一：上层半透明导致透视（像素级实证）**。深色主题下 `.history-row-surface` 背景 `rgba(13,18,24,.82)`（18% 可透视）叠在高亮红删除按钮上，未滑动时按钮区域 ΔR=+5.5（肉眼可辨偏红）；浅色 surface 是 `#FFFFFF` 不透明所以毫无症状。修复：surface 深色背景改**不透明实色** `#0C1117` / `#0A0E13`（取色 = 半透明叠加后的实际观感值，零视觉差异）；修复后双主题 Δ=[0,0,0]。

**主因二：两套样式冲突（圆角+直角框）**。`ui-unified.css` 的「全站删除按钮统一标准」用 `button[class*="delete"]` **属性通配符 + !important** 命中 `.history-delete`（类名含 "delete"），强制套上半透明红晕底 + 1px 红边框 + 红字——压掉红渐变/白字，1px 边框沿矩形边缘绘制，与左侧 12px 圆角混绘出「圆角 + 直角框」。修复：从该标准中**显式排除**（`:not(.history-delete)`，沿用 `.account-collapse-head` 排除先例——滑动动作条是整行高度的动作组件，非普通按钮），由 history.css 单一接管：实心红渐变 + 白字 + 无边框 + 左圆角右贴边；浅色下补 `:root[data-zp-theme="light"] .history-delete{color:#fff}` 压回浅色 button 通用深字规则。

**测试演进**：`appearance-theme-bootstrap.test.mjs` 断言随新架构更新——`.history-delete` 必须从全站标准中排除（`!^\s*\.history-delete[,:{]` + `:not(.history-delete)` 在位）且由 history.css 接管。45 项测试 736 ✅ 绿。

**验证**：像素探针双主题：透视 Δ=[0,0,0]；按钮计算样式 `border:0 / radius:12px 0 0 12px / linear-gradient / color:#fff`；展开态截图目视确认（未滑动行完全干净，展开行左圆角右贴边）。SW zp-pwa-65。

**教训**：①「上层半透明」这类视觉 bug 要用**像素差分**（开/关被怀疑元素对比同区域 RGB）实证，别只信计算样式；② 属性通配符选择器（`button[class*="delete"]`）会命中一切类名含关键词的按钮，新增组件要么进它的排除名单，要么起名避开；③ 用户对现场现象的直觉（「上层透明」）值得优先核查——本例用户一句话省了两轮弯路。

---

## 删除按钮形态统一（圆角/直角不对称）+ 浅色视觉优化（2026-10-18 夜间，commit 见 main）

**用户反馈**：「浅色外观下也要优化，同时出现圆角和广角问题」。

**量化复核（`scripts/probe_button_edge.py`，九点像素采样）**：修复前双主题均为「左上角/左下角 = 背景（圆角成立）+ 右侧红色直抵屏幕边缘（直角）」。两侧不对称正是用户观感里「圆角和直角并存」的来源——这是刻意按常见 swipe-to-delete 做法设计的，但与本项目的圆角卡片语言不统一，尤其在浅色卡片背景上。

**修复**：删除按钮改为**四角同圆（12px）+ 右侧与屏幕右缘留 6px 呼吸位**（`inset:0 6px 0 auto`），成为浮动式圆角动作条；宽度、滑动位移（-84px/小屏 -80px）、露出面积均不变。

**浅色优化**：
- 补 `:root[data-zp-theme="light"] .history-delete{color:#fff}` —— ui-unified 913 行有「浅色下所有 button 用深字」的通用规则，会覆盖白字；
- 红渐变收敛到浅色 danger token 同色系（`#C2453A→#A0362D`），避免在浅灰 #F2F2F2 页面上过跳；深色维持 `#D9534B→#B93B32`。

**验证**：双主题像素采样——四角全为背景色（圆角成立）、右侧 6px 呼吸位为背景、按钮右内缘为红；透视 Δ=[0,0,0] 未回退；45 项测试 736 ✅ 绿；SW zp-pwa-66。

**教训**：形态类反馈不要凭 cz ffmpeg 描述猜，用**多点像素采样**（四角/边缘/中心/留白区）把「圆角/直角/边框残留」量化成可判定的布尔结论；同时浅色主题最容易漏——通用 button 深字规则等横向规则会悄悄覆盖专用组件样式。

---

## 历史页板块宽度对齐全局（2026-10-18 夜间，commit 见 main）

**用户反馈**：「历史查询页面，几个板块的宽度要和全局统一宽度」。

**量化复核（`scripts/probe_section_width.py` 跨页测量，视口 500px）**：

| 页面 | 板块左/右内缩 | 板块宽 |
|---|---|---|
| 历史页（修复前） | **0 / 0（满宽贴边）** | 500 |
| 线路页 `.dispatch-page` | 16 / 16 | 468 |
| 首页 `.home-app` | 14 / 14 | 472 |

全局间距 token 为 `--zp-space-4: 16px`（ui-unified.css），线路页即按此值；历史页此前完全无内缩，与各页明显不一致。

**修复**：历史页容器 `main.history-shell` 左右内缩统一到 `var(--zp-space-4,16px)`；同时**归零板块自身的重复缩进**，否则会叠加成 32px——
- `.history-actions` `0 16px` → `0`
- `.history-secondary-row` `0 16px 4px` → `0 0 4px`（以及两处 `2px 8px 10px` → `2px 0 10px`）
- `.history-divider` `margin:14px 16px` → `14px 0`
- `.history-state` `18px 8px` → `18px 0`
- 删除浅色下 `.history-actions/.history-secondary-row` 的 8px 与 `.history-divider` 的 8px 覆盖（会与全局错位）

保留行内文字缩进（`.history-month-main`/`.history-date-main` 的 14/27px），那是内容层级不是板块宽度。

**验证**：历史页四个板块（card/actions/secondary-row/list）双主题均为内缩 16px、宽 468，与线路页逐像素一致；45 项测试 736 ✅；左滑链路（跟手 tx=-60 / 双指无残留 / 单指吸附 -84）无回归；SW zp-pwa-67。

**备注**：首页 `.home-app` 是 14px（比全局 token 少 2px，历史遗留）。本次只按用户要求对齐历史页；首页是否一并统一到 16px 待确认。

---

## #11 首页板块宽度统一到全局 16px

上一节的备注项已确认处理。首页 `.home-app` 原为 `14px`（历史遗留），比全局 token `--zp-space-4: 16px` 少 2px，跨页切换时板块宽度会跳。

**修复**：`css/home.css` 中 `.home-app` 左右 padding 改为 `var(--zp-space-4,16px)`；同时删除 `@media(max-width:380px)` 里把左右收紧到 12px 的覆盖（小屏与大屏内缩不一致会造成同类跳动）。

**验证**：`/home` 的 `.task-card` 与 `.trend-card` 实测 left=16 / right=484 / w=468（视口 500），与线路页、历史页逐像素一致。

**顺带发现（未处理，待确认）**：`/pages/today` 的 `.order-summary-card` / `.order-route-card` 内缩 12px、`.order-store-list` 内缩 17px，与全局 16px 仍不一致。

---

## #12 安卓壳：深色外观下状态栏看不见（P0）

**现象**：APK 里切到「深色外观」，手机顶部状态栏（时间/电量/信号）看不见。

**根因链**（三处叠加，缺一不会复现）：
1. `MainActivity.applyStatusBarAppearance()` 里 `getWindow().setStatusBarColor(Color.TRANSPARENT)`——状态栏背景被强制透明，完全绕过 `capacitor.config.json` 的 `backgroundColor:#05070A`；
2. 图标颜色 `setAppearanceLightStatusBars(!darkMode)` 跟的是**系统**深色模式，不是 App 内的外观设置；
3. `WindowCompat.setDecorFitsSystemWindows(getWindow(), false)` + WebView 顶部 padding = 状态栏高度，于是状态栏背后露出的是 **WebView 的 padding 区，而 WebView 没设背景色 → 默认白色**。

于是「App 深色 + 系统深色」= 白色图标叠在白条上 → 状态栏内容完全不可见；页面本身又是深色，视觉上状态栏整个"消失"。反之「App 深色 + 系统浅色」则是深色图标压在深色页面上，同样看不见。

**另外一个坑**：`@capacitor/status-bar` 插件根本没装（`scripts/setup-android.mjs` 只注入 `android/cli/core`），所以 `capacitor.config.json` 里的 StatusBar 整段是**死配置**，怎么改都不会生效。

**修复**：让「网页外观」成为状态栏配色的唯一真值。
- 壳侧（`MainActivity`）：
  - 新增 `@JavascriptInterface` 对象 `ZhipeiNative.applyTheme(colorHex, darkBg)`，内部在 UI 线程执行 `applyChrome()`：`setStatusBarColor`/`setNavigationBarColor` 设为**不透明主题色**，`setAppearanceLightStatusBars(!darkBg)` 让图标明暗按底色取反，并 `webView.setBackgroundColor(color)` 消除 padding 区白条；
  - `setNavigationBarContrastEnforced(false)`（Android 15 会给手势条强制加对比蒙层，不关就用不上自己的底色）；
  - 启动先按深色 `#05070A` 兜底，网页加载后由网页按实际主题覆盖。
- web 侧：`js/ui-unified.js` 的 `applyTheme()` 回传 `ZhipeiNative.applyTheme(bg, dark)`；`ui-unified.js` 在页面底部，为免首帧跳变，各页 `<head>` 的内联主题脚本（比任何外链 JS 都早）也同步回传一次。

**同步修的隐患**：`android-template/` 下的 MainActivity 还停留在旧版（缺 inset 与字体锁定修复），下次跑 `setup-android.mjs` 会把 `android/` 覆盖回旧版。本次两个目录一并写成同一份新版。

**守护**：`tests/appearance-theme-bootstrap.test.mjs` 新增断言——`ui-unified.js` 必须回传且底色常量与主题一致；所有含 theme-color 的主题页，首屏内联脚本必须同步壳（防止有人把状态栏改回透明/跟随系统）。

**验证**：45 项 node 测试全绿（含 sw-precache 94 项）；SW zp-pwa-68。

---

## #13 管理员改为环境常量：数据库清空后仍能进系统（P0）

**背景（事故）**：Redis 迁库时旧库被删、新库为空，而管理员账号只存在数据库里。
结果形成死锁链：**没有管理员 → 不能创建邀请码 → 不能注册任何用户 → 永远进不去**。
管理员初始化接口 `/api/admin/bootstrap` 又依赖 `ADMIN_SETUP_KEY`，实测该变量未配置（503）。

**修复**：把管理员钉成"环境常量"。

- 新增 `functions/api/_env-admin.js`：
  读 `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH`（= `SHA-256(密码)` 的 64 位小写 hex，
  与 `login.js` 的 `hash()` 同格式）。登录时**播种**——库里没有就把管理员原子补回库里，
  哈希不一致则以环境变量为准（**改环境变量 = 改管理员密码**）。
  - 已就绪时不写库，不浪费额外往返；
  - 哈希格式非法（非 64 位 hex）视为未配置，绝不写半成品管理员；
  - Lua 只负责原子落库，user JSON 在 JS 侧构造（MiniRedis 的 cjson 没有 `cjson.null`）。
- `login.js`：密码校验前先 `ensureEnvAdmin()`。
- `register.js`：管理员账号名列为系统保留名，禁止普通注册抢占（409）。
- 新增 `tools/gen-admin-hash.mjs`：本地生成哈希，**密码不出本机**。
- 诊断端点增补 `adminEnvConfigured` / `adminSetupKeyConfigured`（只报布尔，不回传值）。

**配套环境变量**（Cloudflare Pages，配完**必须重新部署**）：

```
ADMIN_USERNAME        = <管理员账号，3-32 位字母/数字/下划线>
ADMIN_PASSWORD_HASH   = <node tools/gen-admin-hash.mjs '密码' 的输出>
```

**验证**：新增 `tests/env-admin.test.cjs`（15 项，已并入 `npm run test:node`）：
空库登录成功且 role=admin、幂等不重复写库、改哈希后旧密码失效、非法哈希不写库、
用户名不匹配不播种、保留名注册被拒。全量测试通过。

---

## #14 新增线路保存必报错：输入框 id 被 `rn` 格式化函数遮蔽（P1）

**现象**：管理端「线路管理 → 新增线路」无论输入什么名字，点保存都 toast
`Cannot read properties of undefined (reading 'trim')`，线路建不出来。

**根因（作用域遮蔽）**：#12 之前的「线路名统一显示 X 号线」改动在 admin.html
脚本顶层加了 `const rn = v => {...}`（route name 格式化函数）；而「新增线路」
弹窗的输入框 id 恰好也叫 `rn`，保存处理函数依赖浏览器 id 自动全局
（`rn.value.trim()`）。IIFE 作用域里 `const rn` 把 `window.rn` 遮蔽，
`rn.value` 为 `undefined` → `.trim()` 抛错，被弹窗错误处理 toast 出来。
任何名字都存不了，与用户输入无关。

**修复**：输入框 id 改为 `nr`，处理函数显式 `$("nr").value` 读取
（不再依赖 id 自动全局），并加注释说明 id 不能叫 `rn`。

**排查**：同文件其余弹窗输入框 id（nu/op/np/cp/rp/br/bd/iu/id/ic）均无同名
顶层声明，无同类隐患；内联脚本 node 编译全过。

**教训**：给页面顶层加短名常量/函数前，先全文搜一遍同名 id——
id 自动全局会静默被遮蔽，运行时才炸。

---

## #15 线路页「暂未选择配送线路」无选择入口（P1）

**现象**：被管理员绑定过线路的业务账号，线路页「当前配送线路」永远停在
「暂未选择配送线路」，且没有任何按钮能打开选线弹层——无法开始配送。

**根因**：两环叠加。
1. 服务端 `resolveDispatchRoute` 只对「既无调度线路也无业务绑定」的用户
   自动派临时线路；**已绑定**（boundRouteId 有值）但没选过调度线路
   （dispatchRouteId 为空）的用户返回 `null` → 页面落到「暂未选择」分支。
2. 前端 `renderCurrent()` 该分支只渲染一行文字——选线弹层
   （routeSheet）唯一的打开入口是**已选线路后**才渲染的「切换」按钮。
   空状态没有任何入口，死锁。

**修复**：`renderCurrent()` 空状态在卡片内渲染「选择线路」按钮（有可选
线路时），点击打开既有选线弹层，确认后走原 `POST /api/dispatch`；
无可选线路时文案改为「暂无可配送线路，可在线路申请中提交申请」引导。

**验证**：dispatch.html 内联脚本 node 编译全过；`nav-return` 测试 50/50。

---

## #16 线路页主色按钮深色模式下白底白字（P2）

**现象**：深色外观下，线路页「切换」「选择线路」「重试」按钮是一块白色
圆角，文字完全看不见（白底白字）。

**根因**：设计系统里 `--zp-primary` 在深色主题下是**纯白**
（`#FFFFFF`，配套按钮文字色 `--zp-on-primary:#0A0A0A`），而
`.dispatch-switch` / `.dispatch-retry` 写死了 `color:#fff` ——
白底白字。浅色主题下主色是 `#0A0A0A` 配白字，所以浅色没暴露。

**修复**：两处按钮文字改 `var(--zp-on-primary,#0A0A0A)`（跟随主题反相）；
`:active` 由硬编码深底（会把反相文字再次藏掉）改为 `opacity:.82` 按压反馈。
浅色主题覆盖块无需改动（本就正确）。全局排查其余页面无同类写法
（offline.html 那处是浅色覆盖，正确）。

---

## #17 下载应用仍显示 v1.0.7（APK 未随发版同步）

**现象**：关于页顶部版本 v1.0.8，但「下载应用 → 安卓安装包」仍显示 v1.0.7。

**根因**：版本不同步。web `version.json` 因环境变量管理员 + 线路修复已升 1.0.8，
但托管下载的 APK 仍是 `tianbops/zhipei` 私有仓库 v1.0.7 release 的包
（md5 `215ca983…`，size 3846862）。APK 实际来源是 `tianbops/zhipei` 的
GitHub Releases，本仓库 `downloads/` 只镜像最新包——发版时没同步。

**修复**：从 `tianbops/zhipei` Releases v1.0.8 拉取
`zhipei-one-1.0.8-release.apk`（size 3848038，md5 `8053daa7…`，
已校验 ≠ 旧包），覆盖 `downloads/zhipei-one-latest-release.apk`；
`manifest.json` 同步 version→1.0.8 / size→3848038 / updated→2026-10-19。
页面 `account.html` 已动态读 manifest，无需改代码。

**教训**：发版流程须「打 tag vX.Y.Z 出 APK（zhipei 仓库 Releases）
+ 同步本仓库 downloads/ 的 APK 与 manifest + 改 version.json」三者一致，
否则下载页会滞后。安卓工程 `gradle` 的 versionName 此前也漏升，本次一并补到 1.0.8。

---

## V1.0.9 总控核查：版本号统一升 V1.0.9 + 全局大写 V

**范围**：项目总控级全方位核查——web 版本（`version.json` / 下载 `manifest.json` / 关于页显示）与 app 版本（APK `versionName` / `gradle` / 发行版标题）全面对齐，整体升到 **V1.0.9**，并落实「版本号前缀全局统一为大写 V」。

**核查发现与优化**：
- 关于页版本前缀原为小写 `v`（「版本 v」/「安卓安装包 v」），与全局大写 V 约定不符 → 改为大写 `V`（`account.html` 第 262、319 行）。
- 发行版命名原为小写 `智配One vX.Y.Z`（源仓库 `tianbops/zhipei` 与下载页 `zhipei-one` 两处）→ 统一为 `智配One VX.Y.Z`：
  - 源仓库 `android.yml` 构建发布步骤新增 `name: 智配One V${{ steps.ver.outputs.name }}`；
  - 下载页同步 job（`sync-download` → `ensure_release`）发行版名由 `"智配One " + tag` 改为 `"智配One V" + VER`。

**版本真值源（不变）**：git tag 仍是 web 与 APK 唯一真值源。打 `v1.0.9` tag → CI 构建 APK（`versionName` 由 tag 经 `sed` 注入为 `1.0.9`）→ 发布 Release → `sync-download` 自动镜像 APK + `manifest.json` + `version.json` 到 `zhipei-one`，并在 `zhipei-one` 建同 tag 发行版 `智配One V1.0.9` → Cloudflare Pages 部署。

**结果（已验证）**：
- web `version.json` = 1.0.9；下载 `manifest.json` version = 1.0.9（size 3848038，与 1.0.9 真包一致）。
- 关于页显示「版本 V1.0.9」「安卓安装包 V1.0.9」。
- `tianbops/zhipei` 发行版 `v1.0.9`（标题 `智配One V1.0.9`）、`zhipei-one` 发行版 `智配One V1.0.9` 均已创建。
- APK 为 1.0.9 真构建（资产名 `zhipei-one-1.0.9-release.apk`，内部 `versionName` 1.0.9）；其字节大小与 1.0.8 相同属正常（仅版本字符串一字符之差，压缩后总大小不变）。
- app `gradle` `versionName` 1.0.9 / `versionCode` 9（源码基线同步；CI 构建时按 tag 覆盖）。
