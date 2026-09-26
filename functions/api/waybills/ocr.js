const API_BASE="https://paddleocr.aistudio-app.com";
const JOB_PATH="/api/v2/ocr/jobs";
const MODEL="PP-OCRv6";
const clean=v=>String(v??"").trim();

function fail(code,message,extra={}){const e=new Error(message);e.code=code;Object.assign(e,extra);return e}

function collectText(value,out=[]){
  if(!value)return out;
  if(Array.isArray(value)){for(const x of value)collectText(x,out);return out}
  if(typeof value!=="object")return out;
  for(const key of ["rec_texts","recTexts","texts","text"]){
    const v=value[key];
    if(Array.isArray(v))for(const x of v)if(clean(x))out.push(clean(x));
    else if(typeof v==="string"&&clean(v))out.push(clean(v));
  }
  for(const key of ["ocrResults","ocr_results","prunedResult","pruned_result","result","pages"]){if(value[key])collectText(value[key],out)}
  return out;
}

async function requestJson(url,init){
  const r=await fetch(url,init);const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{throw fail("OCR_BAD_RESPONSE","OCR服务返回格式异常")}
  if(!r.ok)throw fail(r.status===401||r.status===403?"OCR_AUTH":"OCR_API","OCR服务请求失败",{status:r.status,detail:data?.msg||data?.message||""});
  return data;
}

export async function recognizeImage(env,file){
  const token=clean(env?.PADDLEOCR_ACCESS_TOKEN);if(!token)throw fail("OCR_NOT_CONFIGURED","OCR服务尚未配置");
  const base=clean(env?.PADDLEOCR_BASE_URL)||API_BASE;
  const form=new FormData();form.append("model",MODEL);form.append("optionalPayload",JSON.stringify({useDocOrientationClassify:false,useDocUnwarping:false,useTextlineOrientation:false}));
  form.append("file",file,file.name||"waybill");
  const submitted=await requestJson(base+JOB_PATH,{method:"POST",headers:{Authorization:"Bearer "+token,"Accept":"application/json"},body:form});
  const jobId=clean(submitted?.data?.jobId);if(!jobId)throw fail("OCR_SUBMIT_FAILED","OCR任务提交失败");
  const deadline=Date.now()+25000;let delay=2000;
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,delay));
    const status=await requestJson(base+JOB_PATH+"/"+encodeURIComponent(jobId),{headers:{Authorization:"Bearer "+token,"Accept":"application/json"}});
    const data=status?.data||{};const state=clean(data.state||data.status).toLowerCase();
    if(state==="failed"||state==="error")throw fail("OCR_JOB_FAILED",data.errorMsg||data.msg||"OCR识别失败",{jobId});
    if(state==="done"||state==="completed"||data.resultUrl?.jsonUrl){
      const url=clean(data.resultUrl?.jsonUrl);if(!url)throw fail("OCR_RESULT_MISSING","OCR结果地址缺失",{jobId});
      const rr=await fetch(url);if(!rr.ok)throw fail("OCR_RESULT_FETCH","OCR结果读取失败",{jobId});
      const raw=await rr.text();const texts=[];
      for(const line of raw.split(/\r?\n/)){if(!line.trim())continue;try{collectText(JSON.parse(line),texts)}catch{}}
      const unique=[...new Set(texts)].filter(Boolean);if(!unique.length)throw fail("OCR_EMPTY","OCR未识别到文字",{jobId});
      return {jobId,model:MODEL,rawText:unique.join("\n"),lineCount:unique.length};
    }
    delay=Math.min(5000,Math.round(delay*1.35));
  }
  throw fail("OCR_TIMEOUT","OCR识别超时，请稍后重试",{jobId});
}
