/**
 * 智配 One · 免费本地 OCR 安全边界
 *
 * 图片识别已移至浏览器端的开源 Tesseract.js。
 * 此适配层保留为防护性兜底：禁止服务端悄悄调用外部 OCR 服务或消耗付费额度。
 */
export async function recognizeImage() {
  const error = new Error("请使用浏览器免费本地识别后再提交文字");
  error.code = "OCR_CLIENT_REQUIRED";
  throw error;
}
export default { recognizeImage };
