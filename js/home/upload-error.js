/* home/upload-error.js —— 失败信封 → 重试动作映射，错误面板与处理面板切换
   依赖 core、upload-progress。
   注意：[RETRY-MAP-START]..[RETRY-MAP-END] 切片被 tests/unit-retry-action.test.mjs 直接读取，勿改锚点。 */
/* ===== 处理失败 → 重试动作映射（纯函数，tests/unit-retry-action.test.mjs 切片验证） =====
   与后端 process.js 的 failProcess 信封对齐：recoverable && action 才允许前端重试。
   - autoRetry=true 且复用同一文件：RETRY_OCR / RETRY_SAVE / REPROCESS（点按钮即重跑同一文件）
   - autoRetry=false：RESUBMIT 需重新选文件（回来源菜单）、RETRY_LATER 仅提示稍后（按钮作关闭用） */
/* [RETRY-MAP-START] */
const RETRY_ACTION_INFO={
  RETRY_OCR:{label:"重新识别",autoRetry:true},
  RETRY_SAVE:{label:"重试保存",autoRetry:true},
  REPROCESS:{label:"重新处理",autoRetry:true},
  RESUBMIT:{label:"重新上传",autoRetry:false},
  RETRY_LATER:{label:"请稍后重试",autoRetry:false}
};
function retryActionInfo(action){
  if(!action||!RETRY_ACTION_INFO[action])return null;
  return RETRY_ACTION_INFO[action];
}
/* [RETRY-MAP-END] */
const PROCESS_ERROR_TEXT={
  OCR_RESULT_TIMEOUT:"OCR结果读取超时（已自动重试仍失败），请重新上传重试",
  OCR_TIMEOUT:"OCR识别超时，请稍后重试",
  OCR_NETWORK_TIMEOUT:"OCR服务响应超时，请稍后重试",
  OCR_JOB_FAILED:"OCR识别失败，请上传更清晰的运单照片",
  OCR_EMPTY:"OCR未识别到文字，请上传更清晰的运单照片",
  OCR_NOT_CONFIGURED:"OCR服务尚未配置，请联系管理员",
  OCR_AUTH:"OCR服务鉴权失败，请联系管理员",
  OCR_ENDPOINT:"OCR服务地址异常，请联系管理员",
  OCR_API:"OCR服务暂时不可用，请稍后重试",
  OCR_BAD_RESPONSE:"OCR服务返回异常，请稍后重试",
  OCR_SUBMIT_FAILED:"OCR任务提交失败，请稍后重试",
  OCR_RESULT_MISSING:"OCR结果地址缺失，请重试",
  OCR_RESULT_FETCH:"OCR结果读取失败，请重试",
  PROCESS_CLIENT_TIMEOUT:"处理超时（60秒），请稍后重试或换更清晰的运单图片",
  PROCESS_STREAM_INTERRUPTED:"处理连接中断，请重试",
  EXTRACT_EMPTY:"未从运单中提取到门店，请检查运单内容",
  DISPATCH_ROUTE_MISSING:"请先在首页选择调度线路",
  WAYBILL_FILE_MISSING:"请选择运单文件"
};
function showProcessingError(message, hint, action, recoverable, requestId){
  stopProcessingClock();
  if(processingCancelBtn){processingCancelBtn.hidden=true;processingCancelBtn.disabled=false;}
  if(processingPanel)processingPanel.hidden=true;
  if(sourceMenu)sourceMenu.hidden=true;
  if(overlay)overlay.classList.add("processing-error-state");
  const text=PROCESS_ERROR_TEXT[message]||message||"处理失败，请重试";
  if(processingErrorMessage)processingErrorMessage.textContent=text+(hint?(" "+hint+" "):"");
  // 仅当后端声明可恢复且给出了动作时，按钮才是「一键重试」；否则隐藏为关闭按钮
  lastFailureAction=(recoverable&&action)?action:null;
  lastFailureRequestId=(recoverable&&action)?(requestId||null):null;
  if(processingRetry)processingRetry.textContent=retryActionInfo(lastFailureAction)?.label||"关闭";
  if(processingError)processingError.hidden=false;
}
function showProcessingUI(){
  if(!processingPanel||!sourceMenu)return;
  if(overlay)overlay.classList.remove("processing-error-state");
  if(processingError)processingError.hidden=true;
  sourceMenu.hidden=true;processingPanel.hidden=false;
  processingCancelled=false;
  if(processingCancelBtn){processingCancelBtn.hidden=true;processingCancelBtn.disabled=false;}
  setProcessingStage(STAGE_DEFAULT);
  if(processingElapsedEl)processingElapsedEl.textContent="已用时 0s";
  resetProcessingProgress();
  startProcessingClock();
  refreshProcessingClock();
}