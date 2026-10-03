#!/usr/bin/env python3
"""给静态资源引用打版本号，解决发布后仍看到旧页面的问题。

用法：python3 tools/stamp_assets.py [项目根目录]

原理：
  运单类 App 发布后，浏览器 HTTP 缓存（CF Pages 默认 max-age=14400）和
  Service Worker 都可能继续提供旧版 JS/CSS。给资源 URL 追加 ?v=<内容哈希>
  后，URL 随内容变化 —— 任何缓存里都不存在"同 URL 的旧副本"，
  用户下一次打开必然拿到新版本；未改动的资源哈希不变，缓存继续复用。

  - 只处理同域绝对路径的 .css / .js（跳过 sw.js：注册 URL 必须固定）
  - 同一文件重复执行是幂等的：旧 ?v= 会被替换而不是叠加
"""
import hashlib
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_DIRS = [ROOT] + [os.path.join(ROOT, d) for d in ("pages", "admin")]

# 匹配 href="/xxx.css" 或 src="/xxx.js"（允许已带 ?v= 旧版本号，会原位替换；
# 跳过 sw.js：注册 URL 必须固定）
REF = re.compile(r'(href=")(/[A-Za-z0-9_./-]+\.css)(?:\?v=[0-9a-f]*)?(")')
SRC = re.compile(r'(src=")(/[A-Za-z0-9_./-]+\.js)(?:\?v=[0-9a-f]*)?(")')


def stamp_of(path):
    try:
        with open(os.path.join(ROOT, path.lstrip("/")), "rb") as f:
            return hashlib.md5(f.read()).hexdigest()[:8]
    except OSError:
        return None


def rewrite(text):
    changed = 0

    def rep(m):
        nonlocal changed
        pre, url, post = m.group(1), m.group(2), m.group(3)
        base = url.split("?")[0]
        if os.path.basename(base) in ("sw.js",):
            return m.group(0)
        v = stamp_of(base)
        if not v:
            return m.group(0)
        new = f"{pre}{base}?v={v}{post}"
        if new != m.group(0):
            changed += 1
        return new

    out = REF.sub(rep, text)
    out = SRC.sub(rep, out)
    return out, changed


total_files, total_refs = 0, 0
for d in HTML_DIRS:
    if not os.path.isdir(d):
        continue
    for name in sorted(os.listdir(d)):
        if not name.endswith(".html"):
            continue
        p = os.path.join(d, name)
        src = open(p, encoding="utf-8").read()
        out, n = rewrite(src)
        if out != src:
            open(p, "w", encoding="utf-8").write(out)
            total_files += 1
            total_refs += n
            print(f"  更新 {os.path.relpath(p, ROOT)}：{n} 处")

print(f"完成：{total_files} 个页面，{total_refs} 处引用")
