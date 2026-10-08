#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""复现管理员「生成邀请码」弹窗布局：打开邀请码 tab → 点 + → 截图 + 诊断布局指标。"""
import time, threading, http.server, socketserver, os, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8137

class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)
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
        if path.startswith("/api/invite-codes"):
            body = json.dumps({"codes": [{"code": "ZP-AB12CD", "usedCount": 0, "maxUses": 1, "expiresAt": None}]}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        if path.startswith("/api/"):
            body = json.dumps({}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        return super().do_GET()

def serve():
    socketserver.TCPServer.allow_reuse_address = True
    socketserver.TCPServer(("127.0.0.1", PORT), Q).serve_forever()

threading.Thread(target=serve, daemon=True).start(); time.sleep(0.5)
base = f"http://127.0.0.1:{PORT}"
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome", headless=True, args=["--no-sandbox"])
    for (w, h, tag) in [(360, 800, "360x800"), (412, 915, "412x915")]:
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2)
        page = ctx.new_page()
        page.goto(base + "/admin.html", wait_until="domcontentloaded")
        page.wait_for_timeout(700)
        # 切到邀请码 tab 并打开弹窗
        page.evaluate("document.querySelectorAll('.tab')[3].click()")
        page.wait_for_timeout(200)
        page.evaluate("document.getElementById('addInvite').click()")
        page.wait_for_timeout(300)
        page.screenshot(path=f"/tmp/invite-{tag}.png")
        diag = page.evaluate("""(()=>{
          const d=document.querySelector('#dlg .dialog'),bg=document.getElementById('dlg');
          const r=d.getBoundingClientRect();
          const cs=getComputedStyle(d);
          const flds=[...d.querySelectorAll('.field')].map(f=>{const fr=f.getBoundingClientRect();const csel=f.querySelector('select'),cin=f.querySelector('input');const el=csel||cin;const er=el?el.getBoundingClientRect():null;return {w:Math.round(fr.width),h:Math.round(fr.height),ctlW:er?Math.round(er.width):null,display:getComputedStyle(f).display};});
          return {vw:innerWidth,vh:innerHeight,dlg:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
            bgDisplay:getComputedStyle(bg).display,bgPos:getComputedStyle(bg).position,align:cs.alignItems,justify:cs.justifyContent,
            overflowY:cs.overflowY,scrollH:d.scrollHeight,clientH:d.clientHeight,fields:flds};})()""")
        print(tag, json.dumps(diag, ensure_ascii=False))
        ctx.close()
    browser.close()
print("done")
