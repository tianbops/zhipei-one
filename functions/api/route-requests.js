/**
 * 线路申请：GET 列本人申请，POST 提交；可选填申请人姓名 / 手机号（仅供管理员审核与联系，空值不落库）。
 */
import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command,newId} from "./_redis.js";
import {getRoute,validDuty} from "./_route.js";
import {canUseRoute,isSystemAdmin} from "./_permissions.js";
import {Budget,mgetBatchMap,throwBudgetExceeded,SUBREQUEST_LIMIT} from "./_redis-budget.js";
function parse(v){try{return typeof v==="string"?JSON.parse(v):v}catch{return null}}
// 申请人信息（姓名 / 手机号）：都是选填，但「填了就必须合法」。
// 空值统一归一成 ""，调用方不写字段——这样「没填」与「填了又删」在数据里是同一种状态，
// 管理端只需要判断「有没有值」，不用区分 null / "" / undefined 三种空。
const APPLICANT_NAME_MAX=20;
const APPLICANT_PHONE_RE=/^1[3-9]\d{9}$/;
// 控制字符 + 零宽 + bidi 覆写：既会撑坏管理端排版，也能让「张\u200b三」这种
// 看起来一样、检索不到的名字混进来，还可用 RLO 把显示顺序倒过来骗审核。一律拒。
const APPLICANT_NAME_BAD=/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
function normalizeApplicantName(v){
 if(v===undefined||v===null)return {value:""};
 if(typeof v!=="string")return {error:"申请人姓名格式不正确"};
 // 换行折成空格：输入框允许增高到两行，但姓名在存储与展示上必须是一行，
 // 否则管理端卡片会被多行内容撑变形。
 const s=v.replace(/\s+/g," ").trim();
 if(!s)return {value:""};
 if(APPLICANT_NAME_BAD.test(s))return {error:"申请人姓名包含不支持的字符"};
 if([...s].length>APPLICANT_NAME_MAX)return {error:"申请人姓名最多 "+APPLICANT_NAME_MAX+" 个字"};
 return {value:s};
}
function normalizeApplicantPhone(v){
 if(v===undefined||v===null)return {value:""};
 if(typeof v!=="string")return {error:"手机号格式不正确"};
 // 允许用户按 138-0013-8000 / 138 0013 8000 输入，落库统一成 11 位数字
 const s=v.replace(/[\s-]/g,"");
 if(!s)return {value:""};
 if(!APPLICANT_PHONE_RE.test(s))return {error:"手机号格式不正确"};
 return {value:s};
}
async function loadRequest(env,id){return parse(await get(env,"route-request:"+id))}
async function list(env){const raw=await get(env,"route-requests:index");if(!raw)return [];const v=parse(raw);if(!Array.isArray(v))throw Object.assign(new Error("ROUTE_REQUEST_INDEX_INVALID"),{code:"ROUTE_REQUEST_INDEX_INVALID"});return v}
export async function onRequestGet({request,env}){
 const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
 let ids;try{ids=await list(env)}catch{return json({success:false,code:"ROUTE_REQUEST_INDEX_INVALID",error:"线路申请索引数据异常，请联系管理员处理"},409)}
 const all=Array.isArray(ids)?ids:[];
 for(const id of all){if(typeof id!=="string"||!id)return json({success:false,code:"ROUTE_REQUEST_INDEX_INVALID",error:"线路申请索引数据异常，请联系管理员处理"},409)}
 // P1-04 收口：原实现逐条 loadRequest（每条 1 个 GET）= N 子请求，
 // 现统一 MGET 分批 + 共享 Budget，预算不足即抛错，绝不返回「只列了一半申请」的 success。
 const budget=new Budget(SUBREQUEST_LIMIT);
 const {map,complete}=await mgetBatchMap(env,all.map(id=>"zp:route-request:"+id),budget,{batch:100});
 if(!complete)throwBudgetExceeded(budget.max,"route-requests-list");
 const items=[];
 for(const id of all){const x=parse(map.get("zp:route-request:"+id));if(!x)return json({success:false,code:"ROUTE_REQUEST_DATA_INVALID",error:"线路申请索引包含缺失或损坏的申请记录，请联系管理员处理"},409);if(typeof x.id!=="string"||x.id!==id||typeof x.userId!=="string"||typeof x.routeId!=="string"||!validDuty(x.duty)||!["pending","approved","rejected"].includes(x.status))return json({success:false,code:"ROUTE_REQUEST_DATA_INVALID",error:"线路申请数据异常，请联系管理员处理"},409);if(isSystemAdmin(user)?x.status==="pending":x.userId===user.id)items.push(x)}
 return json({success:true,requests:items});
}
export async function onRequestPost({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(!canUseRoute(user))return json({success:false,error:"管理员不参与业务线路绑定"},403);
 const input=await body(request);
 const routeId=String(input.routeId||"").trim();
 const duty=String(input.duty||"");
 if(!routeId||!validDuty(duty))return json({success:false,error:"线路或岗位无效"},400);
 const route=await getRoute(env,routeId);
 if(!route||route.status!=="active")return json({success:false,error:"线路不存在或已停用"},404);
 // 申请人信息校验：前端也会拦，但前端从来不算安全边界（仓库既有约定）。
 const applicantName=normalizeApplicantName(input.applicantName);
 if(applicantName.error)return json({success:false,code:"APPLICANT_NAME_INVALID",error:applicantName.error},400);
 const applicantPhone=normalizeApplicantPhone(input.applicantPhone);
 if(applicantPhone.error)return json({success:false,code:"APPLICANT_PHONE_INVALID",error:applicantPhone.error},400);
 const id=newId(),now=new Date().toISOString();
 const userKey="zp:user:"+user.id,routeKey="zp:route:"+routeId,reqKey="zp:route-request:"+id,indexKey="zp:route-requests:index";
 const script="local cu=redis.call('GET',KEYS[1]); local cr=redis.call('GET',KEYS[2]); if not cu or not cr then return 2 end; local oku,u=pcall(cjson.decode,cu); local okr,r=pcall(cjson.decode,cr); if not oku or type(u)~='table' or not okr or type(r)~='table' then return 10 end; if u.disabled then return 7 end; if u.boundRouteId then return 4 end; if u.routeDuty then return 11 end; if r.status~='active' then return 8 end; if r.driverUserId==u.id or r.deliveryUserId==u.id then return 12 end; if ARGV[2]=='driver' and r.driverUserId then return 5 end; if ARGV[2]=='delivery' and r.deliveryUserId then return 6 end; local raw=redis.call('GET',KEYS[4]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if not ok or type(v)~='table' then return 9 end; ids=v end; for _,rid in ipairs(ids) do local rqraw=redis.call('GET','zp:route-request:'..rid); if rqraw then local ok,q=pcall(cjson.decode,rqraw); if ok and type(q)=='table' and q.userId==u.id and q.routeId==r.id and q.duty==ARGV[2] then if q.status=='pending' then return 3 end; if q.status=='approved' then return 13 end end end end; local q={id=ARGV[1],userId=u.id,routeId=r.id,duty=ARGV[2],status='pending',createdAt=ARGV[3]}; if ARGV[4]~='' then q.applicantName=ARGV[4] end; if ARGV[5]~='' then q.applicantPhone=ARGV[5] end; redis.call('SET',KEYS[3],cjson.encode(q)); table.insert(ids,ARGV[1]); redis.call('SET',KEYS[4],cjson.encode(ids)); return 1"
 const rawCode=await command(env,["EVAL",script,"4",userKey,routeKey,reqKey,indexKey,id,duty,now,applicantName.value,applicantPhone.value]);
 const code=Number(rawCode);
 if(code===3)return json({success:false,error:"已有待审核申请"},409);
 if(code===13)return json({success:false,error:"该线路该岗位已批准，无需重复申请"},409);
 if(code===4)return json({success:false,error:"你已绑定其他线路"},409);
 if(code===5||code===6)return json({success:false,error:"线路岗位已被占用"},409);
 if(code===7)return json({success:false,error:"账号已停用"},403);
 if(code===8)return json({success:false,error:"线路不存在或已停用"},409);
 if(code===9)return json({success:false,code:"ROUTE_REQUEST_INDEX_INVALID",error:"线路申请索引数据异常，请联系管理员处理"},409);
 if(code===10)return json({success:false,code:"ROUTE_REQUEST_DATA_INVALID",error:"用户或线路数据异常，请联系管理员处理"},409);
 if(code===11)return json({success:false,code:"USER_BINDING_INCONSISTENT",error:"用户绑定岗位数据异常，请联系管理员处理"},409);
 if(code===12)return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"线路岗位绑定数据异常，请联系管理员处理"},409);
 if(code!==1)return json({success:false,code:"ROUTE_REQUEST_FAILED",message:"申请提交失败"},409);
 return json({success:true,request:{id,userId:user.id,routeId,duty,status:"pending",createdAt:now,...(applicantName.value?{applicantName:applicantName.value}:{}),...(applicantPhone.value?{applicantPhone:applicantPhone.value}:{})}});
}
