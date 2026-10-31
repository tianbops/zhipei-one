import { json } from "./_json.js";
import { currentUser } from "./_auth.js";
import { pipeline } from "./_redis.js";
import { guard } from "./_safe.js";
import { beijingISO } from "./_time.js";

const pad=n=>String(n).padStart(2,"0");
const hourKey=d=>"zp:perf:hour:"+d.toISOString().slice(0,13).replace(/[-T:]/g,"");
export const onRequestGet = guard(async ({request,env}) => {
  const user=await currentUser(request,env);
  if(!user) return json({success:false,error:"未登录"},401);
  if(user.role!=="admin" && user.role!=="system_admin") return json({success:false,error:"无权限"},403);
  const now=new Date();
  const dates=[];
  for(let i=23;i>=0;i--){const d=new Date(now);d.setUTCHours(d.getUTCHours()-i,0,0,0);dates.push(d);}
  const raw=await pipeline(env,dates.map(d=>["HGETALL",hourKey(d)]));
  const totals={events:0,pages:{},endpoints:{},statuses:{},hours:[]};
  for(let i=0;i<dates.length;i++){
    const arr=Array.isArray(raw?.[i])?raw[i]:[];
    const hash={};for(let j=0;j+1<arr.length;j+=2)hash[String(arr[j])]=arr[j+1];
    const hour={at:dates[i].toISOString().slice(0,13)+":00Z",atBeijing:beijingISO(dates[i]).replace(/\\.\\d{3}/,""),events:0,groups:[]};
    const groups=new Map();
    for(const [field,value] of Object.entries(hash)){
      // 兼容两种字段形状：page|endpoint|status|metric（原有）
      // 与 page|endpoint|status|code:<code>|metric（新增的非 2xx 状态码细分）。
      const parts=field.split("|");if(parts.length<4)continue;
      const [page,endpoint,status]=parts;
      const metric=parts.slice(3).join("|");
      const id=page+"|"+endpoint+"|"+status;
      if(!groups.has(id))groups.set(id,{page,endpoint,status,count:0,sum:0,max:0,serverCount:0,serverSum:0,serverMax:0,phases:{},codes:{}});
      const g=groups.get(id),n=Number(value)||0;
      if(metric.startsWith("code:")){
        const bits=metric.split("|");
        if(bits.length===2){
          const code=bits[0].slice(5);
          if(/^\d{3}$/.test(code)){
            if(!g.codes[code])g.codes[code]={count:0,sum:0,max:0,serverCount:0,serverSum:0,serverMax:0};
            const c=g.codes[code];
            if(bits[1]==="count")c.count=n;
            else if(bits[1]==="sum")c.sum=n;
            else if(bits[1]==="max")c.max=n;
            else if(bits[1]==="server_count")c.serverCount=n;
            else if(bits[1]==="server_sum")c.serverSum=n;
            else if(bits[1]==="server_max")c.serverMax=n;
          }
        }
        continue;
      }
      if(metric==="count")g.count=n;
      else if(metric==="sum")g.sum=n;
      else if(metric==="max")g.max=n;
      else if(metric==="server_count")g.serverCount=n;
      else if(metric==="server_sum")g.serverSum=n;
      else if(metric==="server_max")g.serverMax=n;
      else if(metric.startsWith("phase:")){const bits=metric.split(":");if(bits.length===3&&/^(?:history|waybill)-[a-z-]+$/.test(bits[1])&&["count","sum","max"].includes(bits[2])){const phase=bits[1];if(!g.phases[phase])g.phases[phase]={count:0,sum:0,max:0};if(bits[2]==="count")g.phases[phase].count=n;else if(bits[2]==="sum")g.phases[phase].sum=n;else g.phases[phase].max=n;}}
    }
    for(const g of groups.values()){
      g.avgMs=g.count?Math.round(g.sum/g.count*10)/10:0;
      g.serverAvgMs=g.serverCount?Math.round(g.serverSum/g.serverCount*10)/10:null;
      const codes=g.codes||{};
      for(const code of Object.values(codes)){
        code.avgMs=code.count?Math.round(code.sum/code.count*10)/10:0;
        code.serverAvgMs=code.serverCount?Math.round(code.serverSum/code.serverCount*10)/10:null;
        delete code.sum;delete code.serverSum;
      }
      if(!Object.keys(codes).length)delete g.codes;
      const phases=g.phases||{};
      for(const phase of Object.values(phases)){phase.avgMs=phase.count?Math.round(phase.sum/phase.count*10)/10:0;delete phase.sum;}
      if(!Object.keys(phases).length)delete g.phases;
      delete g.sum;delete g.serverSum;
      hour.events+=g.count;totals.events+=g.count;
      totals.pages[g.page]=(totals.pages[g.page]||0)+g.count;
      totals.endpoints[g.endpoint]=(totals.endpoints[g.endpoint]||0)+g.count;
      totals.statuses[g.status]=(totals.statuses[g.status]||0)+g.count;
      hour.groups.push(g);
    }
    totals.hours.push(hour);
  }
  return json({success:true,windowHours:24,generatedAt:now.toISOString(),generatedAtBeijing:beijingISO(now),totals});
});
