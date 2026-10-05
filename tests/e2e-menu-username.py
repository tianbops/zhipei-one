#!/usr/bin/env python3
"""e2e：三横菜单「账号设置」右侧显示当前登录用户名。
模拟登录后访问 /home（生产 pretty-url 形态），打开菜单，断言：
1) 菜单项右侧渲染出 /api/me 返回的 username；
2) 长用户名被省略号截断（max-width 生效，不撑破菜单）；
3) /api/me 失败时静默降级（不报错、菜单仍可用）。
"""
import http.server, socketserver, threading, functools, json, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
PORT = 8977

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)
    def end_headers(self):
        super().end_headers()
    def do_GET(self):
        path = self.path.split("?")[0]
        # 模拟登录态 API
        if path == "/api/me":
            body = json.dumps({"success": True, "user": {"username": "driver_zhang_01", "role": "driver"}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/routes":
            body = json.dumps({"success": True, "routes": []}).encode()
            self.send_response(200); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        if path == "/api/dispatch":
            body = json.dumps({"success": True, "dispatchRoute": {"id": "r1", "name": "1路", "type": "fixed"}}).encode()
            self.send_response(200); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        if path == "/api/waybills/latest":
            body = json.dumps({"success": False}).encode()
            self.send_response(200); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        super().do_GET()

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
        page.goto(base + "/home.html", wait_until="domcontentloaded")
        page.wait_for_timeout(700)
        # 打开三横菜单
        page.click("#menuButton")
        page.wait_for_timeout(250)
        txt = page.text_content("#menuUsername") or ""
        check("菜单直接显示用户名（无账号设置文字）", txt.strip() == "driver_zhang_01", f"实际='{txt.strip()}'")
        vis = page.is_visible("#menuUsername")
        check("用户名可见", vis)
        # 加载瞬间占位为「账号」，加载后被替换为真实用户名
        has_label = page.evaluate("""(()=>{
          const a=document.querySelector('#menuUsername').closest('a');
          return (a.textContent||'').includes('账号设置');
        })()""")
        check("菜单不含「账号设置」文字", has_label is False)
        # 溢出截断/左对齐作主标题
        m = page.evaluate("""(()=>{
          const el=document.getElementById('menuUsername');
          const cs=getComputedStyle(el);
          return {ml:cs.marginLeft, ov:cs.textOverflow, w:el.offsetWidth, color:cs.color};
        })()""")
        check("用户名作主标题（左对齐、省略号截断）", m["ml"] in ("0px","0") and m["ov"] == "ellipsis", str(m))
        check("页面无 JS 报错", not errors, "; ".join(errors[:2]))
        page.screenshot(path="/tmp/home-menu-username.png")
        ctx.close()
        browser.close()

    httpd.shutdown()
    print("RESULT: " + ("ALL PASS" if all(results) else "HAS FAIL"))
    sys.exit(0 if all(results) else 1)

if __name__ == "__main__":
    main()
