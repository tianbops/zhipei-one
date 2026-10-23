import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,command} from "../_redis.js";
import {Budget,scanKeysBudgeted,SUBREQUEST_LIMIT} from "../_redis-budget.js";
import {verifyPassword,hashPassword} from "../_password.js";
import {isSystemAdmin} from "../_permissions.js";
import {normalizeLegacyRoles} from "../_migrations.js";
function validUsername(v){return /^[A-Za-z0-9_]{3,32}$/.test(v)}

export async function onRequestPost({request,env}){
  const actor=await currentUser(request,env);
  if(!isSystemAdmin(actor))return json({success:false,error:"无权限"},403);
  const input=await body(request);
  const action=String(input.action||"");

  if(action==="rename"){
    const username=String(input.username||"").trim();
    if(!validUsername(username))return json({success:false,error:"管理员账号需为3-32位字母、数字或下划线"},400);
    if(username.toLowerCase()===String(actor.username||"").toLowerCase())return json({success:true,user:{id:actor.id,username}});
    const oldKey="zp:user:index:"+String(actor.username||"").toLowerCase();
    const newKey="zp:user:index:"+username.toLowerCase();
    const userKey="zp:user:"+actor.id;
    const script="local raw=redis.call('GET',KEYS[3]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] or (u.role~='admin' and u.role~='system_admin') then return 3 end; local existing=redis.call('GET',KEYS[2]); if existing and existing~=ARGV[2] then return 4 end; local old=redis.call('GET',KEYS[1]); if old and old~=ARGV[2] then return 5 end; redis.call('DEL',KEYS[1]); u.username=ARGV[1]; u.name=ARGV[1]; redis.call('SET',KEYS[3],cjson.encode(u)); redis.call('SET',KEYS[2],ARGV[2]); return 1";
    const code=Number(await command(env,["EVAL",script,"3",oldKey,newKey,userKey,username,actor.id]));
    if(code===4)return json({success:false,error:"管理员账号已存在"},409);
    if(code===5)return json({success:false,error:"管理员账号索引状态已变化，请刷新后重试"},409);
    if(code!==1)return json({success:false,error:"管理员账号状态已变化，请刷新后重试"},409);
    return json({success:true,user:{id:actor.id,username}});
  }

  if(action==="password"){
    const currentPassword=String(input.currentPassword||"");
    const password=String(input.password||"");
    if(!currentPassword||!password)return json({success:false,error:"请输入当前密码和新密码"},400);
    if(password.length<8)return json({success:false,error:"密码至少8位"},400);
    if(!(await verifyPassword(currentPassword,actor.passwordHash)))return json({success:false,error:"当前密码错误"},403);
    const nextHash=await hashPassword(password,env);
    const key="zp:user:"+actor.id;
    const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] or (u.role~='admin' and u.role~='system_admin') then return 3 end; u.passwordHash=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1";
    const code=Number(await command(env,["EVAL",script,"1",key,nextHash,actor.id]));
    if(code!==1)return json({success:false,error:"管理员账号状态已变化，请刷新后重试"},409);
    return json({success:true});
  }

  if(action==="reset"){
    const password=String(input.password||"");
    if(!password)return json({success:false,error:"请输入管理员密码"},400);
    if(!(await verifyPassword(password,actor.passwordHash)))return json({success:false,error:"管理员密码错误"},403);

    // 只清理旧运单/历史运行数据，保留管理员、普通用户、线路、线路基准和系统配置。
    const oldPatterns=[
      "zp:waybill:*",
      "zp:route:*:waybills:*",
      "zp:route:*:orders:today",
      "zp:route:*:orders:latest",
      "zp:route:*:orders:index-repair*",
      "zp:route:*:history:*",
      "zp:history:*"
    ];
    // 全局共享同一 Budget（每请求一个）：7 个旧数据模式合计不超过 SUBREQUEST_LIMIT，
    // 即便其中多个模式在大键空间下不匹配也绝不越过平台 ~50 子请求上限（避免 1101）。
    const budget=new Budget(SUBREQUEST_LIMIT);
    let deleted=0, complete=true;
    for(const pattern of oldPatterns){
      // 原实现 SCAN 全键空间无上限循环，大运单量下 O(全键空间) 子请求 → 潜在 1101。
      // 现统一收口到 _redis-budget.js：scanKeysBudgeted 受预算 + 迭代上限约束，DEL 分批(100)且受预算门控。
      // 截断（iterCap 触顶 / 预算耗尽 / 键数超限）须显式上报 complete=false，绝不静默报 success——与 consistency/stats/diagnostic 约定对齐。
      const {keys,complete:scanOk}=await scanKeysBudgeted(env,pattern,budget,{count:200,iterCap:12});
      if(!scanOk)complete=false;
      for(let i=0;i<keys.length;i+=100){
        if(!budget.take(1)){complete=false;break;} // 预算门控 DEL（避免 1101）；可再次 reset 续清剩余旧数据
        const batch=keys.slice(i,i+100);
        await command(env,["DEL",...batch]);
        deleted+=batch.length;
      }
      if(!budget.remaining)break; // 预算耗尽，停止后续模式扫描（共享预算，整体不越平台限）
    }
    const result={success:true,deleted,complete};
    if(!complete)result.message="旧数据规模超出单次清理预算，已尽力清理部分数据；可再次执行 reset 续清剩余项";
    return json(result);
  }

 if(action==="normalize-roles"){
  // P2-10 收口：迁移现已纳入统一子请求预算，耗尽时返回结构化 503 提示可重试，
  // 绝不把「只归一化了一部分」当成 success 上报（与第一批 P1-01 同一诚实性原则）。
  let r;
  try{r=await normalizeLegacyRoles(env);}
  catch(e){if(e?.code==="SUBREQUEST_BUDGET_EXCEEDED")return json({success:false,code:"SUBREQUEST_BUDGET_EXCEEDED",error:"账号数量达到单次迁移预算，请稍后重试（迁移为幂等，可重复执行）"},503);throw e}
  return json({success:true,scanned:r.scanned,normalized:r.normalized,errors:r.errors,complete:r.complete});
 }

  return json({success:false,error:"不支持的操作"},400);
}
