#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断：select 与 input 在弹窗内的尺寸/字号/padding 差异（含聚焦态）。"""
import time, threading, http.server, socketserver, os, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); PORT = 8141
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
    ctx = browser.new_context(viewport={"width": 412, "height": 915})
    page = ctx.new_page()
    page.goto(base + "/admin.html", wait_until="domcontentloaded"); page.wait_for_timeout(700)
    page.evaluate("document.querySelectorAll('.nav-item')[3].click();document.getElementById('addInvite').click()")
    page.wait_for_timeout(300)
    diag = page.evaluate("""(()=>{
      const out=[];
      for(const el of document.querySelectorAll('#dlg .dialog .field select,#dlg .dialog .field input')){
        const r=el.getBoundingClientRect(),cs=getComputedStyle(el);
        out.push({tag:el.tagName,id:el.id,h:Math.round(r.height),w:Math.round(r.width),
          font:cs.fontSize,pad:cs.padding,pt:cs.paddingTop,pb:cs.paddingBottom,
          border:cs.borderWidth,br:cs.borderRadius,lineH:cs.lineHeight,appearance:cs.appearance,
          focusRing:cs.outlineWidth+'/'+cs.outlineColor,boxShadow:cs.boxShadow.slice(0,60)});
      }
      return out;})()""")
    print("未聚焦:", json.dumps(diag, ensure_ascii=False, indent=1))
    # 聚焦数量输入框后再量
    page.focus("#ic")
    diag2 = page.evaluate("""(()=>{
      const el=document.getElementById('ic'),r=el.getBoundingClientRect(),cs=getComputedStyle(el);
      const s=document.querySelector('#dlg .dialog .field select'),rs=s.getBoundingClientRect(),c2=getComputedStyle(s);
      return {inputH:Math.round(r.height),inputFont:cs.fontSize,inputBorder:cs.borderWidth,inputOutline:cs.outlineWidth+' '+cs.outlineOffset,inputShadow:cs.boxShadow.slice(0,80),
              selH:Math.round(rs.height),selFont:c2.fontSize,selBorder:c2.borderWidth};})()""")
    print("聚焦后 input vs select:", json.dumps(diag2, ensure_ascii=False))
    ctx.close(); browser.close()
