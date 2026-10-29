import {json} from "./_json.js";

// 兜底 404：未命中任何 Functions 的 /api/* 请求，默认会落到静态资源的 SPA fallback，
// 返回 200 + index.html。客户端拿到 HTML 再去 JSON.parse，只会得到
// "Unexpected token '<'"，既看不出是端点被删还是路径写错，也会把 404 伪装成成功。
// 本 catch-all 让未知/已删除端点明确返回 404 JSON。
// 注意：Pages Functions 的精确路由优先于 [[path]] 通配，不会遮挡任何已有端点
// （tests/api-404.test.mjs 对此有断言）。
export async function onRequest(){
  return json({success:false,code:"API_NOT_FOUND",error:"接口不存在"},404);
}
