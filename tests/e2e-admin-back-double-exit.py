#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端验证：独立 PWA 管理员页「两次返回退出」行为（干净流程：admin 即栈底）。
   断言：
     A) 进入管理员页即安装守卫（history.length>=2，背后无首页）。
     B) 控制器状态机：第一次调用=exit-armed（并弹提示），第二次=exit（真正退出）。
     C) 第一次系统返回：页面不变（仍在 /admin.html），弹出「再按一次退出」。
     D) 第二次系统返回：离开管理员页（交由系统退回手机桌面）。
"""
import sys, time, threading, http.server, socketserver
from playwright.sync_api import sync_playwright

ROOT = "/tmp/ghrepo"
PORT = 8124

class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a):
        pass

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
        # 模拟桌面图标独立 PWA：display-mode=standalone
        page.add_init_script(
            "window.matchMedia=(function(orig){return function(q){"
            "if(q&&q.indexOf('display-mode')>-1)return{matches:true,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}};"
            "return orig?orig.apply(window,arguments):{matches:false,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}"
            "}})(window.matchMedia);")
        page.goto(base + "/admin.html", wait_until="domcontentloaded")
        page.wait_for_timeout(600)

        # A) 守卫已安装
        hl = page.evaluate("history.length")
        has_ctrl = page.evaluate("typeof window.zpHandleBack==='function'")
        check("进入管理员页安装守卫 history.length>=2（背后无首页）", hl >= 2, f"实际={hl}")
        check("中央返回控制器 zpHandleBack 已挂载", has_ctrl)

        # B) 控制器状态机（在 armed=false 的干净状态下直接调用两次）
        seq = page.evaluate("(async()=>{const a=await window.zpHandleBack();const b=await window.zpHandleBack();return [a,b]})()")
        toast_txt = page.evaluate("(()=>{const t=document.getElementById('zpToast');return t?t.textContent:''})()")
        check("状态机：第一次=exit-armed，第二次=exit",
              isinstance(seq, list) and seq[0] == "exit-armed" and seq[1] == "exit", f"实际={seq}")
        check("第一次调用即弹出提示词「再按一次退出」", toast_txt.strip() == "再按一次退出", f"实际='{toast_txt}'")

        # 复位 armed 标记，回到干净状态做真实手势测试
        page.evaluate("(function(){try{sessionStorage.removeItem('zpExitAdmin')}catch(e){};location.reload();})()")
        page.wait_for_timeout(700)

        # C) 第一次系统返回（真实 history.back 模拟左滑）
        page.evaluate("history.back()")
        page.wait_for_timeout(400)
        path1 = page.evaluate("location.pathname")
        toast1 = page.evaluate("(()=>{const t=document.getElementById('zpToast');return t?(t.textContent+'|'+t.classList.contains('show')):''})()")
        check("第一次返回页面不变（仍在 /admin.html）", path1 == "/admin.html", f"实际={path1}")
        check("第一次返回弹出「再按一次退出」且显示", toast1.startswith("再按一次退出|true"), f"实际='{toast1}'")

        # D) 第二次系统返回（真实 history.back）：离开管理员页 → 退回桌面
        page.evaluate("history.back()")
        page.wait_for_timeout(500)
        path2 = page.evaluate("location.pathname")
        check("第二次返回已离开管理员页（交由系统退出到桌面）", path2 != "/admin.html", f"实际={path2}")

        browser.close()
    print("\n结果:", "全部通过 ✅" if not fails else f"失败项: {fails}")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
