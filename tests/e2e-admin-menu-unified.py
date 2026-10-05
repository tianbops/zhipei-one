#!/usr/bin/env python3
"""e2e：管理员三横菜单与用户端三横菜单统一风格。
断言：
1) 无「系统设置」标题、无 › 箭头；
2) 首项直接显示管理员用户名（主标题，左对齐、可截断）；
3) 修改密码/重置数据为图标+文字行，退出登录前有分隔线、退出为红色；
4) 点击各项功能仍正常（editUser 打开修改用户名弹窗）；
5) 页面无 JS 报错。
"""
import http.server, socketserver, threading, json, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
PORT = 8979

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)
    def log_message(self, *a): pass
    def do_GET(self):
        path = self.path.split("?")[0]
        def j(obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
        if path == "/api/me":
            return j({"success": True, "user": {"username": "tianbo", "role": "system_admin"}})
        if path == "/api/routes":
            return j({"success": True, "routes": []})
        if path == "/api/admin/users":
            return j({"success": True, "users": [{"username": "tianbo", "route": None}, {"username": "line17", "route": "1路"}]})
        if path == "/api/admin/route-requests":
            return j({"success": True, "requests": []})
        if path == "/api/invite-codes":
            return j({"success": True, "codes": []})
        return super().do_GET()

socketserver.ThreadingTCPServer.allow_reuse_address = True

def main():
    results = []
    def check(name, ok, detail=""):
        results.append(ok)
        print(("PASS" if ok else "FAIL") + " | " + name + (f" | {detail}" if detail else ""))

    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True); t.start()
    base = f"http://127.0.0.1:{PORT}"

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome",
            headless=True, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 412, "height": 915})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "/admin.html", wait_until="domcontentloaded")
        page.wait_for_timeout(900)
        page.click("#menuBtn")
        page.wait_for_timeout(300)

        txt = page.text_content("#menuUsername") or ""
        check("首项直接显示管理员用户名", txt.strip() == "tianbo", f"实际='{txt.strip()}'")
        has_title = page.evaluate("""(()=>{
          const d=document.querySelector('#menuBg .dialog');
          return !!(d.querySelector('h2')||(d.textContent||'').includes('系统设置'));
        })()""")
        check("无「系统设置」标题", has_title is False)
        has_chev = page.evaluate("""(()=>{
          const d=document.querySelector('#menuBg .dialog');
          return !!d.querySelector('.chev');
        })()""")
        check("无 › 箭头", has_chev is False)
        icons = page.evaluate("""(()=>{
          const d=document.querySelector('#menuBg .dialog');
          return d.querySelectorAll('.menu-item-icon svg').length;
        })()""")
        check("四个 SVG 图标行（用户名/改密/重置/退出）", icons == 4, f"实际={icons}")
        divider = page.evaluate("""(()=>{
          const d=document.querySelector('#menuBg .dialog');
          return !!d.querySelector('.menu-divider');
        })()""")
        check("退出登录前有分隔线", divider)
        logout_color = page.evaluate("""(()=>{
          return getComputedStyle(document.getElementById('logout')).color;
        })()""")
        check("退出登录为红色", "255, 130, 120" in logout_color, logout_color)
        # 面板宽度与用户端一致（208px）
        w = page.evaluate("document.querySelector('#menuBg .dialog').offsetWidth")
        check("面板宽度 208px 与用户端一致", w == 208, f"实际={w}")
        page.screenshot(path="/tmp/admin-menu-unified.png")
        # 功能不回归：点击用户名打开修改用户名弹窗
        page.click("#editUser")
        page.wait_for_timeout(300)
        dlg_open = page.evaluate("!document.getElementById('dlg').hidden")
        dlg_title = page.text_content("#dt") or ""
        check("点击用户名仍打开修改用户名弹窗", dlg_open and "修改用户名" in dlg_title, dlg_title)
        check("页面无 JS 报错", not errors, "; ".join(errors[:2]))
        ctx.close(); browser.close()

    httpd.shutdown()
    print("RESULT: " + ("ALL PASS" if all(results) else "HAS FAIL"))
    sys.exit(0 if all(results) else 1)

if __name__ == "__main__":
    main()
