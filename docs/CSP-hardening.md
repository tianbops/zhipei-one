# CSP 加固与 `'unsafe-inline'` 去留评估（P1-7）

> 结论先行：**nonce 化在当前架构下不可行**（Cloudflare Pages 静态托管无逐请求 HTML 生成，
> 无法为每次响应注入新鲜 nonce）。去 `'unsafe-inline'` 的**可行路径是 hash-based CSP**，
> 但属于「必须构建自动化 + 全页面 E2E」的高风险改动，**不建议在本轮以手改方式上线**。
> 本期仅落地评估与纠偏，CSP 维持现状（保留 `'unsafe-inline'`，定位「堵外传 + 反嵌套」）。

## 一、现状实测（2026-10-22）

| 维度 | 实测 |
|---|---|
| CSP 位置 | 两处：静态 `_headers` 的 `/*` 块 + `functions/api/_json.js` 的 `SECURITY_HEADERS`（一致性由 `tests/security-headers.test.mjs` 断言） |
| `script-src` 现值 | `'self' 'unsafe-inline'` |
| 被服务页面内联 `<script>` 块 | **34 个 / 16 页**（主题引导、配置初始化、每页 boot 等） |
| 被服务页面内联事件属性（`onclick=` 等） | **0**（`data.html` 历史上曾有，现已全部改为 `addEventListener`） |
| `eval()` / `new Function()` | **0**（无动态代码生成，不构成 hash-based CSP 的硬阻断） |
| 内联事件属性残留 | 仅 `tools/android-e2e-*.html`（5 处，开发/测试助手，**不被服务**） |

> ⚠️ **纠偏**：`functions/api/_json.js` 注释与项目记忆里「`data.html` 24 处内联事件属性」
> 已**过时**——`data.html` 现为 0 处。真正需要 `'unsafe-inline'` 的理由是上述 **34 个内联
> `<script>` 块**（块可用 hash 覆盖），而非内联事件属性。

## 二、为什么 nonce 化不可行

CSP nonce 的正确用法是「服务端为**每次响应**生成随机 nonce，写入 CSP 头与该响应 HTML 的
`<script nonce="...">`」。Cloudflare Pages 的静态 HTML 是**预生成、逐字节一致**的，
没有逐请求渲染层可注入 nonce。要 nonce 必须引入一层 **Pages Function / Middleware 代理**
重写每一个 HTML 响应体——这会给全站首屏加一次函数往返、改变缓存语义，并让「静态托管」
的简洁性与 `_headers` 缓存策略（`immutable-year` 等）全面受冲击。收益（去掉 unsafe-inline）
远小于代价，**判为不可行**。

## 三、可行路径：hash-based CSP（本期不执行，仅记录方案）

由于 34 个内联 `<script>` 块都是**静态、字节稳定**且**无 eval/new Function**，可对每个块
计算 `sha256-<base64>` 写入 `script-src`，从而移除 `'unsafe-inline'`：

```
script-src 'self' 'sha256-AbCd...=' 'sha256-EfGh...=' ...
```

**为何本轮不手改上线**：
1. **两处必须同步**：`_headers` 与 `functions/api/_json.js` 的 CSP 都要列同一组 hash，
   漏一处即该通道下的页面 JS 被拦。
2. **脆弱性**：任何内联脚本改动（哪怕一个空格）都会让其 hash 失效 → 该页内联 JS 被拦 →
   功能损坏甚至白屏。34 个块散落 16 页，手改无法保证不漂移。
3. **必须构建自动化**：新增脚本「抽取各页内联脚本 → 计算 sha256 → 写入两处 CSP」，
   并由 CI 守卫「_headers/_json.js 中的 hash 集合 == 当前各页内联脚本 hash 集合」，
   与 `bump_asset_versions.py` 同类治理。
4. **必须全页面 E2E**：改错一个 hash 就坏一个页面，需 headless 逐页验证内联脚本仍执行
   （主题引导生效、boot 正常），不能只跑单测。

## 四、建议（后续独立任务）

- 将 P1-7 升级为一个**独立、构建自动化、带 E2E 守卫**的任务再执行，顺序：
  ① 写 `scripts/gen-csp-hashes.mjs`（抽取 + 计算 + 双处注入）；
  ② 加 `tests/csp-hashes.test.mjs` 防漂移（并入 `test:node`）；
  ③ headless 逐页验证内联脚本执行；
  ④ 移除 `'unsafe-inline'`，保留 `style-src 'unsafe-inline'`（内联 `style=` 属性仍存在）。
- 在具备「逐请求渲染」需求前，不引入 nonce / HTML 重写中间件。

## 五、本期落地

- 本文档（评估 + 纠偏 + 方案）。
- 纠正 `functions/api/_json.js` 中过时的「data.html 24 处内联事件属性」注释，
  改为「34 个内联 `<script>` 块；去 unsafe-inline 走 hash-based，见 docs/CSP-hardening.md」。
- CSP 维持现状，`tests/security-headers.test.mjs` 继续守护双处一致。

---

## 六、P1-7b 已落地（hash-based 灰度，2026-10-22）

按第四节建议顺序执行完毕：

1. **生成器**：`scripts/csp-hashes.mjs`（`npm run csp:hashes`）。扫描全仓库
   21 个 HTML，抽取可执行内联 `<script>` 块（跳过 `src=` 与 `application/json`
   等数据岛 type），逐段 sha256-base64，产出 **18 段唯一哈希**（42 块去重——
   多页共享同一段主题引导脚本），写入 `functions/api/_csp-hashes.js`，
   并用**同一组装函数**重写 `_headers` 的 CSP 行（单一真源）。
2. **API 侧**：`functions/api/_json.js` 运行时 `import {cspWithInlineHashes}`
   组装（`_headers` 对 Pages Functions 无效，故必须双边发）。
3. **灰度形态**：`script-src 'self' 'unsafe-inline' <18 hashes>`。
   CSP3 浏览器见 hash 即忽略 `'unsafe-inline'`（只放行哈希命中块）；
   旧浏览器不识 hash、回退 `'unsafe-inline'`——无版本切换风险。
4. **前置清理**：`tools/android-e2e-{helper,launcher}.html` 的 5 处内联事件
   属性已改 `addEventListener`（hash 生效后内联属性会被拦停）；全仓库复检
   0 处内联事件属性、0 处 `javascript:` URL、0 处 `eval(`/`new Function(`。
5. **守卫**：`tests/csp-hashes.test.mjs`（并入 `test:node`）钉死四件事——
   ① `--check` 漂移（HTML 变了没重跑即红）；② `_headers` CSP 行 ≡
   `_csp-hashes.js` 表 ≡ `_json.js` 运行时值；③ 灰度形态（unsafe-inline
   回退 + 全部 hash 在场）；④ 防回归（禁内联事件属性 / 禁 eval）。
   与 `tests/security-headers.test.mjs` 双保险。

### 纪律（后续改 HTML 必读）

- **改任何 HTML 的内联 `<script>` 后必须重跑** `npm run csp:hashes`，
  否则现代浏览器会拦截未列入哈希的内联脚本——表现为页面功能**静默失效**
  （主题不生效、boot 不跑），且 `'unsafe-inline'` 仍在头里、极易误判。
- 新增页面若含内联脚本，同样要走生成器；`--check` 会在 CI 拦下漏跑。
- 彻底移除 `'unsafe-inline'`（script-src）的前置条件：内联 `style=` 属性
  清零（当前 `style-src 'unsafe-inline'` 仍需要），属独立任务。
