#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归测试：Cloudflare Pages pretty-URL 308 重定向下的管理员双段返回。
   生产环境会把 /admin.html 308 到 /admin、/home.html 308 到 /home，
   导致 2026-10-05 事故：ui-unified 用 /^\\/admin\\.html$/ 判定区间失败，
   管理员页被当成业务页，第一次左滑直接 location.replace('/home.html')
   穿越到司机首页（且无任何提示）。
   本测试本地服务器复现同样的 308，断言：
     A) /admin.html 被 308 到 /admin（复现生产环境）。
     B) 管理员页区间被正确识别（走「工作区根两次返回退出」分支）。
     C) 第一次系统返回：停在 /admin，弹「再按一次退出」。
     D) 第二次系统返回：离开（交由系统退桌面）。
     E) 司机首页 /home 同样双段返回（第一次提示、第二次退出）。
"""
import sys, os, time, threading, http.server, socketserver, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8131

class Q(http.server.SimpleHTTPRequestHandler):
    """复现 Cloudflare Pages pretty URL：/xxx.html → 308 → /xxx（保留 query）"""
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a):
        pass
    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path.endswith(".html") and os.path.exists(ROOT + path):
            loc = path[:-5] or "/"
            self.send_response(308)
            self.send_header("Location", loc + ("?" + query if query else ""))
            self.end_headers()
            return
        if path == "/admin" :
            self.path = "/admin.html" + ("?" + query if query else "")
        elif path == "/home":
            self.path = "/home.html" + ("?" + query if query else "")
        return super().do_GET()

def serve():
    socketserver.TCPServer.allow_reuse_address = True
    socketserver.TCPServer(("127.0.0.1", PORT), Q).serve_forever()

fails = []
def check(name, cond, extra=""):
    print(("PASS" if cond else "FAIL"), "-", name, extra)
    if not cond:
        fails.append(name)

def main():
    threading.Thread(target=serve, daemon=True).start()
    time.sleep(0.5)
    base = f"http://127.0.0.1:{PORT}"
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome",
            headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        page.add_init_script(
            "window.matchMedia=(function(orig){return function(q){"
            "if(q&&q.indexOf('display-mode')>-1)return{matches:true,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}};"
            "return orig?orig.apply(window,arguments):{matches:false,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}"
            "}})(window.matchMedia);")

        # ===== 管理员端 =====
        page.goto(base + "/admin.html", wait_until="domcontentloaded")
        page.wait_for_timeout(600)
        path0 = page.evaluate("location.pathname")
        check("A) /admin.html 被 308 到 /admin（复现生产 pretty URL）", path0 == "/admin", f"实际={path0}")
        check("B) 管理员页已装中央返回控制器", page.evaluate("typeof window.zpHandleBack==='function'"))
        hl = page.evaluate("history.length")
        check("B2) 守卫占位已压入 history.length>=2", hl >= 2, f"实际={hl}")

        # C) 第一次系统返回
        page.evaluate("history.back()")
        page.wait_for_timeout(400)
        path1 = page.evaluate("location.pathname")
        toast1 = page.evaluate("(()=>{const t=document.getElementById('zpToast');return t?(t.textContent+'|'+t.classList.contains('show')):''})()")
        check("C) 第一次返回停在 /admin 且弹「再按一次退出」",
              path1 == "/admin" and toast1.startswith("再按一次退出|true"), f"实际 path={path1} toast='{toast1}'")

        # D) 第二次系统返回 → 离开
        page.evaluate("history.back()")
        page.wait_for_timeout(500)
        path2 = page.evaluate("location.pathname")
        check("D) 第二次返回已离开管理员页（交由系统退桌面）", path2 != "/admin", f"实际={path2}")

        # ===== 司机端首页（同样被 308 到 /home）—— 上一步导航已销毁文档，开新页面 =====
        page = ctx.new_page()
        page.add_init_script(
            "window.matchMedia=(function(orig){return function(q){"
            "if(q&&q.indexOf('display-mode')>-1)return{matches:true,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}};"
            "return orig?orig.apply(window,arguments):{matches:false,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}"
            "}})(window.matchMedia);")
        page.goto(base + "/home.html", wait_until="domcontentloaded")
        page.wait_for_timeout(600)
        path3 = page.evaluate("location.pathname")
        check("E1) /home.html 被 308 到 /home", path3 == "/home", f"实际={path3}")
        page.evaluate("history.back()")
        page.wait_for_timeout(400)
        path4 = page.evaluate("location.pathname")
        toast2 = page.evaluate("(()=>{const t=document.getElementById('zpToast');return t?(t.textContent+'|'+t.classList.contains('show')):''})()")
        check("E2) 首页第一次返回停在 /home 且弹「再按一次退出」",
              path4 == "/home" and toast2.startswith("再按一次退出|true"), f"实际 path={path4} toast='{toast2}'")
        page.evaluate("history.back()")
        page.wait_for_timeout(500)
        path5 = page.evaluate("location.pathname")
        check("E3) 首页第二次返回已离开（退桌面）", path5 != "/home", f"实际={path5}")

        browser.close()
    print("\n结果:", "全部通过 ✅" if not fails else f"失败项: {fails}")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
