import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,command} from "../_redis.js";
import {hash} from "../login.js";

function admin(u){return u&&u.role==="admin"}
function validUsername(v){return /^[A-Za-z0-9_]{3,32}$/.test(v)}

export async function onRequestPost({request,env}){
  const actor=await currentUser(request,env);
  if(!admin(actor))return json({success:false,error:"无权限"},403);
  const input=await body(request);
  const action=String(input.action||"");

  if(action==="rename"){
    const username=String(input.username||"").trim();
    if(!validUsername(username))return json({success:false,error:"管理员账号需为3-32位字母、数字或下划线"},400);
    if(username.toLowerCase()===String(actor.username||"").toLowerCase())return json({success:true,user:{id:actor.id,username}});
    const oldKey="zp:user:index:"+String(actor.username||"").toLowerCase();
    const newKey="zp:user:index:"+username.toLowerCase();
    const userKey="zp:user:"+actor.id;
    const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] or u.role~='admin' then return 3 end; if redis.call('GET',KEYS[2]) then return 4 end; redis.call('DEL',KEYS[1]); u.username=ARGV[1]; u.name=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[3],cjson.encode(u)); redis.call('SET',KEYS[2],ARGV[2]); return 1";
    const code=Number(await command(env,["EVAL",script,"3",oldKey,newKey,userKey,username,actor.id]));
    if(code===4)return json({success:false,error:"管理员账号已存在"},409);
    if(code!==1)return json({success:false,error:"管理员账号状态已变化，请刷新后重试"},409);
    return json({success:true,user:{id:actor.id,username}});
  }

  if(action==="password"){
    const currentPassword=String(input.currentPassword||"");
    const password=String(input.password||"");
    if(!currentPassword||!password)return json({success:false,error:"请输入当前密码和新密码"},400);
    if(password.length<6)return json({success:false,error:"密码至少6位"},400);
    if(actor.passwordHash!==await hash(currentPassword))return json({success:false,error:"当前密码错误"},403);
    const nextHash=await hash(password);
    const key="zp:user:"+actor.id;
    const script="local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] or u.role~='admin' then return 3 end; u.passwordHash=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1";
    const code=Number(await command(env,["EVAL",script,"1",key,nextHash,actor.id]));
    if(code!==1)return json({success:false,error:"管理员账号状态已变化，请刷新后重试"},409);
    return json({success:true});
  }

  if(action==="reset"){
    const password=String(input.password||"");
    if(!password)return json({success:false,error:"请输入管理员密码"},400);
    if(actor.passwordHash!==await hash(password))return json({success:false,error:"管理员密码错误"},403);

    const keep=new Set([
      "zp:user:"+String(actor.id),
      "zp:user:index:"+String(actor.username||"").toLowerCase(),
      "zp:users:index"
    ]);
    const authorization=(request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"").trim();
    const cookie=request.headers.get("cookie")||"";
    const m=cookie.match(/(?:^|;\s*)zp_session=([^;]+)/);
    const sessionToken=authorization|| (m?decodeURIComponent(m[1]):"");
    if(sessionToken)keep.add("zp:session:"+sessionToken);

    let cursor="0";
    let deleted=0;
    do{
      const scan=await command(env,["SCAN",cursor,"MATCH","zp:*","COUNT","200"]);
      cursor=String(scan?.[0]??"0");
      const keys=Array.isArray(scan?.[1])?scan[1]:[];
      const remove=keys.filter(k=>{
        if(keep.has(k))return false;
        if(k.startsWith("zp:system:"))return false;
        if(k.startsWith("zp:config:"))return false;
        if(k.startsWith("zp:settings:"))return false;
        return true;
      });
      if(remove.length){
        await command(env,["DEL",...remove]);
        deleted+=remove.length;
      }
    }while(cursor!=="0");

    await set(env,"users:index",[actor.id]);
    return json({success:true,deleted});
  }

  return json({success:false,error:"不支持的操作"},400);
}
