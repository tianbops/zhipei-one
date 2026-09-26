import {json,body} from "./_json.js";
import {get,set,newId} from "./_redis.js";
import {hash} from "./login.js";

function normalize(v){return String(v||"").trim()}

export async function onRequestPost({request,env}){
  const input=await body(request);
  const username=normalize(input.username);
  const password=String(input.password||"");
  const name=normalize(input.name)||username;
  if(!username||!password)return json({success:false,error:"请输入账号和密码"},400);
  if(!/^[A-Za-z0-9_\-\.]{3,32}$/.test(username))return json({success:false,error:"账号需为3-32位字母、数字、下划线、短横线或点"},400);
  if(password.length<6)return json({success:false,error:"密码至少6位"},400);
  const key="user:index:"+username.toLowerCase();
  if(await get(env,key))return json({success:false,error:"账号已存在"},409);
  const id=newId();
  const user={id,username,name:name.slice(0,40),role:"user",disabled:false,boundRouteId:null,routeDuty:null,sessionVersion:1,passwordHash:await hash(password),createdAt:new Date().toISOString()};
  await set(env,"user:"+id,user);
  const idsRaw=await get(env,"users:index");
  let ids=[];
  try{ids=idsRaw?(typeof idsRaw==="string"?JSON.parse(idsRaw):idsRaw):[]}catch{ids=[]}
  if(!Array.isArray(ids))ids=[];
  if(!ids.includes(id))ids.push(id);
  await set(env,"users:index",ids);
  return json({success:true,user:{id,username,name:user.name,role:"user"}},201);
}
