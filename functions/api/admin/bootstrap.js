import {json,body} from "../_json.js";
import {get,command,newId} from "../_redis.js";
import {hash} from "../login.js";

function normalize(v){return String(v||"").trim()}

export async function onRequestPost({request,env}){
  try{
    const input=await body(request);
    const username=normalize(input.username);
    const password=String(input.password||"");
    const setupKey=normalize(input.setupKey);

    if(!/^[A-Za-z0-9_]{3,32}$/.test(username))
      return json({success:false,error:"管理员账号需为3-32位字母、数字或下划线"},400);
    if(password.length<6)
      return json({success:false,error:"密码至少6位"},400);
    if(!setupKey)
      return json({success:false,error:"初始化密钥不能为空"},400);
    if(env.ADMIN_SETUP_KEY&&setupKey!==env.ADMIN_SETUP_KEY)
      return json({success:false,error:"初始化校验失败"},403);
    if(!env.ADMIN_SETUP_KEY)
      return json({success:false,error:"系统未配置初始化密钥"},503);

    const id=newId();
    const user={id,username,name:"系统管理员",role:"admin",disabled:false,boundRouteId:null,routeDuty:null,dispatchRouteId:null,sessionVersion:1,passwordHash:await hash(password),createdAt:new Date().toISOString()};
    const userJson=JSON.stringify(user);
    const userIndexKey="zp:user:index:"+username.toLowerCase();
    const userKey="zp:user:"+id;
    const usersIndexKey="zp:users:index";

    const script=`local idsRaw=redis.call('GET',KEYS[1]); local ids={}; if idsRaw then local ok,v=pcall(cjson.decode,idsRaw); if not ok or type(v)~='table' then return 4 end; ids=v end; for _,uid in ipairs(ids) do local raw=redis.call('GET','zp:user:'..uid); if raw then local ok,u=pcall(cjson.decode,raw); if not ok then return 5 end; if u.role=='admin' then return 2 end end end; if redis.call('GET',KEYS[2]) then return 3 end; redis.call('SET',KEYS[3],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); table.insert(ids,ARGV[3]); redis.call('SET',KEYS[1],cjson.encode(ids)); return 1`;
    const result=Number(await command(env,["EVAL",script,"3",usersIndexKey,userIndexKey,userKey,userJson,id,id]));

    if(result===2)return json({success:false,error:"系统管理员已存在，请直接登录"},409);
    if(result===3)return json({success:false,error:"管理员账号已存在"},409);
    if(result===4)return json({success:false,error:"用户索引数据异常，无法安全初始化管理员"},409);
    if(result===5)return json({success:false,error:"用户数据异常，无法安全初始化管理员"},409);
    if(result!==1)return json({success:false,error:"管理员初始化失败"},409);

    return json({success:true,user:{id,username,role:"admin"}},201);
  }catch(error){
    return json({success:false,error:"管理员初始化服务异常，请稍后重试",code:"ADMIN_BOOTSTRAP_INTERNAL_ERROR"},500);
  }
}
