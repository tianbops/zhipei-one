import {json} from "./_json.js";

export async function onRequestPost(){
  return json({
    success:false,
    code:"LEGACY_BOOTSTRAP_DISABLED",
    error:"旧管理员初始化接口已停用，请使用安全的管理员初始化入口"
  },410);
}

export async function onRequestGet(){
  return json({
    success:false,
    code:"LEGACY_BOOTSTRAP_DISABLED",
    error:"旧管理员初始化接口已停用"
  },410);
}
