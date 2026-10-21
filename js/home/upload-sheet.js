/* home/upload-sheet.js —— 上传弹窗开合与交互绑定（首页按钮 toggle / 取消 / 重试 / 遮罩点击）
   依赖 core、upload-error、upload-process 的运行期状态（处理中保护）。 */
function closeUpload(){
  if(processingFile)return;
  if(overlay){overlay.hidden=true;overlay.setAttribute("aria-hidden","true");document.body.classList.remove("sheet-open");resetProcessingUI()}
}
function openUpload(){
  if(overlay){resetProcessingUI();overlay.hidden=false;overlay.setAttribute("aria-hidden","false");document.body.classList.add("sheet-open")}
}
// 首页上传按钮 toggle（以首页为标准点）：第一次点击打开上传弹窗，
// 弹窗已开时再点即关闭（回到首页标准态）。closeUpload 自带处理中保护。
$("uploadAction")?.addEventListener("click",()=>{if(overlay&&!overlay.hidden)closeUpload();else openUpload()});
if(new URLSearchParams(location.search).get("openUpload")==="1")setTimeout(openUpload,0);
cancel?.addEventListener("click",closeUpload);
// 处理中的唯一退出方式：处理期间取消按钮被隐藏，等待超过 8 秒后才给出出口，
// 既保留处理锁（防重复提交、防误触关闭），又不把用户永久锁在弹窗里。
processingCancelBtn?.addEventListener("click",()=>{
  if(!processingFile||!processingController)return;
  processingCancelled=true;
  processingCancelBtn.disabled=true;
  try{processingController.abort()}catch{}
});
processingRetry?.addEventListener("click",()=>{
  if(processingFile)return;   // 处理中禁止重复触发
  const info=retryActionInfo(lastFailureAction);
  if(lastFailureAction==="RETRY_SAVE"&&lastFailureRequestId){
    // 仅重保存：复用已构建的运单数据，不保留或重新上传原图。
    processSelectedFiles([], lastFailureRequestId);
  }else if(info&&info.autoRetry){
    // 重新识别必须重新选择图片；不在失败状态长期保留原图引用。
    openUpload();
  }else if(info&&lastFailureAction==="RESUBMIT"){
    // 需重新选文件：回到来源菜单
    openUpload();
  }else{
    // 不可重试（含非 recoverable）：按钮作关闭用
    closeUpload();
  }
});
overlay?.addEventListener("click",e=>{if(e.target===overlay)closeUpload()});