/* 上传/识别提速的守卫
   背景（生产实测）：规划各阶段（提取/匹配/去重/规划）均 0ms，单张运单总耗时 7428ms
   中有 7238ms 花在 OCR（提交 3.8s + 轮询 2.1s + 取结果 1.0s）。因此提速只有两个着力点：
     1) 多图不要串行等：N 张 = N×7s，改为每批最多 4 张并发；
     2) 上传前压缩图片：手机截图 2-5MB 会拉长上传与 OCR 提交。
   本测试做静态守卫，防止后续改动退回串行/去掉压缩。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backend = readFileSync(new URL("../functions/api/waybills/process.js", import.meta.url), "utf8");
const frontend = readFileSync(new URL("../js/home/upload-process.js", import.meta.url), "utf8");

// 1) 后端：多图分批并发（单图批大小=1，行为不变）
{
  assert.ok(/const CONCURRENCY=files\.length>1\?4:1/.test(backend),
    "多图应使用每批最多 4 张并发（单图批大小必须为 1，保持原行为）");
  assert.ok(/Promise\.allSettled\(batch\.map/.test(backend),
    "批内应使用 Promise.allSettled 并发识别，并统一处理失败");
  assert.ok(/for\(const s of settled\)results\.push\(s\.value\)/.test(backend),
    "并发结果必须按文件顺序收集，保证 imageTexts 顺序与截图顺序一致");
  assert.ok(/const batchId=batch\.length>1\?`zp-\$\{requestId\}-\$\{start\}`:null/.test(backend),
    "每个双图并发批次必须有独立 batchId，单图仍走原有单任务状态查询");
  assert.ok(/request\?\.signal,batchId\)/.test(backend),
    "同批图片必须把同一个 batchId 传入 OCR 适配层");
  assert.ok(/ocrStatusBatchRequestCount/.test(backend)&&/ocrStatusFallbackRequestCount/.test(backend),
    "诊断必须区分真实批量状态请求与单任务回退请求");
  assert.ok(/ocrImageTimings:results\.map/.test(backend),
    "诊断必须保留每张图片独立的提交、状态与结果读取耗时");
  console.log("✅ 后端多图分批并发");
}

// 2) 后端：失败处理仍然完整（不能因为并发吞掉可恢复动作）
{
  assert.ok(/const failed=settled\.find\(x=>x\.status==="rejected"\)/.test(backend), "必须检出批内失败");
  assert.ok(/PROCESS_CANCELLED/.test(backend) && /failProcess\(ocrCode/.test(backend),
    "取消与 OCR 失败必须保留原有错误码/可恢复动作");
  console.log("✅ 并发下错误处理完整");
}

// 3) 前端：上传前压缩，且任何异常都回退原图
{
  assert.ok(/async function compressImageForUpload/.test(frontend), "应存在上传前压缩函数");
  assert.ok(/maxSide=1600/.test(frontend) && /quality=0\.82/.test(frontend),
    "压缩参数应为长边 1600 / 质量 0.82（文字仍清晰，体积显著下降）");
  assert.ok(/blob\.size>=file\.size\)return file/.test(frontend),
    "压完不比原图小应回退原图");
  assert.ok(/\}catch\{return file\}/.test(frontend),
    "解码失败（HEIC 等）必须回退原图，不得阻断上传");
  assert.ok(/prepared\.forEach\(file=>fd\.append\("file",file\)\)/.test(frontend),
    "FormData 必须使用压缩后的文件");
  console.log("✅ 前端压缩与安全回退");
}

// 4) 前端：非图片（PDF）不得被压缩
{
  assert.ok(/\/\^image\\\//.test(frontend) || /test\(file\.type/.test(frontend),
    "仅图片参与压缩，PDF 等原样上传");
  console.log("✅ 非图片原样上传");
}

const diagnostics = readFileSync(new URL("../js/admin/diagnostics.js", import.meta.url), "utf8");
assert.ok(/批量状态请求/.test(diagnostics)&&/单任务回退请求/.test(diagnostics), "管理员诊断必须展示批量请求与回退请求次数");
assert.ok(/逐图OCR耗时/.test(diagnostics), "管理员复制诊断必须展示逐图 OCR 耗时");
console.log("\n✅ upload-speed 全部通过");

const r2StageBlock=backend.slice(backend.indexOf("const TEMP_STAGE_CONCURRENCY"),backend.indexOf("const ocrStarted"));
assert.ok(/const TEMP_STAGE_CONCURRENCY=files.length>1\\?2:1/.test(r2StageBlock), "R2 暂存并发仍必须保持 2 张上限");
assert.ok(!/const batchId/.test(r2StageBlock), "batchId 只能在 OCR 并发批次作用域创建，不能误放在 R2 暂存循环");
const ocrBatchStart=backend.indexOf("const CONCURRENCY=files.length>1?4:1");
const ocrBatchEnd=backend.indexOf("const failed=settled.find",ocrBatchStart);
assert.ok(ocrBatchStart>=0&&ocrBatchEnd>ocrBatchStart, "OCR 并发批次边界必须存在");
assert.match(backend.slice(ocrBatchStart,ocrBatchEnd), /const batchId=batch\.length>1\?\x60zp-\$\{requestId\}-\$\{start\}\x60:null/,
  "batchId 必须在 OCR 并发批次内部声明，保证两个识别任务共享且不跨批次");
