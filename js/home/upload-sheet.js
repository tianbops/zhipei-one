/* home/upload-sheet.js —— 上传弹窗开合与交互绑定（首页按钮 toggle / 取消 / 重试 / 遮罩点击）
   依赖 core、upload-error、upload-process 的运行期状态（处理中保护）。 */
function closeUpload(){
  if(processingFile)return;
  if(overlay){overlay.hidden=true;overlay.setAttribute("aria-hidden","true");document.body.classList.remove("sheet-open");resetProcessingUI()}
}
function openUpload(){
  if(overlay){resetProcessingUI();overlay.hidden=false;overlay.setAttribute("aria-hidden","false");document.body.classList.add("sheet-open")}
}
/* ===== 粘贴文本录入（2026-10-26）：来源菜单第 4 项，切换文本面板 =====
   文本提交后走 processPastedText → 后端 rawText 直录管线（跳过 OCR）。
   失败可重试（RESUBMIT）时回到文本面板，已输入文字保留，改完直接重试。 */
const textPanel=$("uploadTextPanel"),waybillTextInput=$("waybillTextInput"),
      textCharCount=$("textCharCount"),pasteFromClipboardBtn=$("pasteFromClipboard"),
      textPanelBackBtn=$("textPanelBack"),textPanelSubmitBtn=$("textPanelSubmit");
function showTextPanel(){
  if(!textPanel||!sourceMenu)return;
  sourceMenu.hidden=true;textPanel.hidden=false;
  if(waybillTextInput)waybillTextInput.focus();
}
function backToSourceMenu(){
  if(!textPanel||!sourceMenu)return;
  textPanel.hidden=true;sourceMenu.hidden=false;
}
if(waybillTextInput&&textCharCount){
  const refreshCount=()=>{textCharCount.textContent=waybillTextInput.value.length+" 字"};
  waybillTextInput.addEventListener("input",refreshCount);refreshCount();
}
if(pasteFromClipboardBtn&&waybillTextInput){
  pasteFromClipboardBtn.addEventListener("click",async()=>{
    // 读剪贴板需要授权：拒绝或不支持时降级为聚焦输入框，由用户长按手动粘贴
    try{
      if(!navigator.clipboard||!navigator.clipboard.readText)throw new Error("unsupported");
      const text=await navigator.clipboard.readText();
      if(!text){try{window.zpToast?.("剪贴板是空的","info")}catch{}return}
      const start=waybillTextInput.selectionStart??waybillTextInput.value.length,end=waybillTextInput.selectionEnd??start;
      waybillTextInput.setRangeText(text,start,end,"end");
      waybillTextInput.dispatchEvent(new Event("input"));
      waybillTextInput.focus();
    }catch{
      try{window.zpToast?.("请在输入框长按粘贴","info")}catch{}
      waybillTextInput?.focus();
    }
  });
}
if(textPanelBackBtn)textPanelBackBtn.addEventListener("click",backToSourceMenu);
// 来源菜单第 4 项「粘贴文本」：upload-process.js 的 chooseFile 对 text 直接跳过（无文件控件），
// 面板切换在这里接管（upload-process.js 先于本文件绑定 click，text 来源在彼处为 no-op）
document.querySelectorAll('.source-option[data-source="text"]').forEach(btn=>btn.addEventListener("click",showTextPanel));
if(textPanelSubmitBtn&&waybillTextInput)textPanelSubmitBtn.addEventListener("click",()=>{
  if(processingFile)return;
  processPastedText(waybillTextInput.value);
});
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
    // 需重新提供内容：文本失败回文本面板（已输入文字保留），文件失败回来源菜单重选
    openUpload();
    if(lastFailureSource==="text")setTimeout(showTextPanel,0);
  }else{
    // 不可重试（含非 recoverable）：按钮作关闭用
    closeUpload();
  }
});
overlay?.addEventListener("click",e=>{if(e.target===overlay)closeUpload()});