/**
 * 智配One · 运单处理 —— OCR 文本解析
 * ----------------------------------------------------------
 * 本文件由 process.js 按职责拆分而来（P1-1g，零改写）。
 * 输入：OCR 原文；输出：标准化条目（rawName/storeId/权重数量…）。
 * 解析规则（门店行识别、表头过滤、罗马数字序号、重量汇总行）保持原语义。
 */

import {clean} from "./_store-match.js";
import {number} from "./_process-common.js";

export function extract(rawText){
  const stores=[]; let date=null,vehicle=null,totalWeight=null,driver=null,deliveryPerson=null;
  // 多截图属于同一张运单。截图来源标记只用于诊断，不得进入门店提取文本。
  const normalizedInput=String(rawText||"").replace(/【第\d+张截图】/g,"\n");
  const lines=clean(normalizedInput).split(/\r?\n+/).map(x=>x.trim()).filter(Boolean).slice(0,5000);
  const full=lines.join(" ");
  const dm=full.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  if(dm){const p=dm[1].replace(/[年月/.]/g,"-").replace(/日$/,"").split("-").map(x=>x.padStart(2,"0"));if(p.length===3)date=p.join("-")}
  // OCR 常会把车牌省份简称、字母和数字之间拆成空格，因此车辆提取不能要求字符连续。
  // 先按车辆字段提取，再对整段文本做通用车牌兜底；只做格式兼容，不做具体车辆硬编码。
  const vehiclePattern=/(?:车牌号?|车牌|车辆|车号)\s*[:：]?\s*([\u4e00-\u9fa5])\s*([A-Z])\s*([A-Z0-9](?:\s*[A-Z0-9]){4,7})/i;
  let vm=full.match(vehiclePattern);
  if(vm){
    vehicle=(vm[1]+vm[2]+vm[3]).replace(/\s+/g,"").toUpperCase();
  }else{
    const fallback=full.match(/(^|[^\u4e00-\u9fa5A-Z0-9])([\u4e00-\u9fa5])\s*([A-Z])\s*([A-Z0-9](?:\s*[A-Z0-9]){4,7})(?=$|[^A-Z0-9])/i);
    if(fallback)vehicle=(fallback[2]+fallback[3]+fallback[4]).replace(/\s+/g,"").toUpperCase();
  }
  // 司机/送货员属于运单抬头字段，单独提取并保存；兼容标签和值分行、多个字段同行。
  const personLabels=["主司机","司机姓名","驾驶员","司机","送货员","送货人","配送员"];
  const extractPerson=labels=>{
    const pattern=/(主司机|司机姓名|驾驶员|司机|送货员|送货人|配送员)\s*[:：]?\s*([^\s,，;；|]+)/g;
    let match;
    while((match=pattern.exec(full))){
      if(!labels.includes(match[1]))continue;
      const value=String(match[2]||"").replace(/^[：:，,;；|]+|[：:，,;；|]+$/g,"").trim();
      if(!value||personLabels.includes(value)||/^(?:姓名|名称|无|暂无|未知|—|-)$/.test(value))continue;
      if(value.length>20||/^(?:运单列表|订单列表|车牌号?|车辆|车号|送货员|送货人|配送员|主司机|司机|驾驶员)$/.test(value))continue;
      return value;
    }
    return null;
  };
  driver=extractPerson(["主司机","司机姓名","驾驶员","司机"]);
  deliveryPerson=extractPerson(["送货员","送货人","配送员"]);
  const wm=full.match(/(?:总重量|重量)\s*[:：]?\s*([\d.]+)\s*(?:吨|t|T)?/);
  if(wm)totalWeight=number(wm[1]);

  const waybillTail=/ZW\d{8}[A-Z0-9]+/ig;
  const cleanStoreName=value=>clean(value)
    .replace(/^[\s|>→]+|[\s|>→]+$/g,"")
    .replace(/^[-:：]+/,"")
    .replace(waybillTail,"")
    .trim();

  const addRouteText=text=>{
    const hasWaybillCode=/\bZW\d{8}[A-Z0-9]+\b/i.test(text);
    const parts=clean(text).split(/\s*(?:-\s*>|→|＞)\s*/).map(cleanStoreName).filter(Boolean);
    for(let partIndex=0;partIndex<parts.length;partIndex++){
      let part=parts[partIndex];
      if(hasWaybillCode&&partIndex===parts.length-1){
        part=part.replace(/\s+\d{5,}(?:\s+\d{5,})*\s*$/g,"").trim();
      }
      const idm=part.match(/\b(?:JM|A|Q)[\p{Pd}_ ]?\d{3,12}\b/i);
      const storeId=idm?idm[0].replace(/[\p{Pd} ]/gu,"").toUpperCase():null;
      const rawName=cleanStoreName(part);
      const name=cleanStoreName(part.replace(/\b(?:JM|A|Q)[\p{Pd}_ ]?\d{3,12}\b/i,""));
      if(name.length>=2&&/[\u4e00-\u9fa5A-Za-z]/.test(name))stores.push({rawName, name, sourceLine:text, storeId});
    }
  };

  const firstArrow=full.search(/\s*(?:->|→|＞)\s*/);
  if(firstArrow>=0){
    let routeText=full;
    const percentMatches=[...full.matchAll(/\(?\s*\d+(?:\.\d+)?\s*%\s*\)?/g)];
    if(percentMatches.length){
      const last=percentMatches[percentMatches.length-1];
      if(last.index<firstArrow)routeText=full.slice(last.index+last[0].length);
    }
    addRouteText(routeText);
  }else{
    for(const line of lines){
      if(/^(?:运单列表|订单列表|运输日期|日期|时间|车牌号?|车辆|车号|额定装载|额定载重|额定体积|主司机|司机|送货员|承运订单|总重量|总数量|数量|件数|总体积)/i.test(line))continue;
      const cleaned=line.replace(/(?:运单列表订单列表|承运订单.*?)(?=[\u4e00-\u9fa5])/g,"").trim();
      if(cleaned) addRouteText(cleaned);
    }
  }
  return {date,vehicle,totalWeight,driver,deliveryPerson,stores};
}

