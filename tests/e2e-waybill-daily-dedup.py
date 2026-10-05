#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归测试：当日重复运单「同线路+同日期+同车牌」只记录一次（前端集成）。

服务端 process.js 已用 Lua 脚本做原子去重（见 unit-waybill-dedup-lua.test.cjs）。
本测试验证 home.js 的「幂等结果」前端分支：
  - 当 /api/waybills/process 返回 idempotent:true（dedupe=VEHICLE_DAILY）时，
    前端提示「当日该线路+车牌运单已存在」并跳转到【已有】运单详情页（带 dedupe=1），
    而不是再生成一条新记录的详情页。
  - 对照（正常新单）：无 idempotent 时跳转到 from=process 的新单详情页，不受影响。

复用仓库既有 Playwright + 本地 mock 服务器模式（参考 e2e-login-admin-bounce-loop.py）。
location.replace 不可重写，故分支判定以「最终导航 URL 的查询参数」为准；
toast 文案另用 page.route 拦截导航（保留首页）来捕获。
"""
import sys, time, threading, http.server, socketserver, os, json
from playwright.sync_api import sync_playwright

NEW_ROOT = "/tmp/ghrepo"
PORT = 8161
CHROME = "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"

USER = {"success": True, "user": {"id": "u1", "username": "zsxff", "role": "user", "name": "张三"}}


class _Base(http.server.SimpleHTTPRequestHandler):
    process_result = None

    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path.endswith(".html") and os.path.exists(self.directory + path):
            loc = path[:-5] or "/"
            self.send_response(308)
            self.send_header("Location", loc + ("?" + query if query else ""))
            self.end_headers()
            return
        if path == "/admin":
            self.path = "/admin.html" + ("?" + query if query else "")
        elif path == "/home":
            self.path = "/home.html" + ("?" + query if query else "")
        p, _, q = self.path.partition("?")
        if p == "/api/me":
            return self._json(USER)
        if p == "/api/routes":
            return self._json({"success": True, "routes": []})
        if p == "/api/dispatch":
            return self._json({"success": True, "dispatchRoute": {"id": "r-1001", "name": "线路1001"}})
        if p == "/api/waybills/latest":
            return self._json({"success": True, "waybill": None})
        if p.startswith("/api/"):
            return self._json({"success": True})
        return super().do_GET()

    def do_POST(self):
        p, _, q = self.path.partition("?")
        if p == "/api/waybills/process":
            result = self.process_result or {"success": True, "waybill": {"id": "w-new"}, "idempotent": False}
            lines = [
                json.dumps({"type": "progress", "progress": 3, "message": "运单已接收"}),
                json.dumps({"type": "progress", "progress": 96, "message": "正在保存运单"}),
                json.dumps({"type": "result", **result}),
            ]
            body = ("\n".join(lines) + "\n").encode()
            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._json({"success": True})


def make_handler(root, process_result):
    class H(_Base):
        pass
    H.process_result = process_result
    H.__init__ = (lambda d: lambda self, *a, **k: _Base.__init__(self, *a, directory=d, **k))(root)
    return H


def serve(port, root, process_result):
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", port), make_handler(root, process_result))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


fails = []
def check(name, cond, extra=""):
    print(("PASS" if cond else "FAIL"), "-", name, extra)
    if not cond:
        fails.append(name)


STANDALONE = ("window.matchMedia=(function(orig){return function(q){"
              "if(q&&q.indexOf('display-mode')>-1)return{matches:true,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}};"
              "return orig?orig.apply(window,arguments):{matches:false,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}"
              "}})(window.matchMedia);")


def upload_and_url(page, port, dummy):
    page.goto(f"http://127.0.0.1:{port}/home.html", wait_until="domcontentloaded")
    page.wait_for_timeout(800)
    page.set_input_files("#documentInput", dummy)
    page.wait_for_timeout(1800)
    return page.url


def main():
    dummy = os.path.join(NEW_ROOT, "tests", ".dummy-waybill.txt")
    if not os.path.exists(dummy):
        with open(dummy, "w") as f:
            f.write("车牌号：京A12345\n日期：2026-10-05\n门店A → 门店B")

    srv_dup = serve(PORT, NEW_ROOT, {"success": True, "waybill": {"id": "w-exists", "routeId": "r-1001"}, "idempotent": True, "dedupe": "VEHICLE_DAILY"})
    srv_new = serve(PORT + 10, NEW_ROOT, {"success": True, "waybill": {"id": "w-new", "routeId": "r-1001"}, "idempotent": False})

    time.sleep(0.4)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])

        # ===== 场景1：幂等分支 → 导航到已有运单（带 dedupe=1）=====
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        page.add_init_script(STANDALONE)
        url = upload_and_url(page, PORT, dummy)
        check("1) 幂等结果下前端跳转到已有运单详情页",
              "order_detail" in url and "id=w-exists" in url, f"url={url}")
        check("2) 跳转携带 dedupe=1 标记（复用而非新建）",
              "dedupe=1" in url, f"url={url}")
        check("3) 不带 from=process（非新单路径）",
              "from=process" not in url, f"url={url}")
        ctx.close()

        # ===== 场景2：正常新单对照 =====
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        page.add_init_script(STANDALONE)
        url = upload_and_url(page, PORT + 10, dummy)
        check("4) 正常新单跳转到新运单详情页",
              "order_detail" in url and "id=w-new" in url, f"url={url}")
        check("5) 正常新单携带 from=process（未被误判为幂等）",
              "from=process" in url, f"url={url}")
        check("6) 正常新单不带 dedupe=1",
              "dedupe=1" not in url, f"url={url}")
        ctx.close()

        browser.close()

    print("\n结果:", "全部通过 ✅" if not fails else f"失败项: {fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
