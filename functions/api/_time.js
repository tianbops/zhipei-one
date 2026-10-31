/**
 * 智配One 时间字段规范。
 * 持久化保留 UTC ISO 字段；新增同一时刻的北京时间 ISO 字段（显式 +08:00）。
 * 不用于业务日期推导；业务日期继续由各业务模块按 Asia/Shanghai 规则生成。
 */
const pad = value => String(value).padStart(2, "0");

export function beijingISO(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${pad(date.getUTCMilliseconds())}${pad(date.getUTCMilliseconds())}${pad(date.getUTCMilliseconds())}+08:00`;
}

export function timeFields(value = new Date(), prefix = "") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("INVALID_TIME");
  const name = prefix ? prefix[0].toUpperCase() + prefix.slice(1) : "";
  return {
    [`${prefix}At`]: date.toISOString(),
    [`${prefix}AtBeijing`]: beijingISO(date)
  };
}
