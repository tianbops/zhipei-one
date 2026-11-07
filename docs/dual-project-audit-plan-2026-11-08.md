# 智配One 双项目专项整改执行计划

**基准日期：** 2026-11-08  
**总控原则：** 先测试版、后正式版；所有修改留证据；未通过不合并。

## 环境基准

- Web 正式：`main` / `https://tianyou-zhipei.pages.dev` / `zp-pwa-478`
- Web 测试：`feat/uber-layout` / `https://feat-uber-layout.tianyou-zhipei.pages.dev` / 当前 `zp-pwa-477`
- Android 正式：`main`
- Android 测试：`test/full-audit-20261108`，Debug APK 必须加载上述 Web 测试地址。
- Preview D1：`zhipei-one-test-20261108`（`3b05311e-d97c-4f85-bc29-9374673c37ab`）
- Preview R2：`zhipei-one-files-test`
- 正式 D1/R2、生产 secrets、正式 Release 不得用于测试写入。

## 工作阶段

1. **环境隔离与门禁**：将 Pages Preview D1/R2 配置固化到 `wrangler.toml`；检查实际部署绑定；验证生产绑定保持不变。
2. **Web 回归基线**：修正已证实过期的首页 E2E 比较断言；运行 Node、静态回归、Chromium E2E、API/业务测试。
3. **Web 业务审计**：登录与角色权限、运单上传/OCR 状态机、幂等、门店匹配、路线规划、确认与学习、历史查询/删除/导出、管理员诊断、PWA 缓存与网络失败恢复。
4. **Android 壳审计**：11 项原生桥契约、模板漂移、返回键、启动屏首帧、状态栏透明与 inset 单位、主题同步、下载/安装更新、版本与签名发布链。
5. **双端联调**：Android Debug APK 连接指定 Web Preview；验证冷启动、远程加载、登录、导航返回、主题/状态栏、文件下载与错误降级。
6. **修复与复测**：按问题逐项 TDD 修复；不改业务阈值、路线基线、OCR 引擎或数据规则来换取速度/测试通过。
7. **验收与发布**：完整 CI、模拟器验证、Preview 实际部署与绑定核对、PR 最终审查；全部通过后恢复 Android 正式 URL、重新验收，再合并 main 与部署。发布后核验线上提交、SW、APK 版本和下载清单。

## 发布门槛

- 测试分支 CI 全绿；Chromium E2E 全绿；Android emulator instrumentation 与启动冒烟通过。
- Preview 实际使用独立 D1/R2；不执行生产数据读写。
- 不把未配置独立 PaddleOCR 凭证的 Preview 识别结果冒充真实 OCR 验收。
- 任何失败项必须有根因、修复提交和复测证据；不得删测试或降级业务规则。
- 本计划阶段内不直接向生产 `main` 写入，不创建正式 Release。
