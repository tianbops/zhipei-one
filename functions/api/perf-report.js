import { json } from "./_json.js";
import { currentUser } from "./_auth.js";
import { pipeline } from "./_redis.js";
import { guard } from "./_safe.js";

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
    const hour={at:dates[i].toISOString().slice(0,13)+":00Z",events:0,groups:[]};
    const groups=new Map();
    for(const [field,value] of Object.entries(hash)){
      const parts=field.split("|");if(parts.length!==4)continue;
      const [page,endpoint,status,metric]=parts;
      const id=page+"|"+endpoint+"|"+status;
      if(!groups.has(id))groups.set(id,{page,endpoint,status,count:0,sum:0,max:0,serverCount:0,serverSum:0,serverMax:0,phases:{}});
      const g=groups.get(id),n=Number(value)||0;
      if(metric==="count")g.count=n;
      else if(metric==="sum")g.sum=n;
      else if(metric==="max")g.max=n;
      else if(metric==="server_count")g.serverCount=n;
      else if(metric==="server_sum")g.serverSum=n;
      else if(metric==="server_max")g.serverMax=n;
      else if(metric.startsWith("phase:")){const bits=metric.split(":");if(bits.length===3&&/^history-[a-z-]+$/.test(bits[1])&&["count","sum","max"].includes(bits[2])){const phase=bits[1];if(!g.phases[phase])g.phases[phase]={count:0,sum:0,max:0};if(bits[2]==="count")g.phases[phase].count=n;else if(bits[2]==="sum")g.phases[phase].sum=n;else g.phases[phase].max=n;}}
    }
    for(const g of groups.values()){
      g.avgMs=g.count?Math.round(g.sum/g.count*10)/10:0;
      g.serverAvgMs=g.serverCount?Math.round(g.serverSum/g.serverCount*10)/10:null;
      for(const phase of Object.values(g.phases)){phase.avgMs=phase.count?Math.round(phase.sum/phase.count*10)/10:0;delete phase.sum;}
      if(!Object.keys(g.phases).length)delete g.phases;
      delete g.sum;delete g.serverSum;
      hour.events+=g.count;totals.events+=g.count;
      totals.pages[g.page]=(totals.pages[g.page]||0)+g.count;
      totals.endpoints[g.endpoint]=(totals.endpoints[g.endpoint]||0)+g.count;
      totals.statuses[g.status]=(totals.statuses[g.status]||0)+g.count;
      hour.groups.push(g);
    }
    totals.hours.push(hour);
  }
  return json({success:true,windowHours:24,generatedAt:now.toISOString(),totals});
});
