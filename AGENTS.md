# AGENTS.md — 智配One Web 端（zhipei-one）

> 本文件是**唯一约束来源**，与任何 AI 厂商无关。任何具备 git / gh 操作能力的执行 Agent
> 接手本仓库前必须完整阅读。约束不含厂商特定语法，换 Agent 不需要改本文件。

## 1. 项目本质

Cloudflare Pages + Pages Functions 的**云端交付**配送单据系统。
核心链路：OCR 录入 → 人工确认 → 历史查询。**明确不做** ERP / TMS / 智能调度。

- 运行时依赖：**零**（`dependencies` 为空，全部用 Cloudflare 内置能力）
- 存储：Redis（Upstash 兼容）为主，D1 为迁移目标
- 前端：原生 JS + 手写 CSS，**无框架、无构建器**（唯一例外见 §4.1 home bundle）

## 2. 硬约束（不可协商）

1. **零费用**：不得引入任何付费服务、试用期服务、需绑定支付方式的组件。
2. **零人工代码审核**：CI 是唯一裁判。本仓库不设"等人 review"的流程。
3. **不上架应用商店**：客户端通过 GitHub Releases + 站点 `downloads/` 分发。
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
npm run test:node      # 全量测试链（必须 EXIT=0）
npm run coverage       # 覆盖率棘轮

# 3. 推送（部署由项目所有者在本地执行 deploy.sh）
git push origin main
```

## 4. 四道"静默失效"陷阱（改完不跑守卫 = 线上功能消失，且不报错）

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

## 8. 已知架构决策（勿轻改）

| 决策 | 理由 | 记录处 |
|---|---|---|
| 客户端是远程 WebView 壳，不内嵌网页 | 双端同源，改一次两端生效 | 客户端仓 README |
| 任何业务用户可切换任意启用线路为调度线路 | 代班/替班场景（`isSubstitute` 语义），跨线路只读是**设计意图** | 待补 ADR（见待办） |
| 管理员不进业务列表（`/api/admin/users` 过滤） | 管理员不可被绑定线路、不产生业务数据 | `functions/api/users.js` |
| CSP 用 hash 白名单而非 nonce | CF Pages 静态托管无逐请求 HTML 生成 | `docs/CSP-hardening.md` |
| 首页走 bundle 打包而非模块化 | 减少首屏请求数 | `scripts/build-home-bundle.mjs` |

## 9. 提交与 PR 规范

- 提交信息：`type(scope): 中文描述`，type ∈ `feat|fix|refactor|style|test|docs|chore`。
- 一个提交只解决一件事。安全类改动**必须单独成 PR**，不得与功能改动混提。
- PR 描述须含：改了什么 / 为什么 / 如何验证 / 回滚方式。
