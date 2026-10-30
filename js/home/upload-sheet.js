/* home/upload-sheet.js —— 上传弹窗开合与交互绑定（首页按钮 toggle / 取消 / 重试 / 遮罩点击）
   依赖 core、upload-error、upload-process 的运行期状态（处理中保护）。 */
function closeUpload(){
  if(processingFile)return;
  if(overlay){overlay.hidden=true;overlay.setAttribute("aria-hidden","true");document.body.classList.remove("sheet-open");resetProcessingUI()}
  // 焦点归还触发按钮：弹层是 aria-modal，关闭后焦点必须回到原处，
  // 否则键盘用户会掉回文档开头（焦点陷阱只管层内，不管层外归还）。
  try{const trig=$("uploadAction");if(trig&&typeof trig.focus==="function")trig.focus()}catch(_){}
}
function openUpload(){
  if(overlay){resetProcessingUI();overlay.hidden=false;overlay.setAttribute("aria-hidden","false");document.body.classList.add("sheet-open")}
  // 焦点入层：落在层内第一个可聚焦元素上（按钮而非输入框，不会误弹输入法）。
  try{
    const UI=window.__zpUi;
    const sheet=overlay&&overlay.querySelector(".upload-sheet");
    const list=UI&&UI.focusables?UI.focusables(sheet):[];
    if(list&&list.length)list[0].focus();
  }catch(_){}
}
/* ===== 粘贴文本录入（2026-10-26）：来源菜单第 4 项，切换文本面板 =====
   文本提交后走 processPastedText → 后端 rawText 直录管线（跳过 OCR）。
   失败可重试（RESUBMIT）时回到文本面板，已输入文字保留，改完直接重试。 */
const textPanel=$("uploadTextPanel"),waybillTextInput=$("waybillTextInput"),
      textCharCount=$("textCharCount"),pasteFromClipboardBtn=$("pasteFromClipboard"),
      clearTextBtn=$("clearWaybillText"),
      textPanelBackBtn=$("textPanelBack"),textPanelSubmitBtn=$("textPanelSubmit");
function showTextPanel(){
  if(!textPanel||!sourceMenu)return;
  sourceMenu.hidden=true;textPanel.hidden=false;
  // 打开面板不自动聚焦：本面板以「一键粘贴」为主操作，避免未点粘贴就先弹出输入法；
  // 需要手动输入时用户点一下文本框，键盘自然弹出。
}
function backToSourceMenu(){
  if(!textPanel||!sourceMenu)return;
  textPanel.hidden=true;sourceMenu.hidden=false;
}
if(waybillTextInput&&textCharCount){
  const refreshCount=()=>{
    const n=waybillTextInput.value.length;
    textCharCount.textContent=n+" 字";
    // 「清空」仅在有内容时出现：空面板不放无效按钮
    if(clearTextBtn)clearTextBtn.hidden=n===0;
  };
  waybillTextInput.addEventListener("input",refreshCount);refreshCount();
}
/* 清空已输入文字（误贴/贴错时用）：清空后聚焦输入框，方便重新粘贴 */
if(clearTextBtn&&waybillTextInput){
  clearTextBtn.addEventListener("click",()=>{
    if(!waybillTextInput.value)return;
    waybillTextInput.value="";
    waybillTextInput.dispatchEvent(new Event("input"));
    waybillTextInput.focus();
    if(window.zpToast)window.zpToast("已清空","success");
  });
}
/* 在光标处插入文本（保留选择区，等价于用户手动粘贴的落点） */
function insertWaybillText(text){
  const start=waybillTextInput.selectionStart??waybillTextInput.value.length,end=waybillTextInput.selectionEnd??start;
  waybillTextInput.setRangeText(text,start,end,"end");
  waybillTextInput.dispatchEvent(new Event("input"));
}
/* 降级路径：借原生粘贴，把剪贴板内容直接粘进真实输入框（等价于用户手动粘贴）。
   微信/安卓 WebView、Firefox 常可用此路，而 navigator.clipboard.readText 反而缺失；
   被浏览器策略拦截时返回 false（什么都不做），交由调用方提示长按手动粘贴。 */
function tryExecCommandPaste(){
  return new Promise((resolve)=>{
    const before=waybillTextInput.value;
    let pasted=false;
    const onPaste=()=>{pasted=true};
    waybillTextInput.addEventListener("paste",onPaste);
    waybillTextInput.focus();
    let ok=false;try{ok=document.execCommand("paste")}catch(e){}
    setTimeout(()=>{
      waybillTextInput.removeEventListener("paste",onPaste);
      resolve(!!(ok&&(pasted||waybillTextInput.value!==before)));
    },60);
  });
}
if(pasteFromClipboardBtn&&waybillTextInput){
  pasteFromClipboardBtn.addEventListener("click",async()=>{
    const original=pasteFromClipboardBtn.textContent;
    pasteFromClipboardBtn.disabled=true;pasteFromClipboardBtn.textContent="读取中…";
    try{
      // 0) 首选原生壳桥接（App 内）：壳直接读系统剪贴板，是国产 WebView /
      //    系统内置浏览器里唯一稳定的通道（navigator.clipboard 在那里常被拒）。
      //    三态约定（与壳 MainActivity.getClipboardText 对齐）：
      //      非空字符串 = 剪贴板文本 → 直接粘入；
      //      ""         = 剪贴板里没有文字（空剪贴板/复制的是图片等）→ 权威结论，不降级；
      //      null/无桥 = 读取失败或不在 App 内 → 继续走下面的 Web 链路。
      let nativeText=null,nativeChecked=false;
      try{
        const nat=window.ZhipeiNative;
        if(nat&&typeof nat.getClipboardText==="function"){
          nativeChecked=true;
          nativeText=nat.getClipboardText();
        }
      }catch(e){nativeText=null}
      if(nativeChecked&&typeof nativeText==="string"){
        if(nativeText){insertWaybillText(nativeText);return}
        try{window.zpToast?.("剪贴板里没有文字","info")}catch{}
        return;
      }
      // 1) 异步 Clipboard API（桌面 Chrome/Edge、已授权 WebView 可直接读到）
      if(navigator.clipboard&&navigator.clipboard.readText){
        try{
          const text=await navigator.clipboard.readText();
          if(!text){try{window.zpToast?.("剪贴板是空的","info")}catch{}return}
          insertWaybillText(text); // 成功即粘入，不再强制聚焦（避免无谓弹出输入法）
          return;
        }catch(e){/* 权限拒绝/页面未聚焦 → 继续降级 */}
      }
      // 2) 降级：execCommand 原生粘贴到真实输入框
      if(await tryExecCommandPaste()){waybillTextInput.dispatchEvent(new Event("input"));return}
      // 3) 环境无法程序化读取剪贴板：明确提示 + 聚焦，方便用户长按粘贴
      try{window.zpToast?.("未能读取剪贴板，请长按下方输入框粘贴","info")}catch{}
      waybillTextInput.focus();
    }catch{
      try{window.zpToast?.("粘贴失败，请长按下方输入框粘贴","info")}catch{}
      waybillTextInput.focus();
    }finally{
      pasteFromClipboardBtn.disabled=false;pasteFromClipboardBtn.textContent=original;
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
if(new URLSearchParams(location.search).get("openUpload")==="1"){
  // 底栏「上传」是 <a href="/home?openUpload=1">，站内导航走 replace，于是首页会以
  // 带参数的地址重新加载一次。打开面板后立刻把参数抹掉（replaceState 不增删记录）：
  // 否则用户之后按返回又会落回带参数的地址、面板第二次弹出，看起来像「返回没生效」。
  try{const u=new URL(location.href);u.searchParams.delete("openUpload");history.replaceState(history.state,"",u.pathname+u.search)}catch{}
  setTimeout(openUpload,0);
}
cancel?.addEventListener("click",closeUpload);
// 处理中不再提供「取消处理」：处理一旦发出写请求就不可中断。
// 返回键同样被 js/ui/back.js 的忙碌守卫拦下并提示，处理结束前不关闭弹层。
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