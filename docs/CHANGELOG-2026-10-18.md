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
