# AGENTS.md — 智配One Web 端（zhipei-one）

> 本文件是**唯一约束来源**，与任何 AI 厂商无关。任何具备 git / gh 操作能力的执行 Agent
> 接手本仓库前必须完整阅读。约束不含厂商特定语法，换 Agent 不需要改本文件。

## 1. 项目本质

Cloudflare Pages + Pages Functions 的**云端交付**配送单据系统。
核心链路：OCR 录入 → 人工确认 → 历史查询。**明确不做** ERP / TMS / 智能调度。

- 运行时依赖：**零**（`dependencies` 为空，全部用 Cloudflare 内置能力）
- 依赖锁文件：`package-lock.json` **纳入版本控制**（2026-10-30 起）。
  CI 用 `npm ci` 严格按锁文件安装；不得把锁文件重新加回 `.gitignore`，
  否则 CI 会退化为"装当时最新"，构建不可重现且 `npm audit` 无据可依。
- 存储：Redis（Upstash 兼容）为主，D1 为迁移目标
- 前端：原生 JS + 手写 CSS，**无框架、无构建器**（唯一例外见 §4.1 home bundle）

## 2. 硬约束（不可协商）

1. **零费用**：不得引入任何付费服务、试用期服务、需绑定支付方式的组件。
2. **零人工代码审核**：CI 是唯一裁判。本仓库不设"等人 review"的流程。
3. **不上架应用商店**：客户端通过 GitHub Releases + 站点 `downloads/` 分发。
   镜像文件名**必须带版本号**（`zhipei-one-<ver>-release.apk`），目录只留当前版本，
   `manifest.file` 指向它。固定名会让 Android `DownloadManager` 每次都写同一路径，
   下载目录里留着上一版，用户点到哪个全凭运气（2026-10-30 的「装了 V1.0.19 还是旧版」）。
   `tests/download-manifest.test.mjs` 会拦；App 内「更新到 Vx」只认 `manifest.version`，
   不许拿 `version.json` 的网页版本号凑数。
4. **权限判定只能在服务端**：任何"客户端隐藏按钮"都不构成安全边界。
5. **不得降低覆盖率**：`npm run coverage` 四阈值（82/65/83/82）只升不降。
6. **不得把密钥写入仓库**：`secrets.json`、`.env`、`*.pem`、`*.key` 一律不入库。
7. **不得修改本文件**来绕开约束。要改约束须由项目所有者批准。

## 3. 标准工作流

```bash
# 1. 备份分支（每个任务必做，回滚的最后保险）
git checkout -b backup/<任务名>-<YYYYMMDD>
git push -u origin backup/<任务名>-<YYYYMMDD>
git checkout main

# 2. 改动 → 本地验证 → 提交
npm run test:node      # 全量测试（并行，全部跑完再汇总；必须 EXIT=0）
npm run coverage       # 覆盖率棘轮（内部跑 test:serial，保持 c8 口径）

# 3. 推送（部署由项目所有者在本地执行 deploy.sh）
git push origin main
```

## 4. 五道"静默失效"陷阱（改完不跑守卫 = 线上功能消失/回归被掩盖，且不报错）

这四条是本项目历史上真实踩过的坑，全部表现为「页面正常、功能静默失效」：

### 4.1 改了 HTML 内联脚本 → 必须重算 CSP 哈希

```bash
node scripts/csp-hashes.mjs          # 无参数=写入；--check=只校验
```

CSP 用 sha256 白名单放行内联脚本。改了任何 `<script>` 内容而不重算哈希，
现代浏览器会**整体拒绝执行该脚本**，页面只剩静态兜底文案（历史事故：账号页
"检查最新版本"整段失效，用户只看到"下载"）。

### 4.2 改了任何 css/js → 必须刷新资产版本戳

```bash
python3 scripts/bump_asset_versions.py
```

生成 `?v=` 哈希与 SW 预缓存清单，并把 `zp-pwa-*` 递增一档。
不刷会导致老用户拿到旧资源（SW 缓存不换）。

### 4.3 改了 home 的输入源 → 必须重建 bundle

```bash
node scripts/build-home-bundle.mjs
```

`js/home.bundle.js` / `css/home.bundle.css` 是**打包产物**，由以下源逐字节拼接：

- JS 源：`js/home/*`、`js/fetch-retry.js` 等（见 `scripts/build-home-bundle.mjs` 的清单）
- CSS 源：`css/home-*.css`、`css/app.css`、`css/ui-base.css` 等

改了任一源而不重建，`tests/home-bundle-fresh.test.mjs` 会红；更严重的是 home 页
会继续加载旧样式/旧逻辑。**注意：`css/app.css`、`css/ui-base.css` 是共享源，
改它们必须重建，不要误判为"只是主站改动"。**

### 4.4 改了页面/入口命名 → 必须跑命名检查

```bash
npm run check:naming
```

校验仓库名 / package.json / wrangler.toml / manifest.json / Android applicationId
五域一致。依赖 `git fetch --unshallow` 的完整历史。

### 4.5 改了测试脚本 → 必须确认「全部跑完」，不是「第一处失败就收工」

```bash
npm run test:node      # 并行执行器：全部文件跑完再汇总（推荐日常用）
npm run test:serial    # 原 97 段串行链：保留为 c8 覆盖率口径 + 应急排查
```

`test:node` 曾是一条 97 段 `&&` 串行链，**单点失败会静默跳过其后全部测试**。
真实事故（2026-10-29）：`home-bundle-fresh` 一处失败，其后 30+ 个测试从未执行，
CI 只报「失败」不报「还有 30 个没跑」——回归后门。

现在 `test:node` → `scripts/run-tests-parallel.mjs`：从 `test:serial` 反解清单，
一次性交给 `node --test` 全量跑完再汇总。新增测试必须同时加进 `test:serial`
（否则并行器看不到它），且片段形态只能是 `node tests/<文件>` 或
`node scripts/<文件>`——不认识的形态会让并行器直接报错，而不是静默丢弃。

## 5. 架构地图

| 路径 | 作用 | 改动风险 |
|---|---|---|
| `functions/api/` | 29 个路由端点 + 52 个库模块（`_` 前缀） | 高（安全面） |
| `functions/api/_auth.js` | 会话解析，唯一身份来源 | 极高 |
| `functions/api/_permissions.js` | 角色/线路判定函数集 | 极高 |
| `functions/api/_waybill-acl.js` | 运单级读写判定 | 极高 |
| `js/` | 主站逻辑（按页面/领域分目录） | 中 |
| `js/home/` | 首页逻辑，**需打包** | 中（记得 §4.3） |
| `css/ui-base.css` | **设计令牌唯一来源**（`:root`） | 高（全站观感） |
| `pages/` | 业务页面（10 个） | 中 |
| `tests/` | 99 个测试文件 | — |

## 6. 设计与响应式纪律

- **颜色/字号/圆角必须用令牌**：`var(--zp-primary)`、`var(--zp-fs-14)`、`var(--zp-r-card)` 等，
  定义在 `css/ui-base.css` 的 `:root`。硬编码字面量会被 `tests/theme-token-discipline.test.mjs` 拦截。
- 输入框字号**不得低于 16px**：iOS 上小于 16px 会自动放大页面（已有守卫测试）。
- 主题：`data-zp-theme="dark|light"` 挂在 `<html>`，两套变量自动切换。

## 7. 安全纪律

- 新增端点必须：`currentUser` 拿到用户 → 用 `_permissions.js` 的函数判定 → 不满足返回 403。
  **不得**在端点内手写角色字符串比较（现有 `isAdmin` 局部常量属历史遗留，新代码不要模仿）。
- 错误响应**不得**包含 `error.stack`、内部路径、依赖调用栈。
  统一格式：`{success:false, code:"...", error:"面向用户的中文提示"}`。
- 涉及线路数据的端点必须校验归属（`canMaintainRoute` / `canReadRouteData` / `canWriteWaybill`）。
- 反向测试是硬要求：改权限相关代码，必须同时提交"不该发生的事没发生"的断言
  （跨线路访问必须 403、未登录必须 401）。

## 8. 返回机制约束（ZP-NAV-2026-002，2026-10-30 定稿）

模型：**层级返回 + 单根收口**（2026-10-30 二次修订，见 `docs/adr/0004`）。
返回的语义是「上一层界面」，既不是「上一个文档」，也不是「一律回首页」。

1. 按页面层级返回，层级表写死在 `js/ui/back.js` 的 `zpPageDepth`：
   - **depth 0** 工作区根 `/home`、`/admin` → 两次返回退桌面；
   - **depth 1** 功能根页 `history` / `dispatch` / `account` / `today` → 回区根，彼此**不**回跳；
   - **depth 2** 细节页 `order_detail` / `data` / `route_apply` / `privacy` / `terms`
     → 回来源父级（`from=` 白名单），无来源才回区根；详情回历史时带上原 `date` 定位。
   目标深度必须**严格更小**，所以不会平级横跳、不会跨区。唯一例外是 detail⇄data 的编辑往返
   （返回原运单），在 `zpParentOf` 里显式声明 `allowSameDepth`。
   **新增页面必须登记层级**，未登记的按 depth 1 处理（只往区根走）。
2. 业务首页再返回 → 两次返回退桌面；**不登出、不清本地登录态**。
3. 管理员区任何模块返回 → 先收口到管理员首页（模块 0）；管理员首页再返回 → 退桌面。
   管理员**不得**返回业务首页（业务区门禁：admin 会话不停留业务页）。
4. 返回键**永不**触发登出。登出只有两条路径：用户主动点、401/权限失效。
   `js/ui/back.js` 内出现 `fetch("/api/logout")` 视为回归，`tests/nav-admin-exit.test.mjs` 会拦。
5. 弹层/未保存/保存中优先于页面导航：一层一返回，脏数据确认后不穿透。
   未提交内容的确认**只有两个选项**：继续编辑 / 放弃（`zpConfirmDiscard()`）。
6. **不可中断操作期间返回一律被拦下**（`zpBusyMessage()`）：运单 OCR/规划在途
   （`window.zpIsProcessing`）、核对页确认提交在途（`window.zpIsConfirming`）时，
   返回只提示、不关弹层、不离开页面。这类操作**不提供取消出口**——首页原「取消处理」
   按钮已于 2026-10-30 删除，取消只会留下「服务端已落库、用户以为放弃」的运单。
7. Tab 根页（`/pages/history`、`/pages/dispatch`、`/pages/account`）**不显示页面内返回箭头**，
   顶栏用 `class="topbar is-root"`（单列 grid，标题居中）。子页面仍显示箭头。
8. 页面内返回箭头、Android 系统返回、浏览器后退走同一套 `zpHandleBack()`。
   壳侧入口是 `window.zpSystemBack()`（登录页返回 = 退出 App），改壳必须同时改这里。
   **原生返回键不得走 `webView.goBack()`**（2026-10-30 定稿，v1.0.19，见 `docs/adr/0003`）：
   goBack 只认「上一页文档」，看不到页面内还开着的确认框，会把弹层连同未处理内容一起丢掉。
   壳里只做一件事——调 `window.zpSystemBack()`；JS 未就绪时才退回 `goBack/finish` 兜底。
   退出也走原生：`zpDoExit()` 优先 `ZhipeiNative.exitApp()`（finish），浏览器里才 `history.back()`。
   红线由 `tests/nav-back-channel.test.mjs`（Web）与 `scripts/check-back-channel.mjs`（客户端）守。
9. 改返回逻辑必须同步 `tests/nav-return.test.mjs`（层级矩阵）、
   `tests/nav-admin-exit.test.mjs`（管理员出口）、`tests/nav-busy-guard.test.mjs`
   （忙碌守卫 / 取消按钮缺席 / 根页无箭头）；三者都是阻塞项。
10. **不提供草稿**（2026-10-30 定稿，见 `docs/adr/0002`）。返回时未提交内容一律
   走「继续编辑 / 放弃」确认，**不落本地、不可恢复**。不要新增 `localStorage`/`sessionStorage`
   草稿写入、不要加「存草稿并离开」按钮——`tests/nav-busy-guard.test.mjs` 会拦。
11. **站内导航一律 `location.replace`，且占位只压在工作区根**（2026-10-30 定稿）。
   多页架构下 `<a href>`、`location.href=...`、`location.assign()` 都会 push 一条历史，
    栈里压着历史页/详情页之后，首页按返回就会「首页 → 详情 → 历史 → 才退出」，方向不可预期。
   - `js/ui/back.js` 全局拦截站内 `<a>` 并改走 replace；新代码**禁止**写站内 `location.href=` / `location.assign()`。
   - 占位（`zpPushGuard`）**只允许在 `/home`、`/admin` 压**。子页面压占位会让 replace
     替换的是占位而不是页面本身，旧页面记录永久残留（实测：首页 → 首页 → 历史 → 首页）。
   - 子页面因此没有常驻占位：不可中断操作（保存等）开始时必须调 `window.zpArmGuard()`，
     否则返回键会直接离开页面、绕过 `zpBusyMessage`。
   - **补压只在「下面还压着弹层」时发生**（`if(zpTopHook())zpPushGuard()`）。顶部返回按钮与
     原生返回键不消费历史，无条件补压会平白堆出一条记录，离开本页时 replace 只替换当前项，
     这条记录就成了指向内页的孤儿。
   - 菜单/抽屉**不得**自压历史记录（`history.pushState({zpMenu…})` 已删除）：层级由
     `zpRegisterBackHook` 表达，历史里多一层就会在「菜单开着直接跳页」时留下孤儿。
   `tests/nav-no-history.test.mjs` 与 `tests/nav-back-channel.test.mjs` 会拦；
   真浏览器回归见 `tests/e2e-nav-back-stack.cjs`（序列应为 `/home → /home → 桌面`）。
12. `from=` 只是**父级提示**，不是跳转指令：只认 `zpFromParent` 白名单键
   （`history` / `dispatch` / `account` / `process` / `home`）。**禁止**直接拿 `from` 拼路径——
   `?from=admin` 曾能把业务页送进管理端，`?from=//evil.example/x` 能跳到站外。
   对抗用例在 `tests/nav-return.test.mjs`（`from=admin` / `constructor` / `../admin` / `//evil`）。

## 9. 触感反馈约束（2026-10-30 定稿，v1.0.20）

触感只有一个入口：`window.zpHaptic(kind)`（`js/ui/haptic.js`）。**禁止**在业务代码里直接调
`navigator.vibrate()` 或 `ZhipeiNative.haptic()`——通道选择与降级只在这里做一次。

1. 四档语义，别自创：`light`（底栏 tab、普通按钮）/ `medium`（主操作、底部悬浮按钮）/
   `success`（成功确认）/ `warn`（失败警示）。未知值一律按 `light`——写错要能震，不能静默不震。
2. 通道优先级：`ZhipeiNative.haptic`（壳内，`View.performHapticFeedback`）> `navigator.vibrate`（浏览器）。
   **App 内只有原生桥能震**：WebView 不实现 Vibration API，指望网页兜底等于没有触感。
   壳侧**不申请 VIBRATE 权限**，也不自己写震动时长——强度交给系统按机型马达标定。
3. 尊重系统开关。用户关掉「触摸振动」时不震就是正确结果，不要为了「一定震」改用 `Vibrator`
   强行震，也不要在页面上做「触感不可用」的提示。
4. 触发点绑 `click`，不绑 `pointerdown/touchstart`：手指按下后在按钮上滑走（滚列表的常见动作）
   不该震。监听在 capture 阶段，业务 handler 的 `stopPropagation` 吞不掉它。
5. 节流：同类 120ms、异类 60ms，静默丢弃不排队——触感只有几毫秒时效，补震是错的。
6. 新按钮要触感，加 `data-zp-haptic="medium"` 即可，**不要**改 `haptic.js` 加选择器。
   常驻底栏（`.zp-nav a` / `.admin-nav a`）已自动覆盖。
7. 新增或改名壳侧方法必须同步客户端仓 `scripts/check-bridge-contract.mjs` 的 `CONTRACT` 表：
   网页调了个不存在的方法，表现只是「点了没反应」，构建与 CI 全绿。
   红线由 `tests/haptic.test.mjs`（Web）与 `scripts/check-bridge-contract.mjs --web`（客户端）守。

## 10. 统计口径（2026-10-30 定稿）

同一批货在首页、历史页、详情页必须显示**同一个数字**。口径不统一比精度不够更糟：
司机对不上账，就会去怀疑数据本身。

1. **重量一律 3 位小数**（`1.500t`，不是 `1.50t`）。2 位在小批量货上会丢掉几百克的差异，
   与运单原件对账时看不出差在哪。实现点：`js/history/core.js` 与 `js/order_detail/core.js`
   的 `fmtWeight`、`js/home-monthly.js`、`js/home/today.js`、`functions/api/history-export.js`。
   取整方式统一 `Math.round(v*1000)/1000` 再 `toFixed(3)`——先四舍五入到千分位再补零，
   避免 `toFixed` 在浮点边界上给出 `1.2349999…` 这类尾巴。
2. **统计三项统一「X单 X家 Xt」**，顺序固定：单量 → 门店家数 → 重量。
   出现位置：首页今日配送卡、首页月度/年度统计汇总、历史页月份条（日行仍是「X家 · Xt」）。
3. **口径定义**：单 = 当日/当月的**有效运单数**（同一天上传两次就是 2 单，不假定为 1）；
   家 = 运单内门店数之和（`summary.finalCount || summary.total || stores.length`，
   历史汇总用 `storeCount`）；吨 = 总重量之和，不预先取整（后端透传原值，只在展示层格式化）。
4. **护栏**：`tests/weight-precision.test.mjs` 做全仓扫描——出现 `toFixed(2)`、`*100/100`
   或 `'0.00'` 占位即红。新增展示重量时改 3 位，不要为某处「看起来短一点」单独降精度。
   真机布局另有 `tests/e2e-stats-scope.cjs`：三项变长后月份条不得挤标题、汇总行不得顶掉「峰值」。
5. **放不下就换行，不要在原地硬挤**。统计项变多是常态，靠压字号/省略单位/截断来兜是错的：
   首页趋势卡底排（汇总三项 + 「年度峰值 11月 · 63单　最忙 10月30日 · 1单」）在 390px 上就装不下，
   2026-10-30 的表现是两块文字直接叠在一起。现在的写法是 `.trend-bottom-row{flex-wrap:wrap}`，
   空间不足时提示整块落到第二行右对齐，短文案（月度视图）仍同排。
   **`.trend-hint` 不得写 `flex:none`**——hint 拒绝收缩 + `summary{min-width:0}` 会让 summary
   被压到一百来像素、三项折成一列并压住提示。护栏：`tests/home-trend-row.test.mjs`（静态，进
   `test:serial`）+ `tests/e2e-stats-scope.cjs`（真浏览器，按 390/360/320/430 四档量**文字矩形**，
   注意必须量每个文本节点求并集，量元素盒子会漏报）。

## 11. 已知架构决策（勿轻改）

| 决策 | 理由 | 记录处 |
|---|---|---|
| 客户端是远程 WebView 壳，不内嵌网页 | 双端同源，改一次两端生效 | 客户端仓 README |
| 任何业务用户可切换任意启用线路为调度线路 | 代班/替班场景（`isSubstitute` 语义），跨线路只读是**设计意图**；但这是当前最大的数据横向暴露面，**扩到多公司前必须按组织隔离** | `docs/adr/0001-阶段三决策记录.md` 决策 3 |
| 管理员不进业务列表（`/api/admin/users` 过滤） | 管理员不可被绑定线路、不产生业务数据 | `functions/api/users.js` |
| CSP 用 hash 白名单而非 nonce | CF Pages 静态托管无逐请求 HTML 生成 | `docs/CSP-hardening.md` |
| 首页走 bundle 打包而非模块化 | 减少首屏请求数 | `scripts/build-home-bundle.mjs` |
| ACL 不做请求级中间件化 | 关键判定是数据级（这张运单归不归你），中间件只能覆盖登录/角色，重构 29 个端点无安全收益 | `docs/adr/0001-阶段三决策记录.md` 决策 2 |
| 返回按页面层级（不查历史、不一律回根） | 层级是产品的确定结构；站内导航已全 replace，历史栈里没有「上一页」可用 | `docs/adr/0004-返回按页面层级.md` |
| 错误响应按「域内错误/未预期异常」二分 | 业务失败本身就是给用户看的中文提示，一刀切脱敏是体验倒退 | `docs/adr/0001-阶段三决策记录.md` 决策 1 |

## 12. 提交与 PR 规范

- 提交信息：`type(scope): 中文描述`，type ∈ `feat|fix|refactor|style|test|docs|chore`。
- 一个提交只解决一件事。安全类改动**必须单独成 PR**，不得与功能改动混提。
- PR 描述须含：改了什么 / 为什么 / 如何验证 / 回滚方式。
