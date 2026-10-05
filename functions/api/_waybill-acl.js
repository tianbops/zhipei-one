import {isTempRoute,TEMP_ROUTE_PREFIX} from "./dispatch.js";
import {canReadRouteData,canMaintainRoute} from "./_permissions.js";

// 运单「读取」与「写入(删改)」的归属判定 —— 隔离收口单一权威。
//
// 业务语义（2026-10-06 定稿）：
//   一条正式线路固定由一名驾驶员 + 一名配送员共同维护（二人互见、互删改）；
//   线路不停线，二人休假时由「带班人员」顶班——带班人员未绑定该线路，由派单临时
//   调度到该线路（dispatchRouteId=线路），每次可能不同。因此：
//     · 读取：线路授权成员（绑定二人 + 当前调度到该线路者）可见该线路**全部**运单
//     · 写入：绑定二人可互相删改；带班人员仅可删改**自己创建**的运单
//   即「可见范围 ≠ 可改范围」，带班拿到使用权而非维护权。
//
//   临时线路（__temp__:<userId>）恒按 owner 私有，不受任何开关影响。
//   紧急止血：环境变量 WAYBILL_STRICT_OWNER="1" 可把正式线路读取回退为「仅本人可见」。
export function canReadWaybill(user,w,env){
 if(!user||!w||!w.routeId)return false;
 if(isTempRoute(w.routeId)){
  return !w.createdBy ? (w.routeId===TEMP_ROUTE_PREFIX+user.id) : (w.createdBy===user.id);
 }
 const strictOwner=String((env&&env.WAYBILL_STRICT_OWNER)||"")==="1";
 // 老数据缺 createdBy：仍按线路成员可见（访问者已通过 canReadRouteData 权限层）
 if(strictOwner)return !w.createdBy ? canReadRouteData(user,w.routeId) : w.createdBy===user.id;
 return canReadRouteData(user,w.routeId);
}

// 写入（删除/修改）判定：绑定二人共同维护；带班及其他人仅限自己创建的。
export function canWriteWaybill(user,w,env){
 if(!user||!w||!w.routeId)return false;
 if(isTempRoute(w.routeId)){
  return !w.createdBy ? (w.routeId===TEMP_ROUTE_PREFIX+user.id) : (w.createdBy===user.id);
 }
 if(canMaintainRoute(user,w.routeId))return true;      // 绑定二人：共同维护
 return !!w.createdBy && w.createdBy===user.id;        // 带班人员：仅自己创建的
}
