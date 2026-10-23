#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 admin.html 其它弹窗（修改密码/新增线路/菜单）在通栏样式下布局正常。"""
import time, threading, http.server, socketserver, os, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); PORT = 8139
class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path.endswith(".html") and os.path.exists(ROOT + path):
            loc = path[:-5] or "/"
            self.send_response(308); self.send_header("Location", loc + ("?" + query if query else "")); self.end_headers(); return
        if path == "/admin": self.path = "/admin.html" + ("?" + query if query else "")
        if path == "/api/me":
            body = json.dumps({"user": {"username": "tianbo", "role": "system_admin"}}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        if path.startswith("/api/"):
            body = json.dumps({}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        return super().do_GET()

socketserver.TCPServer.allow_reuse_address = True
threading.Thread(target=lambda: socketserver.TCPServer(("127.0.0.1", PORT), Q).serve_forever(), daemon=True).start()
time.sleep(0.5)
base = f"http://127.0.0.1:{PORT}"
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome", headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2)
    page = ctx.new_page()
    page.goto(base + "/admin.html", wait_until="domcontentloaded"); page.wait_for_timeout(700)
    # 1) 修改密码弹窗
    page.evaluate("document.getElementById('menuBtn').click()"); page.wait_for_timeout(200)
    page.evaluate("document.getElementById('editPass').click()"); page.wait_for_timeout(300)
    page.screenshot(path="/tmp/dlg-pass.png")
    ov = page.evaluate("(()=>{const d=document.querySelector('#dlg .dialog');const r=d.getBoundingClientRect();return r.width+'x'+r.height+' scroll='+d.scrollHeight+'/'+d.clientHeight})()")
    print("password dialog:", ov)
    page.evaluate("document.getElementById('dc').click()"); page.wait_for_timeout(200)
    # 2) 新增线路弹窗（第2个 tab）
    page.evaluate("document.querySelectorAll('.nav-item')[1].click()"); page.wait_for_timeout(200)
    page.evaluate("document.getElementById('addRoute').click()"); page.wait_for_timeout(300)
    page.screenshot(path="/tmp/dlg-route.png")
    ov = page.evaluate("(()=>{const d=document.querySelector('#dlg .dialog');const r=d.getBoundingClientRect();return r.width+'x'+r.height+' scroll='+d.scrollHeight+'/'+d.clientHeight})()")
    print("route dialog:", ov)
    ctx.close(); browser.close()
print("done")
