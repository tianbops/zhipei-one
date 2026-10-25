# 智配One · API 契约（自动生成）

> 本文件由 `scripts/gen-api-docs.mjs` 从 `functions/api/*.js` 的导出签名静态扫描生成，**请勿手改**。
> 更新端点后运行 `npm run docs:api`（或 `node scripts/gen-api-docs.mjs --check` 校验防漂移）。

**统一响应格式**：`{ success: boolean, error?: string, code?: string }`（失败时 `success:false`）。
鉴权走 `credentials: "same-origin"` 的会话 Cookie；写操作（POST/PUT/DELETE）前端默认不做自动重试。

**端点数：28**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/account-settings` | — |
| POST | `/api/admin/bootstrap` | — |
| GET / POST | `/api/admin/global-learning` | 列出现有全局学习记录供管理员选择；只读，不改变学习状态。 |
| POST | `/api/admin/manage` | — |
| POST | `/api/admin/reset` | — |
| GET / POST | `/api/admin/route-requests` | — |
| GET / POST | `/api/admin/users` | — |
| GET / PUT | `/api/base` | — |
| GET / POST | `/api/bootstrap` | — |
| GET / POST | `/api/dispatch` | — |
| ALL | `/api/health` | — |
| GET | `/api/history-export` | — |
| GET | `/api/history-lookup` | — |
| GET / POST / DELETE | `/api/history-trash` | — |
| GET / POST | `/api/invite-codes` | — |
| GET / POST | `/api/learning` | — |
| POST | `/api/login` | POST /api/login —— 账号口令登录，成功后下发 7 天会话 Cookie（HttpOnly + SameSite=Lax + Secure… |
| POST | `/api/logout` | — |
| GET | `/api/me` | GET /api/me —— 取当前登录用户（会话 Cookie 校验）。 未登录返回 401；页面靠它判断要不要跳登录页，管理端 boot 靠它确认 a… |
| GET | `/api/redis-diag` | Redis 链路自检（临时诊断用）：确认 Cloudflare Pages 当前到底连的是哪个库、 Worker 落在哪个 PoP、Worker→Redi… |
| POST | `/api/register` | — |
| POST | `/api/route-binding` | — |
| GET / POST | `/api/route-requests` | — |
| POST | `/api/route-unbind` | — |
| POST | `/api/store-learn` | — |
| POST | `/api/waybills/confirm` | 指纹漂移回收（2026-10-07 生产实测发现）。 businessFingerprint 的入参包含每个门店的 pending / routeOrde… |
| POST | `/api/waybills/extract` | — |
| POST | `/api/waybills/process` | 智配One · 运单处理入口（POST /api/waybills/process） ----------------------------------… |
