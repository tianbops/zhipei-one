import {json,body} from "./_json.js";
import {get,set,newId} from "./_redis.js";
import {hash} from "./login.js";

function validUsername(v){return /^[a-zA-Z0-9_]{3,32}$/.test(v);}
export async function onRequestPost({request,env}){
 const input=await body(request);
 const username=String(input.username||"").trim();
 const password=String(input.password||"");
 const name=String(input.name||"系统管理员").trim()||"系统管理员";
 const existing=await get(env,"users:index");
 if(existing)return json({success:false,error:"系统已经完成初始化"},409);
 if(!validUsername(username))return json({success:false,error:"管理员账号需为3-32位字母、数字或下划线"},400);
 if(password.length<6)return json({success:false,error:"密码至少6位"},400);
 const id=newId();
 const user={id,username,name,role:"admin",disabled:false,sessionVersion:1,boundRouteId:null,routeDuty:null,dispatchRouteId:null,createdAt:new Date().toISOString(),passwordHash:await hash(password)};
 await set(env,"user:"+id,user);
 await set(env,"user:index:"+username.toLowerCase(),id);
 await set(env,"users:index",[id]);
 return json({success:true,message:"系统管理员已建立",user:{id,username,name,role:"admin"}},201);
}
