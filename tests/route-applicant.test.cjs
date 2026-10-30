// 线路申请「申请人信息（选填）」的后端契约
// ------------------------------------------------------------------
// 2026-10-30 新增。管理端审批卡片此前只显示 tian860 这类账号名，
// 管理员对不上人；因此在岗位下方加姓名 / 手机号两个选填字段。
//
// 本用例钉死四件事：
//   1. 填了就落库、且返回体同步回带；
//   2. 不填就不写字段（不存 ""，避免「没填」与「填了又删」变成两种状态）；
//   3. 非法值一律 400 **且不落库**（校验必须发生在写之前，不能先写再报错）；
//   4. 管理端列表透出申请人信息，旧记录（没有这两个字段）给空串而非 undefined。
//
// 运行：node tests/route-applicant.test.mjs
const { pathToFileURL } = require("url");
const fs = require("fs");
const path = require("path");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
const setkv = (k, obj) => red.command(["SET", "zp:" + k, typeof obj === "string" ? obj : JSON.stringify(obj)]);
const getkv = async k => { const r = await red.command(["GET", "zp:" + k]); if (r === null || r === undefined) return null; try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } };
const req = (p, token, body) => ({
  url: "https://app.local" + p,
  headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) },
  json: async () => body || {},
});

(async () => {
  const userReqs = await import(baseDir + "route-requests.js");
  const adminReqs = await import(baseDir + "admin/route-requests.js");

  // 每个用例换一个用户，避开「已有待审核申请 / 已绑定」这些互斥分支
  let seq = 0;
  async function freshUser() {
    const uid = "u" + (++seq);
    const tok = "tok" + uid;
    await setkv("user:" + uid, { id: uid, username: uid, role: "user", sessionVersion: 1 });
    await setkv("session:" + tok, { userId: uid, sessionVersion: 1 });
    return { uid, tok };
  }
  await setkv("route:r1", { id: "r1", name: "17号线", status: "active" });
  await setkv("route-requests:index", JSON.stringify([]));

  const submit = async (tok, payload) =>
    userReqs.onRequestPost({ request: req("/api/route-requests", tok, payload), env });
  const idx = async () => (await getkv("route-requests:index")) || [];
  const lastRequest = async () => {
    const ids = await idx();
    for (let i = ids.length - 1; i >= 0; i--) {
      const x = await getkv("route-request:" + ids[i]);
      if (x) return x;
    }
    return null;
  };
  const before = async () => (await idx()).length;

  // ============ 一、正常落库 ============
  console.log("【一】填了就落库，返回体同步回带");
  {
    const { tok } = await freshUser();
    const res = await submit(tok, { routeId: "r1", duty: "driver", applicantName: "张三", applicantPhone: "13800138000" });
    const j = await res.json();
    check("提交成功", j.success === true, "HTTP " + res.status);
    check("返回体带 applicantName", j.request && j.request.applicantName === "张三");
    check("返回体带 applicantPhone", j.request && j.request.applicantPhone === "13800138000");
    const saved = await lastRequest();
    check("落库 applicantName", saved.applicantName === "张三", JSON.stringify(saved.applicantName));
    check("落库 applicantPhone", saved.applicantPhone === "13800138000");
  }

  // ============ 二、不填不写字段 ============
  console.log("【二】两个都留空：不写字段（不是写空串）");
  {
    const { tok } = await freshUser();
    const res = await submit(tok, { routeId: "r1", duty: "driver" });
    const j = await res.json();
    check("仍可提交（选填）", j.success === true, "HTTP " + res.status);
    check("返回体不含 applicantName", !("applicantName" in (j.request || {})));
    const saved = await lastRequest();
    check("落库不含 applicantName key", !("applicantName" in saved), Object.keys(saved).join(","));
    check("落库不含 applicantPhone key", !("applicantPhone" in saved));
  }

  // ============ 三、归一化 ============
  console.log("【三】归一化：换行折空格、手机号去横线空格");
  {
    const { tok } = await freshUser();
    await submit(tok, { routeId: "r1", duty: "driver", applicantName: "  张三\n（替班） ", applicantPhone: "138-0013-8000" });
    const saved = await lastRequest();
    check("多空白 / 换行折成单空格并 trim", saved.applicantName === "张三 （替班）", JSON.stringify(saved.applicantName));
    check("手机号去掉分隔符后落库 11 位", saved.applicantPhone === "13800138000", JSON.stringify(saved.applicantPhone));
  }

  // ============ 四、非法值：400 且不落库 ============
  console.log("【四】填了就必须合法：400 且绝不写库");
  {
    const { tok } = await freshUser();
    const n0 = await before();
    const res = await submit(tok, { routeId: "r1", duty: "driver", applicantName: "张".repeat(21) });
    const j = await res.json();
    check("21 字姓名 → 400", res.status === 400, "HTTP " + res.status);
    check("错误码 APPLICANT_NAME_INVALID", j.code === "APPLICANT_NAME_INVALID", j.code);
    check("校验先于写入（索引未增长）", (await before()) === n0);
  }
  {
    const { tok } = await freshUser();
    const res = await submit(tok, { routeId: "r1", duty: "driver", applicantPhone: "1380013800" });
    const j = await res.json();
    check("10 位手机号 → 400", res.status === 400, "HTTP " + res.status);
    check("错误码 APPLICANT_PHONE_INVALID", j.code === "APPLICANT_PHONE_INVALID", j.code);
  }
  {
    const { tok } = await freshUser();
    const res = await submit(tok, { routeId: "r1", duty: "driver", applicantPhone: "23800138000" });
    check("非 1[3-9] 开头 → 400", res.status === 400, "HTTP " + res.status);
  }
  {
    // 零宽字符 / bidi 覆写：显示上肉眼无差，但检索不到、还能把显示顺序倒过来骗审核
    const { tok } = await freshUser();
    const res = await submit(tok, { routeId: "r1", duty: "driver", applicantName: "张\u200b三" });
    const j = await res.json();
    check("含零宽字符 → 400", res.status === 400, "HTTP " + res.status);
    check("错误码可识别", j.code === "APPLICANT_NAME_INVALID", j.code);
  }
  {
    const { tok } = await freshUser();
    const res = await submit(tok, { routeId: "r1", duty: "driver", applicantName: 12345 });
    check("非字符串姓名 → 400", res.status === 400, "HTTP " + res.status);
  }
  {
    // 空串 / 纯空白等价于「没填」，不该被当成非法值挡掉
    const { tok } = await freshUser();
    const res = await submit(tok, { routeId: "r1", duty: "driver", applicantName: "   ", applicantPhone: " " });
    const j = await res.json();
    check("纯空白视为未填（不报错、不写字段）", j.success === true && !("applicantName" in (j.request || {})), "HTTP " + res.status);
  }
  {
    // 生僻字（扩展 B 区）是合法姓名，不能因为正则收得太紧误伤
    const { tok } = await freshUser();
    const res = await submit(tok, { routeId: "r1", duty: "driver", applicantName: "𠮷田" });
    const j = await res.json();
    check("扩展区汉字姓名可提交", j.success === true, "HTTP " + res.status);
  }

  // ============ 五、管理端透出 ============
  console.log("【五】管理端列表透出申请人信息，旧记录给空串");
  {
    const ids = await idx();
    // 造一条旧记录（没有申请人字段），验证兼容
    const legacyId = "req_legacy";
    await setkv("route-request:" + legacyId, { id: legacyId, userId: "u1", routeId: "r1", duty: "driver", status: "pending", createdAt: "2026-01-01T00:00:00Z" });
    await setkv("route-requests:index", JSON.stringify([legacyId, ...ids]));

    await setkv("user:adm9", { id: "adm9", username: "adm9", role: "admin", sessionVersion: 1 });
    await setkv("session:tokAdm9", { userId: "adm9", sessionVersion: 1 });
    const res = await adminReqs.onRequestGet({ request: req("/api/admin/route-requests", "tokAdm9"), env });
    const j = await res.json();
    check("管理端列表返回 success", j.success === true, "HTTP " + res.status);
    const withName = (j.requests || []).find(x => x.applicantName === "张三");
    check("明细带 applicantName", !!withName, "count=" + (j.requests || []).length);
    check("明细带 applicantPhone", !!withName && withName.applicantPhone === "13800138000");
    const legacy = (j.requests || []).find(x => x.id === legacyId);
    check("旧记录 applicantName 为空串（不是 undefined）", legacy && legacy.applicantName === "", JSON.stringify(legacy && legacy.applicantName));
    check("旧记录 applicantPhone 为空串", legacy && legacy.applicantPhone === "");
  }

  // ============ 六、源码红线 ============
  console.log("【六】源码红线：字段贯通到每一层，别只改一边");
  const read = p => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  {
    const api = read("functions/api/route-requests.js");
    check("Lua 脚本写入 applicantName（ARGV[4]）", /ARGV\[4\][^]*applicantName/.test(api));
    check("Lua 脚本写入 applicantPhone（ARGV[5]）", /ARGV\[5\][^]*applicantPhone/.test(api));
    check("EVAL 传了申请人两个值", /id,duty,now,applicantName\.value,applicantPhone\.value/.test(api));
    const page = read("pages/route_apply.html");
    check("页面有「申请人信息（选填）」", page.includes("申请人信息（选填）"));
    check("姓名框 placeholder 为「输入真实姓名」", page.includes('placeholder="输入真实姓名"'));
    check("姓名字段 maxlength=20（与后端一致）", /id="applicantName"[^>]*maxlength="20"/.test(page));
    check("手机号走数字键盘", /id="applicantPhone"[^>]*inputmode="numeric"/.test(page));
    check("提交时按需带字段（空值不塞进 payload）", /if\(applicant\.name\)payload\.applicantName=applicant\.name/.test(page));
    const admin = read("js/admin/requests.js");
    check("管理端标题用 applicantName", /x\.applicantName\?esc\(x\.applicantName\)/.test(admin));
    check("管理端未填时明确提示「未填写姓名」", admin.includes("未填写姓名"));
    const priv = read("pages/privacy.html");
    check("隐私政策披露申请人信息用途", priv.includes("申请人信息（选填）"));
  }

  // ============ 七、管理端渲染（求值真实脚本，不是看正则） ============
  console.log("【七】管理端卡片：有姓名用姓名当标题，没填退回账号名并注明");
  {
    const src = read("js/admin/requests.js");
    const el = { innerHTML: "" };
    const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const A = {
      $: () => el,
      S: {
        requests: [
          { id: "a1", username: "tian860", routeName: "17号线", duty: "driver", applicantName: "张三", applicantPhone: "13800138000" },
          { id: "a2", username: "li777", routeName: "3号线", duty: "delivery", applicantName: "", applicantPhone: "" },
        ],
      },
      esc, rn: v => v, api: async () => ({}),
      toast() {}, open() {}, close() {}, page() {}, sw() {}, closeSwipes() {},
      dlg() {}, dt() {}, dp() {}, db() {}, dc() {}, do_() {},
    };
    new Function("window", "document", src)({ ZPAdmin: A }, { querySelectorAll: () => [] });
    A.renderRequests();
    const html = el.innerHTML;
    check("有姓名时标题用「张三」", html.includes("<strong>张三</strong>"), html.slice(0, 100));
    check("有姓名时显示手机号", html.includes("13800138000"));
    check("没填时标题退回账号名 li777", html.includes("<strong>li777</strong>"));
    check("没填时注明「未填写姓名」", html.includes("未填写姓名"));
    check("副行保留账号名，可回溯（tian860 · 17号线 · 司机）", html.includes("tian860 · 17号线 · 司机"));
  }

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
