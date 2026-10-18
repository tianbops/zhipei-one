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
