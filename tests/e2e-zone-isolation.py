#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
板块隔离 E2E：管理员端与司机端是两个独立工作区，页面之间不得互相串线。

覆盖（真浏览器 + 真实 history 栈）：
  1) 管理员会话打开业务首页 → 送回管理端
  2) 管理员会话打开业务二级页 → 送回管理端
  3) 司机会话打开业务页 → 正常停留（门禁不得误伤）
  4) 管理端背后压着司机首页时，两次返回 → 不得落在业务首页
  5) 退出登录（/api/me 401）回到登录页 → 清空角色归属，停在登录页
  6) 换司机账号后业务页正常

用法（不计入 npm test 套件，需要本机 chromium）：
  python3 -u tests/e2e-zone-isolation.py
"""
import os
import sys
import json
import time
import threading
import http.server
import socketserver
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("PORT", "8121"))
CHROME = os.environ.get("CHROMIUM", "/usr/bin/chromium")

from playwright.sync_api import sync_playwright  # noqa: E402

role = {"v": "user"}
results = []


def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS ✅ - " if cond else "FAIL ❌ - ") + name + ("   → " + extra if extra else ""), flush=True)


class _Quiet(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), _Quiet)
    httpd.RequestHandlerClass.directory = ROOT if hasattr(httpd.RequestHandlerClass, "directory") else None
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def api_handler(route):
    """按 role 变量返回不同角色；role='anon' 时 /api/me 返回 401（模拟已退出）"""
    url = route.request.url
    p = url.split("/api/", 1)[1].split("?")[0] if "/api/" in url else ""
    if p == "me":
        if role["v"] == "anon":
            return route.fulfill(status=401, content_type="application/json",
                                 body=json.dumps({"error": "unauthorized"}))
        return route.fulfill(status=200, content_type="application/json",
                             body=json.dumps({"success": True, "user": {"id": "u1", "username": "测试", "role": role["v"]}}))
    body = {"success": True}
    if p.startswith("history"):
        body = {"success": True, "history": [], "waybills": []}
    elif p.startswith("base"):
        body = {"success": True, "base": {"stores": [], "version": 1}, "route": {"name": "1号线"}, "canMaintain": True}
    elif p.startswith("dispatch"):
        body = {"success": True, "dispatchRoute": {"id": "r1", "name": "1号线"}}
    elif p.startswith("admin/"):
        body = {"success": True, "users": [], "routes": [], "requests": [], "invites": []}
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def main():
    srv = serve()
    base = f"http://127.0.0.1:{PORT}"
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])

            def new_ctx(browser):
                c = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
                c.route("**/api/**", api_handler)
                try:
                    c.route("**/sw.js", lambda r: r.abort())  # 避免 SW 缓存干扰
                except Exception:
                    pass
                return c

            def open_as(who, path, wait=1200):
                role["v"] = who if who != "anon" else "anon"
                c = new_ctx(browser)
                pg = c.new_page()
                pg.goto(base + "/index.html", wait_until="domcontentloaded")
                pg.wait_for_timeout(300)
                if who != "anon":
                    pg.evaluate(f"sessionStorage.setItem('zpRole','{who}')")
                pg.goto(base + path, wait_until="domcontentloaded")
                pg.wait_for_timeout(wait)
                return c, pg

            # 1) 管理员会话 → 业务首页
            c, pg = open_as("admin", "/home.html", 1500)
            u = urlparse(pg.url).path
            check("1 管理员会话打开业务首页 → 送回管理端", u.startswith("/admin"), f"最终={u}")
            c.close()

            # 2) 管理员会话 → 业务二级页
            c, pg = open_as("admin", "/pages/account.html", 1500)
            u = urlparse(pg.url).path
            check("2 管理员会话打开「我的」页 → 送回管理端", u.startswith("/admin"), f"最终={u}")
            c.close()

            # 3) 司机会话 → 业务首页（不得误伤）
            c, pg = open_as("user", "/home.html")
            u = urlparse(pg.url).path
            check("3 司机会话打开业务首页 → 正常停留", u.startswith("/home"), f"最终={u}")
            c.close()

            # 4) 管理端背后压着司机首页：两次返回不得落在业务首页
            role["v"] = "user"
            c = new_ctx(browser)
            pg = c.new_page()
            pg.goto(base + "/index.html", wait_until="domcontentloaded"); pg.wait_for_timeout(300)
            pg.evaluate("sessionStorage.setItem('zpRole','user')")
            pg.goto(base + "/home.html", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            pg.evaluate("location.href='/pages/account.html?from=home'"); pg.wait_for_timeout(900)
            # 换成管理员并用 replace 进入管理端 —— 制造「admin 底下压着 home」的真实栈
            role["v"] = "admin"
            pg.evaluate("sessionStorage.setItem('zpRole','admin')")
            pg.evaluate("location.replace('/admin.html')"); pg.wait_for_timeout(1500)
            u0 = urlparse(pg.url).path
            check("4-0 已进入管理端（背后压着司机首页）", u0.startswith("/admin"), f"url={u0}")
            pg.evaluate("history.back()"); pg.wait_for_timeout(700)
            check("4-1 第1次返回仍停在管理端", urlparse(pg.url).path.startswith("/admin"), f"url={urlparse(pg.url).path}")
            pg.evaluate("history.back()"); pg.wait_for_timeout(2500)
            u2 = urlparse(pg.url).path
            check("4-2 第2次返回不得落在业务首页", not u2.startswith("/home"), f"最终={u2}")
            c.close()

            # 5) 退出登录 → 登录页清空角色归属
            role["v"] = "anon"
            c = new_ctx(browser)
            pg = c.new_page()
            pg.goto(base + "/index.html", wait_until="domcontentloaded"); pg.wait_for_timeout(300)
            pg.evaluate("sessionStorage.setItem('zpRole','admin')")
            pg.goto(base + "/index.html", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            r = pg.evaluate("sessionStorage.getItem('zpRole')")
            u = urlparse(pg.url).path
            check("5 退出后进登录页 → 清空角色归属且停在登录页", r is None and u.startswith("/index"), f"zpRole={r} url={u}")
            c.close()

            # 6) 换司机账号后业务页正常
            c, pg = open_as("user", "/home.html")
            u = urlparse(pg.url).path
            check("6 换司机账号后业务页正常", u.startswith("/home"), f"最终={u}")
            c.close()

            browser.close()
    finally:
        srv.shutdown()

    failed = [n for n, ok in results if not ok]
    print("\n" + "=" * 64)
    if failed:
        print(f"板块隔离 E2E 结果: 失败 {len(failed)} 项: {failed}")
        sys.exit(1)
    print("板块隔离 E2E 结果: 全部通过 ✅")


if __name__ == "__main__":
    main()
