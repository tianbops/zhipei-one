import {isTempRoute,TEMP_ROUTE_PREFIX} from "./dispatch.js";
import {canReadRouteData} from "./_permissions.js";

// 运单读取/删除的归属判定（隔离收口单一权威）。
// 临时线路 routeId 编码 owner（__temp__:<userId>），天然按 owner 私有；
// 正式线路默认严格按 createdBy 私有，环境变量 SHARE_FORMAL_ROUTE_WAYBILLS="1"
// 时可回退为「线路授权成员互见」（driver/delivery 双绑定者共享）。
// 老数据缺 createdBy：临时按 routeId 归属兜底；正式视为可见（仅对通过权限层的成员），无新增泄漏面。
export function canReadWaybill(user,w,env){
 if(!user||!w||!w.routeId)return false;
 if(isTempRoute(w.routeId)){
  return !w.createdBy ? (w.routeId===TEMP_ROUTE_PREFIX+user.id) : (w.createdBy===user.id);
 }
 if(!w.createdBy)return true; // 老正式数据兜底：访问者已通过 canReadRouteData 权限层
 const shareFormal=String((env&&env.SHARE_FORMAL_ROUTE_WAYBILLS)||"")==="1";
 if(shareFormal)return canReadRouteData(user,w.routeId);
 return w.createdBy===user.id;
}
