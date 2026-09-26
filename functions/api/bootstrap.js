import {json,body} from "./_json.js";
import {get,set,newId} from "./_redis.js";
import {hash} from "./login.js";

function validUsername(v){
  return /^[A-Za-z0-9_]{3,32}$/.test(v);
}

async function getUserIds(env){
  const raw=await get(env,"users:index");

  try{
    const value=raw?(typeof raw==="string"?JSON.parse(raw):raw):[];
    return Array.isArray(value)?value:[];
  }catch{
    return [];
  }
}

async function hasActiveAdmin(env){
  const ids=await getUserIds(env);

  for(const id of ids){
    const raw=await get(env,"user:"+id);

    try{
      const user=raw?(typeof raw==="string"?JSON.parse(raw):raw):null;

      if(user && user.role==="admin" && !user.disabled){
        return true;
      }
    }catch{}
  }

  return false;
}

export async function onRequestPost({request,env}){
  const input=await body(request);

  const username=String(input.username||"").trim();
  const password=String(input.password||"");
  const name=
    String(input.name||"系统管理员").trim() ||
    "系统管理员";

  if(!validUsername(username)){
    return json({
      success:false,
      error:"管理员账号需为3-32位字母、数字或下划线"
    },400);
  }

  if(password.length<6){
    return json({
      success:false,
      error:"密码至少6位"
    },400);
  }

  /*
   * 只要系统中仍存在有效管理员，就禁止重新建立。
   * 避免重复创建管理员。
   */
  if(await hasActiveAdmin(env)){
    return json({
      success:false,
      error:"系统管理员已存在，请直接登录"
    },409);
  }

  const indexKey="user:index:"+username.toLowerCase();
  const oldId=await get(env,indexKey);

  /*
   * 如果 tianbo 等账号的索引还残留，
   * 但已经没有有效管理员，则恢复这个账号。
   */
  const id=oldId || newId();

  let oldUser={};

  if(oldId){
    const oldRaw=await get(env,"user:"+oldId);

    try{
      oldUser=oldRaw
        ? (typeof oldRaw==="string"
            ? JSON.parse(oldRaw)
            : oldRaw)
        : {};
    }catch{
      oldUser={};
    }
  }

  const now=new Date().toISOString();

  const user={
    ...oldUser,

    id,
    username,
    name,

    role:"admin",
    disabled:false,

    boundRouteId:null,
    routeDuty:null,
    dispatchRouteId:null,

    /*
     * 修改 sessionVersion，
     * 让旧会话自动失效。
     */
    sessionVersion:
      Number(oldUser.sessionVersion||0)+1,

    passwordHash:await hash(password),

    createdAt:
      oldUser.createdAt ||
      now
  };

  await set(env,"user:"+id,user);
  await set(env,indexKey,id);

  const ids=await getUserIds(env);

  if(!ids.includes(id)){
    ids.push(id);
  }

  await set(env,"users:index",ids);

  return json({
    success:true,
    message:oldId
      ? "系统管理员已恢复"
      : "系统管理员已建立",

    user:{
      id,
      username,
      name,
      role:"admin"
    }
  },oldId?200:201);
}

export async function onRequestGet(){
  return json({
    success:true,
    service:"Zhipei One",
    endpoint:"bootstrap",
    method:"POST_REQUIRED"
  },405);
}
