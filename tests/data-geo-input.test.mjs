/* 数据中心「粘贴链接却解析不出坐标」回归（2026-11-05）
 * ------------------------------------------------------------------
 * 用户实测：43 家门店填了地址链接、提交更新后全部仍显示「未定位」。
 * 排查结论（两条系统性静默失败）：
 *   1) 高德 App「分享」到微信/剪贴板常带文案前缀，整段不是 URL。
 *      旧版 looksResolvable / pending / autoLocate 都要求字符串以 http 开头，
 *      这类粘贴被整批跳过 —— 不发请求、不报错，用户只看到「提交成功」。
 *   2) 服务端 expand() 只看 redirect:"follow" 的最终 res.url，且强依赖桌面 UA。
 *      短链落地内容随出口变化：云端 Worker 可能拿到通用首页或 callAPP 中转页，
 *      坐标在「第一跳 Location」或 android/ios 参数里，旧解析器只认 p=。
 *   3) 失败反馈 2.6 秒自动消失，且只说「N 家没取到位置」，不说明原因。
 *
 * 这里锁死修复后的契约，防止任何一条悄悄退回去。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "pages/data.html"), "utf8");
const parse = readFileSync(resolve(root, "functions/api/store/_geo-parse.js"), "utf8");
const geoApi = readFileSync(resolve(root, "functions/api/store/geo.js"), "utf8");

/* 1. 前端：从任意文本里提取链接，不再要求整段以 http 开头 */
assert.ok(html.includes("function navUrlOf("), "必须有从文案里提取链接的 navUrlOf()");
assert.ok(!/function looksResolvable\(v\)\{return \/\^https\?:\\\\\//.test(html), "looksResolvable 不得再只认 http 开头");
assert.ok(/looksResolvable\(v\)\{return !!navUrlOf\(v\)/.test(html), "looksResolvable 须认带文案的分享文本");
assert.ok(/function needsGeo\(s\)[\s\S]{0,260}navUrlOf\(s\?\.navigation\)/.test(html), "needsGeo 须从带文案文本里提取链接再判定");
assert.ok(/const targets=\(list\|\|\[\]\)\.filter\(needsGeo\)/.test(html), "autoLocate 的 targets 须走 needsGeo（认带文案文本 + geoFrom 变更）");
assert.ok(/autoLocate[\s\S]{0,1200}text:navUrlOf\(x\.navigation\)/.test(html), "提交给接口的 text 须是提取出的纯链接");
assert.ok(/const pending=stores\.filter\(needsGeo\)\.length/.test(html), "提交时的 pending 须走 needsGeo（换链接也要重解析）");
assert.ok(/item\.navigation=link\|\|\(editGeo\?"":navText\)/.test(html), "编辑保存须把文案规范化成纯链接（否则渲染出打不开的链接）");

/* 2. 前端：失败必须可见，且说明原因 */
assert.ok(html.includes("function geoReasonText("), "失败原因须映射成中文提示");
assert.ok(html.includes("const GEO_REASON="), "须保留失败原因字典");
assert.ok(/const detail=Object\.keys\(reasons\)/.test(html), "提交反馈须汇总各失败原因分布");
assert.ok(/bump\("REQUEST_FAILED"\)/.test(html), "接口异常须计入失败原因，不得静默吞掉");
assert.ok(html.includes('"重新识别",()=>submitStores(),true'), "定位失败须常驻显示并提供重试");
assert.ok(/if\(!sticky\)showDataFeedback\.timer=/.test(html), "sticky 反馈不得自动消失");
assert.ok(html.includes("const noLink="), "填了文字地址而非链接时须明确告知");
assert.ok(/不是链接（是文字地址或备注）/.test(html), "文字地址提示须说清怎么改");

/* 3. 服务端：接口认带文案文本 */
assert.ok(geoApi.includes("extractUrl"), "/api/store/geo 须从分享文案里提取链接");
assert.ok(geoApi.includes("!v.error"), "缓存不得把历史失败结果当成成功复用");

/* 4. 服务端：逐跳抓第一跳 Location，不依赖最终落地页 / UA */
assert.ok(parse.includes('redirect: "manual"'), "expand 须用 manual 逐跳读取 Location");
assert.ok(parse.includes("MAX_HOPS"), "逐跳须有跳数上限");
assert.ok(parse.includes("function hopAllowed("), "跨 host 跳转须过白名单防 SSRF");
assert.ok(parse.includes("coordFromUrl(next)"), "每一跳的 Location 都要尝试解析坐标");
assert.ok(parse.includes("needFollow"), "opaque redirect 须有 follow 兜底");
assert.ok(!/if \(sawOpaque \|\| true\)/.test(parse), "不得无条件重复打外网（subrequest 配额）");

/* 5. 服务端：callAPP 中转页三种形态 + 中转 HTML 的 lat/lon */
assert.ok(parse.includes('q.get("q")'), "fromCallApp 须认 q= 位置分享");
assert.ok(/q\.get\("lat"\)[\s\S]{0,200}q\.get\("lon"\)/.test(parse), "fromCallApp 须认 lat/lon");
assert.ok(parse.includes("function fromLatLon("), "URL 上直接的 lat/lon 也要能解析");
assert.ok(parse.includes("[?&](?:lat|latitude)="), "中转 HTML 里的 lat/lon 也要能解析");
assert.ok(parse.includes("function extractUrl("), "解析器须能从带文案文本里取链接");

console.log("数据中心坐标解析：带文案 / 逐跳 / 失败可见 静态契约通过");
