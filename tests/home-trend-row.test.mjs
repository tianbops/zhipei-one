/** 首页趋势统计：三项摘要固定单行，页面不再输出峰值提示。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const ROOT=fileURLToPath(new URL("..",import.meta.url));
const read=p=>readFileSync(join(ROOT,p),"utf8");
const css=read("css/home-trend.css");
const js=read("js/home-monthly.js");
const html=read("home.html");
const strip=s=>s.replace(/\/\*[\s\S]*?\*\//g,"");
const has=(name,ok)=>{if(!ok){console.error("❌ "+name);process.exitCode=1}else console.log("✅ "+name)};
has("汇总区使用三等分网格",/\.trend-summary\{[^}]*display:grid[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)/.test(strip(css)));
has("三项数字保持单行",/\.trend-stat\{[^}]*white-space:nowrap/.test(strip(css)));
has("不再显示同比附加数字",/\.trend-delta\{display:none\}/.test(strip(css)));
has("JS 不再生成峰值或点击日期提示",!js.includes("trendHint")&&!js.includes("hint.innerHTML")&&!js.includes("年度峰值"));
has("首页 DOM 不再保留提示占位",!html.includes("trendHint")&&!html.includes("trend-hint"));
has("单/家/t 三项汇总节点完整",["trendWaybills","trendStores","trendWeight"].every(id=>html.includes('id="'+id+'"')));
