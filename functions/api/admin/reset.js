import {json} from "../_json.js";

export async function onRequestPost(){
 return json({
  success:false,
  code:"TEST_RESET_DISABLED",
  error:"测试数据清理功能已停用，生产数据不允许通过此接口批量删除"
 },410);
}
