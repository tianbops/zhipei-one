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
      // OCR 抬头常带装饰性尖括号/箭头（如「司机：田波>」「送货员 陈兴亚 >」），
      // 姓名只取人名本体：首尾剥离 ：,;| 与 > › » ＞ 〉 》 → 类噪声（2026-10-22 用户报障）
      const value=String(match[2]||"").replace(/^[：:，,;；|>›»＞〉》→]+|[：:，,;；|>›»＞〉》→]+$/g,"").trim();
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

  /* 噪声词表：运单截图末尾常有「运单号 01897 01898 …」这类表格，末尾数字已被
     hasWaybillCode 分支清掉，但残留的表头文字（如「运单号」）会被当成门店名。
     判定保守：仅在清除数字与空白后与噪声词【完全相等】时才剔除，绝不前缀/包含匹配，
     避免误伤真实门店名（如含「车」字的店名）。 */
  const NOISE_WORDS=new Set([
    "运单号","运单列表","订单列表","运输日期","承运订单","总数量","总重量","总体积",
    "额定载重","额定装载","额定体积","主司机","司机","送货员","车牌号","车牌",
    "车辆","车号","日期","时间","数量","件数","合计","小计","序号","备注"
  ]);

  /* 截图 UI 噪声清洗：手机截图会带状态栏（06:05 / 5G / 85）、导航栏（< X 运单列表）、
     底部导航（首页/历史/线路/我的）。OCR 会把这些和门店名连成一条（实测
     「06:05 5G85 < X 运单列表 江北区鸿恩寺客服中心（2026）」→ 无候选、卡待定）。
     只剥离**开头**的噪声 token，遇到第一个正常字符即停止；对真实门店名零影响
     （如 24h 开头不会被误删：要求 2-3 位数字后必须是空白或结尾）。 */
  const stripUiNoise=s=>{
    let t=String(s||"");
    for(let i=0;i<8;i++){
      const before=t;
      t=t.replace(/^\s*(?:\d{1,2}:\d{2}|5G|4G|LTE|WiFi|\d{2,3}(?=\s|$)|[<>×✕✖X]|运单列表|订单列表|首页|历史|线路|我的|返回|关闭|更多|[\s·•|])+/i,"").trim();
      if(t===before)break;
    }
    return t;
  };

  const addRouteText=text=>{
    const hasWaybillCode=/\bZW\d{8}[A-Z0-9]+\b/i.test(text);
    const parts=clean(text).split(/\s*(?:-\s*>|→|＞)\s*/).map(cleanStoreName).filter(Boolean);
    for(let partIndex=0;partIndex<parts.length;partIndex++){
      let part=parts[partIndex];
      if(hasWaybillCode&&partIndex===parts.length-1){
        // 运单号表格（无箭头，紧跟在最后一家门店之后）：先整块截掉表头词及其后内容，
        // 再清残留数字串。否则「最后一家门店 + 运单号」会粘成一条脏门店名。
        const tailIdx=part.search(/运单号|运单列表|订单列表/);
        if(tailIdx>0)part=part.slice(0,tailIdx).trim();
        else if(tailIdx===0)part="";
        part=part.replace(/\s+\d{5,}(?:\s+\d{5,})*\s*$/g,"").trim();
      }
      /* 表头块清洗：多张截图内容重复粘贴时，表头可能夹在门店之间（例如
         「A店 运单列表 运输日期 … 总数量129|…(7.52%) B店」），只在开头截一次处理不到，
         会把表头与两侧门店粘成一条超长脏名（进而在匹配阶段与其他条目身份冲突、卡待定）。
         此处把**每一处**表头块替换为换行，再按换行拆成多个门店候选，逐个走原有识别逻辑。 */
      const noHeader=String(part).replace(/(?:运单列表|订单列表|运输日期)[\s\S]*\(\s*\d+(?:\.\d+)?\s*%\s*\)/g,"\n");
      const segments=noHeader.split(/\r?\n+/).map(x=>x.trim()).filter(Boolean);
      for(const rawSeg of (segments.length?segments:[part])){
        const seg=stripUiNoise(rawSeg);
        if(!seg)continue;
        const idm=seg.match(/\b(?:JM|A|Q)[\p{Pd}_ ]?\d{3,12}\b/i);
        const storeId=idm?idm[0].replace(/[\p{Pd} ]/gu,"").toUpperCase():null;
        const rawName=cleanStoreName(seg);
        const name=cleanStoreName(seg.replace(/\b(?:JM|A|Q)[\p{Pd}_ ]?\d{3,12}\b/i,""));
        // 噪声剔除：清掉数字与空白后若正好是表头词（如运单号表格残留），不作为门店
        const noiseKey=clean(name).replace(/[\d\s]+/g,"");
        if(NOISE_WORDS.has(noiseKey))continue;
        if(name.length>=2&&/[\u4e00-\u9fa5A-Za-z]/.test(name))stores.push({rawName, name, sourceLine:text, storeId});
      }
    }
  };

  const firstArrow=full.search(/\s*(?:->|→|＞)\s*/);
  if(firstArrow>=0){
    let routeText=full;
    const percentMatches=[...full.matchAll(/\(?\s*\d+(?:\.\d+)?\s*%\s*\)?/g)];
    if(percentMatches.length){
      // 只认「第一个箭头之前」的最后一个百分比：重复粘贴时会存在后段的百分比，
      // 若取全局最后一个会出现 last.index > firstArrow，导致表头截断失效。
      const before=percentMatches.filter(m=>m.index<firstArrow);
      const last=before[before.length-1];
      if(last)routeText=full.slice(last.index+last[0].length);
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

