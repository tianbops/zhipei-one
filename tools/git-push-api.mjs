#!/usr/bin/env node
/* 智配One · 运维工具：经 Git Data API 推送提交到 GitHub（github.com:443 被阻断时的兜底通道）
   ------------------------------------------------------------------
   背景：沙箱到 github.com:443 间歇性不可达（api.github.com:443 稳定）。
   本脚本用内容寻址方式经 api.github.com 上传 blob/tree/commit 并快进更新 ref，
   产物 SHA 与本地完全一致（author/committer/date/message 逐一照搬），推送后
   远端 main == 本地 HEAD，零分叉、零历史污染。

   用法：
     GITHUB_TOKEN=<token> node tools/git-push-api.mjs [--commit <sha>] [--branch main] [--repo owner/name]

   依赖：本机 git（读取对象）+ Node ≥18（fetch）。
   安全：token 只从环境变量读取，绝不写入文件或日志。
*/
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const get = (name, def) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const TOKEN = process.env.GITHUB_TOKEN || "";
const COMMIT = get("commit", execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
const BRANCH = get("branch", "main");
const REPO = get("repo", "tianbops/zhipei-one");

if (!TOKEN) {
  console.error("缺少 GITHUB_TOKEN（环境变量）。用法：GITHUB_TOKEN=<token> node tools/git-push-api.mjs");
  process.exit(2);
}

const H = { Authorization: "token " + TOKEN, Accept: "application/vnd.github+json" };
const API = `https://api.github.com/repos/${REPO}`;
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { ...H, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return data;
}

const parent = git("rev-parse", `${COMMIT}^`);
const tree = git("rev-parse", `${COMMIT}^{tree}`);
const changed = git("diff-tree", "--no-commit-id", "--name-only", "-r", COMMIT).split("\n").filter(Boolean);

console.log(`commit=${COMMIT.slice(0, 8)} parent=${parent.slice(0, 8)} files=${changed.length} repo=${REPO} branch=${BRANCH}`);

// 1) 上传缺失 blob（内容寻址，SHA 与本地一致）
for (const path of changed) {
  const sha = git("rev-parse", `${COMMIT}:${path}`);
  const content = execFileSync("git", ["cat-file", "blob", sha]);
  const created = await api("POST", "/git/blobs", { content: content.toString("base64"), encoding: "base64" });
  if (created.sha !== sha) throw new Error(`blob SHA 不一致: ${path}`);
  console.log(`blob ok  ${sha.slice(0, 8)}  ${path}`);
}

// 2) 基于父提交树建树（与本地 tree SHA 一致）
const entries = changed.map(p => ({ path: p, mode: "100644", type: "blob", sha: git("rev-parse", `${COMMIT}:${p}`) }));
const treeRes = await api("POST", "/git/trees", { base_tree: git("rev-parse", `${parent}^{tree}`), tree: entries });
if (treeRes.sha !== tree) throw new Error(`tree SHA 不一致: ${treeRes.sha} vs ${tree}`);
console.log(`tree ok  ${tree.slice(0, 8)}`);

// 3) 用与本地一致的 author/committer/date/message 创建提交
const raw = execFileSync("git", ["cat-file", "commit", COMMIT], { encoding: "utf8" });
// git 提交里的日期形如 "<unix秒> +0800"。要还原出同一绝对时刻的 ISO 串：
// 先把 UTC 时刻按偏移换算成「本地墙上时间」，再拼上偏移（GitHub 按绝对时刻解析）。
const isoWithOffset = (tsSec, off) => {
  const sign = off[0] === "-" ? -1 : 1;
  const shiftMin = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
  const d = new Date((tsSec + shiftMin * 60) * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
    `${off.slice(0, 3)}:${off.slice(3)}`;
};
const field = name => {
  const m = raw.match(new RegExp(`^${name} (.+) <(.+)> (\\d+) ([+-]\\d+)$`, "m"));
  return m ? { name: m[1], email: m[2], date: isoWithOffset(Number(m[3]), m[4]) } : null;
};
const message = raw.includes("\n\n") ? raw.slice(raw.indexOf("\n\n") + 2) : "";
const commitRes = await api("POST", "/git/commits", {
  message, tree, parents: [parent], author: field("author"), committer: field("committer"),
});
if (commitRes.sha !== COMMIT) throw new Error(`commit SHA 不一致: ${commitRes.sha} vs ${COMMIT}`);
console.log(`commit ok  ${COMMIT.slice(0, 8)}`);

// 4) 快进更新 ref
const ref = await api("PATCH", `/git/refs/heads/${BRANCH}`, { sha: COMMIT, force: false });
console.log(`ref ok  ${ref.object.sha.slice(0, 8)}  ->  ${BRANCH}`);
console.log("DONE：远端 main == 本地 HEAD，零分叉");
