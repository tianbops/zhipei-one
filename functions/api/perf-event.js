import { json } from "./_json.js";
import { command } from "./_redis.js";
import { guard } from "./_safe.js";

const PAGES = new Set(["home","history","routes","account","login"]);
const ENDPOINTS = new Set(["page-load","api-home","api-history","api-history-detail","api-history-search","api-routes","api-account","api-waybills","api-auth","api-other"]);
const LUA = `
local rate = tonumber(redis.call("INCR", KEYS[2]))
if rate == 1 then redis.call("EXPIRE", KEYS[2], 3600) end
if rate > 3000 then return -1 end
for i=1,#ARGV,7 do
  local page=ARGV[i]
  local endpoint=ARGV[i+1]
  local status=ARGV[i+2]
  local duration=tonumber(ARGV[i+3])
  local server=tonumber(ARGV[i+4])
  local hasServer=tonumber(ARGV[i+5])
  local phasesRaw=ARGV[i+6]
  if page and endpoint and status and duration then
    local base=page.."|"..endpoint.."|"..status.."|"
    redis.call("HINCRBY",KEYS[1],base.."count",1)
    redis.call("HINCRBYFLOAT",KEYS[1],base.."sum",duration)
    local old=tonumber(redis.call("HGET",KEYS[1],base.."max") or "0")
    if duration>old then redis.call("HSET",KEYS[1],base.."max",duration) end
    if hasServer==1 and server then
      redis.call("HINCRBY",KEYS[1],base.."server_count",1)
      redis.call("HINCRBYFLOAT",KEYS[1],base.."server_sum",server)
      local so=tonumber(redis.call("HGET",KEYS[1],base.."server_max") or "0")
      if server>so then redis.call("HSET",KEYS[1],base.."server_max",server) end
    end
    if phasesRaw and phasesRaw~="" then
      local ok,phases=pcall(cjson.decode,phasesRaw)
      if ok and type(phases)=="table" then
        for name,dur in pairs(phases) do
          if string.match(name,"^history%-[a-z%-]+$") then
            local value=tonumber(dur)
            if value and value>=0 and value<=120000 then
              local phaseBase=base.."phase:"..name..":"
              redis.call("HINCRBY",KEYS[1],phaseBase.."count",1)
              redis.call("HINCRBYFLOAT",KEYS[1],phaseBase.."sum",value)
              local phaseMax=tonumber(redis.call("HGET",KEYS[1],phaseBase.."max") or "0")
              if value>phaseMax then redis.call("HSET",KEYS[1],phaseBase.."max",value) end
            end
          end
        end
      end
    end
  end
end
redis.call("EXPIRE",KEYS[1],1209600)
return 1
`;

function validEvent(e) {
  if (!e || !PAGES.has(e.page) || !ENDPOINTS.has(e.endpoint)) return null;
  const status = ["2xx","3xx","4xx","5xx","network"].includes(e.status) ? e.status : null;
  const duration = Number(e.duration);
  const server = e.server == null ? null : Number(e.server);
  if (!status || !Number.isFinite(duration) || duration < 0 || duration > 120000) return null;
  if (server !== null && (!Number.isFinite(server) || server < 0 || server > 120000)) return null;
  const allowedPhases = new Set(["history-auth","history-route","history-index","history-aggregate","history-search-index","history-search-read","history-detail-read","history-detail-enrich","history-response-build"]);
  const phases = {};
  if (e.phases && typeof e.phases === "object" && !Array.isArray(e.phases)) {
    for (const [name, value] of Object.entries(e.phases)) {
      const n = Number(value);
      if (allowedPhases.has(name) && Number.isFinite(n) && n >= 0 && n <= 120000) phases[name] = Math.round(n*10)/10;
    }
  }
  return [e.page,e.endpoint,status,String(Math.round(duration*10)/10),server===null?"0":String(Math.round(server*10)/10),server===null?"0":"1",JSON.stringify(phases)];
}

export const onRequestPost = guard(async ({request,env}) => {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  if (!origin || origin !== requestUrl.origin) return json({success:false,error:"同源请求才可提交"},403);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 16384) return json({success:false,error:"请求过大"},413);
  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 16384) return json({success:false,error:"请求过大"},413);
    body = JSON.parse(raw);
  } catch { return json({success:false,error:"请求格式错误"},400); }
  if (!body || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 25) {
    return json({success:false,error:"事件数量无效"},400);
  }
  const events = body.events.map(validEvent).filter(Boolean);
  if (!events.length) return json({success:true,accepted:0});
  const now = new Date();
  const hour = now.toISOString().slice(0,13).replace(/[-T:]/g,"");
  const key = "zp:perf:hour:" + hour;
  const rateKey = "zp:perf:ingest-rate:" + hour;
  const result = await command(env,["EVAL",LUA,"2",key,rateKey,...events.flat()]);
  if (Number(result) === -1) return json({success:false,error:"采集限流"},429);
  return json({success:true,accepted:events.length});
});
