#!/usr/bin/env python3
"""静态资源版本号刷新 + Service Worker 预缓存重建 + SW 版本递增。

用法：python3 scripts/bump_asset_versions.py [--no-bump]

为什么需要（2026-10 反复踩过的坑）：
  - 改完 CSS/JS 只提交不够：浏览器 HTTP 缓存（CF Pages max-age=14400）与
    Service Worker 都会继续提供旧版文件，用户看不到修复；
  - sw.js 的 PRECACHE 靠手维护，漏一条 = 离线首开缺资源、多一条 = 预缓存 404 噪音，
    且 tests/sw-precache.test.mjs 会因不一致而红；
  - SW VERSION 不递增 = 已安装旧 SW 的用户永远等不到 activate 里的强制刷新。

本脚本把三件事一次做对（deploy.sh 的 stamp() 即调用它）：
  1. 调 tools/stamp_assets.py 刷 HTML 里 .css/.js 引用的 ?v=<内容 md5[:8]>；
  2. 刷 HTML 里**已带** ?v= 的 /assets/ 引用（logo.webp 等 stamp 不管的；
     不带 ?v= 的引用<如 apple-touch-icon>不动，保持纯资产身份）；
  3. 依据 HTML 真实引用（带 ?v= 的进版本化集）+ manifest.json 图标（纯资产集）
     重建 sw.js 的 PRECACHE 块（壳页 → 版本化字典序 → 纯资产字典序），
     并递增 zp-pwa-NN。

幂等性：第 1、2 步重复执行结果相同（?v= 原位替换不叠加）；
PRECACHE 重建是确定性的（同输入同输出）。仅 VERSION 递增不可逆——那是发布动作。
"""
import hashlib
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW = os.path.join(ROOT, "sw.js")
MANIFEST = os.path.join(ROOT, "manifest.json")

# 壳页面（App 骨架 + 司机高频页）：固定顺序置顶，不参与字典序
SHELL_PAGES = [
    "/", "/home", "/pages/today", "/pages/dispatch", "/pages/history",
    "/pages/route_apply", "/pages/account", "/register", "/offline",
]

# HTML 引用：((href|src)=") 前缀 / 路径 / (?v= 可选) / 结束引号
REF = re.compile(r'((?:href|src)=")(/(?:css|js|assets)/[A-Za-z0-9_./-]+?)(\?v=[A-Za-z0-9_.-]*)?(")')
# 二进制/图片类资产扩展名（第 2 步只刷这些已带 ?v= 的引用）
ASSET_EXT = (".webp", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".gif", ".woff", ".woff2")
# manifest 图标："src": "/assets/..."（纯资产，不带 ?v=）
ICON = re.compile(r'"src"\s*:\s*"(/assets/[A-Za-z0-9_./-]+)"')
# HTML apple-touch-icon：<link rel="apple-touch-icon" href="/assets/...">（纯资产，不带 ?v=）
APPLE_ICON = re.compile(r'rel="apple-touch-icon"[^>]*href="(/assets/[A-Za-z0-9_./-]+)"|href="(/assets/[A-Za-z0-9_./-]+)"[^>]*rel="apple-touch-icon"')

PRECACHE_BLOCK = re.compile(r"(const PRECACHE = \[)[\s\S]*?(\];)")
VERSION_LINE = re.compile(r'(const VERSION = "zp-pwa-)(\d+)(";)')


def md5_of(rel):
    try:
        with open(os.path.join(ROOT, rel.lstrip("/")), "rb") as f:
            return hashlib.md5(f.read()).hexdigest()[:8]
    except OSError:
        return None


def html_files():
    dirs = [ROOT, os.path.join(ROOT, "pages")]
    admin = os.path.join(ROOT, "admin")
    if os.path.isdir(admin):
        dirs.append(admin)
    out = []
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.endswith(".html"):
                out.append(os.path.join(d, name))
    return out


def step1_stamp():
    print("==> 1/3 刷新 HTML 中 .css/.js 引用的 ?v=")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "stamp_assets.py")],
                       capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        raise SystemExit("✗ stamp_assets.py 失败")


def step2_refresh_assets():
    """刷 HTML 里**已带** ?v= 的 /assets/ 引用（stamp_assets.py 只处理 .css/.js）。
    不带 ?v= 的引用（如 apple-touch-icon）保持原样——它们是纯资产，不该版本化。"""
    print("==> 2/3 刷新 HTML 中已带 ?v= 的 /assets/ 引用")
    changed = 0
    for p in html_files():
        src = open(p, encoding="utf-8").read()

        def rep(m):
            nonlocal changed
            pre, url, q, post = m.group(1), m.group(2), m.group(3), m.group(4)
            if not q or not url.lower().endswith(ASSET_EXT):
                return m.group(0)  # 没带 ?v= 或非资产：不动
            v = md5_of(url)
            if not v:
                return m.group(0)
            new = f"{pre}{url}?v={v}{post}"
            if new != m.group(0):
                changed += 1
            return new

        out = REF.sub(rep, src)
        if out != src:
            open(p, "w", encoding="utf-8").write(out)
            print(f"  更新 {os.path.relpath(p, ROOT)}")
    print(f"  /assets/ 引用刷新 {changed} 处")


def step3_rebuild_precache():
    """从 HTML 真实引用（带 ?v= → 版本化集）+ HTML apple-touch-icon 与 manifest 图标
    （纯资产集）重建 PRECACHE。"""
    print("==> 3/3 重建 sw.js PRECACHE")
    versioned, plain = set(), set()
    for p in html_files():
        text = open(p, encoding="utf-8").read()
        for m in REF.finditer(text):
            url, q = m.group(2), m.group(3)
            if not q:
                continue  # HTML 引用没带 ?v=（如 apple-touch-icon）：不进版本化集
            if md5_of(url) is None:
                continue  # 文件不存在：跳过（避免预缓存 404）
            versioned.add(url + q)
        for m in APPLE_ICON.finditer(text):
            plain.add(m.group(1) or m.group(2))
    manifest = open(MANIFEST, encoding="utf-8").read()
    for m in ICON.finditer(manifest):
        plain.add(m.group(1))

    lines = [f'  "{p}",' for p in SHELL_PAGES]
    lines += [f'  "{p}",' for p in sorted(versioned)]
    lines += [f'  "{p}",' for p in sorted(plain)]
    entries = "\n".join(lines)

    sw = open(SW, encoding="utf-8").read()
    if "/* PRECACHE-BEGIN */" not in sw or "/* PRECACHE-END */" not in sw:
        raise SystemExit("✗ sw.js 缺少 PRECACHE-BEGIN/END 标记")
    new_sw, n = PRECACHE_BLOCK.subn(lambda m: m.group(1) + "\n" + entries + "\n" + m.group(2), sw, count=1)
    if n != 1:
        raise SystemExit("✗ sw.js PRECACHE 块替换失败（未匹配或匹配多处）")
    if new_sw != sw:
        open(SW, "w", encoding="utf-8").write(new_sw)
    print(f"  PRECACHE：壳页 {len(SHELL_PAGES)} + 版本化 {len(versioned)} + 纯资产 {len(plain)}"
          f"（共 {len(SHELL_PAGES) + len(versioned) + len(plain)} 条）")


def bump_version():
    sw = open(SW, encoding="utf-8").read()
    m = VERSION_LINE.search(sw)
    if not m:
        raise SystemExit("✗ sw.js 找不到 VERSION 行")
    old, new = m.group(2), str(int(m.group(2)) + 1)
    open(SW, "w", encoding="utf-8").write(VERSION_LINE.sub(lambda mm: mm.group(1) + new + mm.group(3), sw, count=1))
    print(f"  SW VERSION：zp-pwa-{old} → zp-pwa-{new}")


if __name__ == "__main__":
    no_bump = "--no-bump" in sys.argv
    step1_stamp()
    step2_refresh_assets()
    step3_rebuild_precache()
    if not no_bump:
        bump_version()
    else:
        print("  --no-bump：跳过 VERSION 递增")
    print("完成")
