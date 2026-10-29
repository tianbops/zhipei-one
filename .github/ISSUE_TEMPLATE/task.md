---
name: 任务（AI 可执行）
about: 任何 CLI Agent 读此模板即可接手的标准任务单
title: "[任务] "
labels: task
assignees: ""
---

<!--
使用说明（给提出任务的人）：
- 本模板刻意不含任何 AI 厂商特定语法，任何 CLI Agent 都能读。
- 五项必填，缺任何一项都可能被执行 Agent 误做。
- 一个 Issue 只做一件事。跨多件事请拆成多个 Issue。
-->

## 1. 任务描述

<!-- 要解决什么问题、涉及哪些文件/端点。自然语言即可，不要写实现方案。 -->

## 2. 验收标准

<!-- 尽量可测试：跑哪个命令、看到什么输出、行为如何变化。 -->
- [ ] 
- [ ] 
- [ ] 
- [ ] `npm run test:node` EXIT=0
- [ ] `npm run coverage` 通过（不得降低阈值）

## 3. 约束

- 遵守仓库 `AGENTS.md` 全部条款（本 Issue 不重复其内容）。
- **零费用**：不引入付费服务、试用期服务、需绑定支付方式的组件。
- **不上架应用商店**：分发只走 GitHub Releases + 站点 `downloads/`。
- **不得降低覆盖率**；**不得把权限判定放到客户端**。
- **不得修改 `AGENTS.md` 本身**（要改约束须由项目所有者另行批准）。

## 4. 回滚要求

```bash
git checkout -b backup/<任务名>-<YYYYMMDD>
git push -u origin backup/<任务名>-<YYYYMMDD>
```

- 合并前必须存在备份分支；
- 若上线后发现问题，回滚方式：`git revert <commit>`（不要 `reset --hard`）。

## 5. 禁止事项

- ❌ 引入任何付费/试用服务
- ❌ 降低测试覆盖率阈值
- ❌ 在客户端（WebView / 原生）做权限判定
- ❌ 提交密钥、token、keystore、`.env`
- ❌ 跳过仓库 `AGENTS.md` 中的"静默失效陷阱"守卫（CSP 哈希 / 资产版本戳 / home bundle 重建）
- ❌ 把功能改动与安全类改动混在同一个 PR

---

<!-- 以下由执行 Agent 填写 -->

## 执行记录

- 备份分支：
- 改动文件：
- 验证命令与结果：
- 未覆盖的假设（必须写清，供后续核查）：
