#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P0-1 全局返回体系 · 真浏览器 E2E 验收
================================================================
运行：python3 -u tests/e2e-p0-return-flows.py
依赖：playwright（chromium-1208，已装）

覆盖《项目总控 P0-1 返回体系验收清单》：
  A1 首页 → 今日运单 → 返回首页
  A2 首页 → 历史查询 → 某日 → 详情 → 返回历史
  A3 规划(上传) → 详情 → 返回首页（from=process 返回解析）
  A4 详情 → 数据资料 → 返回原详情（同一张运单 id 必须保留）
  B1 管理员加载（admin 角色）
  B2 ☰系统设置 → 子页(修改密码) → 返回系统设置 → 返回管理员工作台（两步返回）
  B3 管理员根「两次返回退出」：首次返回武装、不离开
  C1 今日页：顶部返回 与 系统返回(popstate) 等价
  C2 历史详情：顶部返回 与 系统返回 等价
  D1 首页上传 Bottom Sheet → 返回先关 Sheet
  D2 首页三横菜单 Drawer → 返回先关 Drawer
  D3 详情页菜单 Drawer → 返回先关 Drawer
  D4 全局确认框 Dialog(rank5) → 返回先关 Dialog
  D5 管理员 子对话框 Dialog(rank10) → 返回先关 Dialog（抽屉仍开）
  D6 管理员 系统设置 Drawer(rank20) → 返回先关 Drawer
  E1 管理员端 from=home 不得回落业务首页
  E2 业务端 from=admin 不得进入管理端

mock 策略：本地静态服务器（复用仓库 308 pretty-URL 模式）+ 拦截 /api/* 返回罐头 JSON；
屏蔽 Service Worker（sw.js 404）避免缓存/拦截干扰；注入 display-mode:standalone 模拟 PWA。
"""
import sys, os, json, time, threading, http.server, socketserver
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = "/tmp/ghrepo"
PORT = 8188
CHROME = "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"

WAYBILL = {
    "id": "w-test", "date": "2026-10-05", "routeId": "r1", "routeName": "1号线",
    "vehicle": "京A12345", "totalWeight": 1.20,
    "summary": {"total": 2, "original": 2},
    "stores": [
        {"name": "门店甲", "rawName": "门店甲"},
        {"name": "门店乙", "pending": True, "rawName": "门店乙?"},
    ],
}
HISTORY_DATE = "2026-10-02"


class _Base(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

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

    def _serve_file(self, fs_path):
        try:
            with open(fs_path, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404, "not found: " + fs_path)
            return
        ext = os.path.splitext(fs_path)[1]
        ct = {
            ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
            ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
            ".txt": "text/plain; charset=utf-8",
        }.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("content-type", ct)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path.endswith(".html") and os.path.exists(self.directory + path):
            loc = path[:-5] or "/"
            self.send_response(308)
            self.send_header("Location", loc + ("?" + query if query else ""))
            self.end_headers()
            return
        if path == "/sw.js":
            self.send_response(404); self.end_headers(); return
        p = path
        if p == "/api/me":
            referer = self.headers.get("referer", "")
            if "/admin" in referer:
                return self._json({"success": True, "user": {"id": "a1", "username": "管理员", "role": "admin"}})
            return self._json({"success": True, "user": {"id": "u1", "username": "司机", "role": "user"}})
        if p == "/api/routes":
            return self._json({"success": True, "routes": []})
        if p == "/api/dispatch":
            return self._json({"success": True, "dispatchRoute": {"id": "r1", "name": "1号线"}})
        if p == "/api/waybills/latest":
            return self._json({"success": True, "waybill": WAYBILL})
        if p == "/api/waybills/confirm":
            return self._json({"success": True, "waybill": WAYBILL})
        if p == "/api/base":
            return self._json({"success": True, "base": {"stores": [
                {"name": "门店甲", "routeOrder": 1}, {"name": "门店乙", "routeOrder": 2}]},
                "route": {"name": "1号线"}, "canMaintain": True, "version": 1})
        if p == "/api/history":
            qs = parse_qs(query)
            if "date" in qs:
                return self._json({"success": True, "waybills": [dict(WAYBILL, id="w-h", date=qs["date"][0])]})
            return self._json({"success": True, "history": [
                {"date": HISTORY_DATE, "count": 1, "storeCount": 1, "totalWeight": 1.2}
            ], "range": {"start": "2026-01-01", "end": "2026-10-05"}})
        if p == "/api/admin/users":
            return self._json({"success": True, "users": []})
        if p == "/api/admin/route-requests":
            return self._json({"success": True, "requests": []})
        if p == "/api/invite-codes":
            return self._json({"success": True, "codes": []})
        if p.startswith("/api/"):
            return self._json({"success": True})
        cand = self.directory + path
        if os.path.isfile(cand):
            return self._serve_file(cand)
        if os.path.isfile(cand + ".html"):
            return self._serve_file(cand + ".html")
        if path in ("/admin", "/home") and os.path.isfile(self.directory + path + ".html"):
            return self._serve_file(self.directory + path + ".html")
        self.send_error(404, "not found: " + path)

    def do_POST(self):
        p, _, q = self.path.partition("?")
        if p.startswith("/api/"):
            return self._json({"success": True})
        self.send_error(404)


def make_handler(root):
    class H(_Base):
        pass
    H.__init__ = (lambda d: lambda self, *a, **k: _Base.__init__(self, *a, directory=d, **k))(root)
    return H


def serve(port, root):
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", port), make_handler(root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


STANDALONE = ("window.matchMedia=(function(orig){return function(q){"
              "if(q&&q.indexOf('display-mode')>-1)return{matches:true,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}};"
              "return orig?orig.apply(window,arguments):{matches:false,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}"
              "}})(window.matchMedia);")

fails = []
_LAST = {"name": "init"}


def mark(step):
    _LAST["name"] = step
    print(f"--- {step} ---", flush=True)


def check(name, cond, extra=""):
    print(("PASS ✅" if cond else "FAIL ❌"), "-", name, (("  → " + extra) if extra else ""), flush=True)
    if not cond:
        fails.append(name)


def watchdog():
    t0 = time.time()
    while time.time() - t0 < 150:
        time.sleep(5)
        print(f"[watchdog {int(time.time()-t0)}s] at={_LAST['name']}", flush=True)
    print(f"[watchdog] TIMEOUT at={_LAST['name']}", flush=True)
    os._exit(2)


def p_url(page):
    u = urlparse(page.url)
    return u.path + ("?" + u.query if u.query else "")


def back(page, wait=500):
    page.evaluate("window.zpHandleBack()")
    page.wait_for_timeout(wait)
    return p_url(page)


def sys_back(page, wait=500):
    page.evaluate("history.back()")
    page.wait_for_timeout(wait)
    return p_url(page)


def run(browser, base, name, fn):
    mark(name)
    try:
        fn(browser, base)
    except Exception as e:
        check(name, False, "EXCEPTION: " + repr(e)[:200])
        import traceback
        traceback.print_exc()


def main():
    threading.Thread(target=watchdog, daemon=True).start()
    srv = serve(PORT, ROOT)
    time.sleep(0.4)
    base = f"http://127.0.0.1:{PORT}"

    def ctx(browser):
        c = browser.new_context(viewport={"width": 390, "height": 844})
        pg = c.new_page()
        pg.set_default_timeout(8000)
        pg.set_default_navigation_timeout(10000)
        pg.add_init_script(STANDALONE)
        return c, pg

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])

        # ---- A. 业务端导航-返回 ----
        def a1(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            pg.click("a[href*='today.html?from=home']"); pg.wait_for_timeout(700)
            check("A1-1 首页→今日运单 到达 /pages/today", p_url(pg).startswith("/pages/today"), p_url(pg))
            u = back(pg)
            check("A1-2 今日运单→返回 回到首页 /home", u.startswith("/home") and "today" not in u, u)
            c.close()
        run(browser, base, "A1", a1)

        def a2(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            pg.click("a[href*='history.html?from=home']"); pg.wait_for_timeout(700)
            check("A2-1 首页→历史查询 到达 /pages/history", p_url(pg).startswith("/pages/history"), p_url(pg))
            pg.click(".history-date-main"); pg.wait_for_timeout(800)
            check("A2-2 历史→某日 到达详情(from=history)",
                  "order_detail" in p_url(pg) and "from=history" in p_url(pg), p_url(pg))
            u = back(pg)
            check("A2-3 详情→返回 回到历史列表 /pages/history", u.startswith("/pages/history"), u)
            c.close()
        run(browser, base, "A2", a2)

        def a3(b, base):
            c, pg = ctx(b); pg.goto(base + "/pages/order_detail?id=w-test&source=process&from=process", wait_until="domcontentloaded"); pg.wait_for_timeout(800)
            check("A3-1 详情(from=process) 已加载", "order_detail" in p_url(pg) and "from=process" in p_url(pg), p_url(pg))
            u = back(pg)
            check("A3-2 详情→返回 回到首页 /home(process 口径)", u.startswith("/home") and "order_detail" not in u, u)
            c.close()
        run(browser, base, "A3", a3)

        def a4(b, base):
            c, pg = ctx(b); pg.goto(base + "/pages/order_detail?id=w-test&source=process&from=process", wait_until="domcontentloaded"); pg.wait_for_timeout(800)
            pg.click("#menuBtn"); pg.wait_for_timeout(300)
            pg.click("#editRouteBtn"); pg.wait_for_timeout(800)
            check("A4-1 详情→数据中心 到达 /pages/data?from=order&id=w-test",
                  p_url(pg).startswith("/pages/data") and "from=order" in p_url(pg) and "id=w-test" in p_url(pg), p_url(pg))
            u = back(pg)
            check("A4-2 数据→返回 必须回到原运单 /pages/order_detail?id=w-test&from=process",
                  "order_detail" in u and "id=w-test" in u and "from=process" in u and "data" not in u, u)
            c.close()
        run(browser, base, "A4", a4)

        # ---- B. 管理员端 ----
        def b1(b, base):
            c, pg = ctx(b); pg.goto(base + "/admin", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            who = pg.text_content("#who", timeout=3000) if pg.query_selector("#who") else ""
            tabs = pg.query_selector_all(".tab")
            check("B1 管理员端加载为 admin 工作区（含4个面板tab）", "管理员" in (who or "") and len(tabs) == 4, f"who={who} tabs={len(tabs)}")
            c.close()
        run(browser, base, "B1", b1)

        def b2(b, base):
            c, pg = ctx(b); pg.goto(base + "/admin", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            pg.click("#menuBtn"); pg.wait_for_timeout(300)
            drawer_open = pg.evaluate("!document.getElementById('menuBg').hidden")
            check("B2-1 ☰ 打开系统设置抽屉", drawer_open, f"menuBg.hidden={not drawer_open}")
            pg.click("#editPass"); pg.wait_for_timeout(300)
            dlg_open = pg.evaluate("!document.getElementById('dlg').hidden")
            drawer_while_dlg = pg.evaluate("!document.getElementById('menuBg').hidden")
            check("B2-2 打开子页(修改密码) → 子对话框出现、系统设置抽屉仍开", dlg_open and drawer_while_dlg, f"dlg={dlg_open} drawer={drawer_while_dlg}")
            back(pg)
            dlg_after = pg.evaluate("!document.getElementById('dlg').hidden")
            drawer_after_back = pg.evaluate("!document.getElementById('menuBg').hidden")
            check("B2-3 子对话框返回 → 关闭对话框、系统设置抽屉仍开（两步返回成立）",
                  (not dlg_after) and drawer_after_back, f"dlg={not dlg_after} drawer={drawer_after_back}")
            back(pg)
            drawer_final = pg.evaluate("!document.getElementById('menuBg').hidden")
            check("B2-4 系统设置返回 → 关闭抽屉、留在管理员工作台",
                  (not drawer_final) and p_url(pg).startswith("/admin"), f"drawer={drawer_final} url={p_url(pg)}")
            c.close()
        run(browser, base, "B2", b2)

        def b3(b, base):
            c, pg = ctx(b); pg.goto(base + "/admin", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            r = pg.evaluate("window.zpHandleBack()")
            pg.wait_for_timeout(300)
            check("B3-1 管理员根首次返回 = exit-armed（不离开）", r == "exit-armed" and p_url(pg).startswith("/admin"), f"r={r} url={p_url(pg)}")
            c.close()
        run(browser, base, "B3", b3)

        # ---- C. 顶部返回 = Android 返回 等价 ----
        def c1(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            pg.click("a[href*='today.html?from=home']"); pg.wait_for_timeout(700)
            pg.click("#backBtn"); pg.wait_for_timeout(500)
            click_url = p_url(pg)
            c.close()
            c2, pg2 = ctx(b); pg2.goto(base + "/home", wait_until="domcontentloaded"); pg2.wait_for_timeout(700)
            pg2.click("a[href*='today.html?from=home']"); pg2.wait_for_timeout(700)
            sys_url = sys_back(pg2)
            c2.close()
            check("C1 今日页：顶部返回 与 系统返回 等价（均回到 /home）",
                  urlparse(click_url).path == "/home" and urlparse(sys_url).path == "/home",
                  f"click={click_url} sys={sys_url}")
        run(browser, base, "C1", c1)

        def c2(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            pg.click("a[href*='history.html?from=home']"); pg.wait_for_timeout(700)
            pg.click(".history-date-main"); pg.wait_for_timeout(800)
            pg.click("#backBtn"); pg.wait_for_timeout(500)
            click_url = p_url(pg)
            c.close()
            c2, pg2 = ctx(b); pg2.goto(base + "/home", wait_until="domcontentloaded"); pg2.wait_for_timeout(700)
            pg2.click("a[href*='history.html?from=home']"); pg2.wait_for_timeout(700)
            pg2.click(".history-date-main"); pg2.wait_for_timeout(800)
            sys_url = sys_back(pg2)
            c2.close()
            check("C2 历史详情：顶部返回 与 系统返回 等价（均回到 /pages/history）",
                  urlparse(click_url).path == "/pages/history" and urlparse(sys_url).path == "/pages/history",
                  f"click={click_url} sys={sys_url}")
        run(browser, base, "C2", c2)

        # ---- D. 返回层级 ladder ----
        def d1(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            pg.click("#uploadAction"); pg.wait_for_timeout(300)
            sheet_open = pg.evaluate("!document.getElementById('uploadArea').hidden")
            check("D1-1 首页上传 Bottom Sheet 打开", sheet_open, f"hidden={not sheet_open}")
            u = back(pg)
            sheet_after = pg.evaluate("!document.getElementById('uploadArea').hidden")
            check("D1-2 返回先关闭 Sheet（不离开首页）", (not sheet_after) and u.startswith("/home"), f"sheet={not sheet_after} url={u}")
            c.close()
        run(browser, base, "D1", d1)

        def d2(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            pg.click("#menuButton"); pg.wait_for_timeout(300)
            drawer_open = pg.evaluate("!document.getElementById('menuPanel').hidden")
            check("D2-1 首页三横菜单 Drawer 打开", drawer_open, f"hidden={not drawer_open}")
            u = back(pg)
            drawer_after = pg.evaluate("!document.getElementById('menuPanel').hidden")
            check("D2-2 返回先关闭 Drawer（不离开首页）", (not drawer_after) and u.startswith("/home"), f"drawer={not drawer_after} url={u}")
            c.close()
        run(browser, base, "D2", d2)

        def d3(b, base):
            c, pg = ctx(b); pg.goto(base + "/pages/order_detail?id=w-test&source=process&from=process", wait_until="domcontentloaded"); pg.wait_for_timeout(800)
            pg.click("#menuBtn"); pg.wait_for_timeout(300)
            drawer_open = pg.evaluate("!document.getElementById('menuPanel').hidden")
            check("D3-1 详情页菜单 Drawer 打开", drawer_open, f"hidden={not drawer_open}")
            u = back(pg)
            drawer_after = pg.evaluate("!document.getElementById('menuPanel').hidden")
            check("D3-2 返回先关闭 Drawer（不离开详情）", (not drawer_after) and "order_detail" in u, f"drawer={not drawer_after} url={u}")
            c.close()
        run(browser, base, "D3", d3)

        def d4(b, base):
            c, pg = ctx(b); pg.goto(base + "/pages/order_detail?id=w-test&source=process&from=process", wait_until="domcontentloaded"); pg.wait_for_timeout(800)
            pg.evaluate("window.zpConfirm('确认','确定吗','确定'); 0"); pg.wait_for_timeout(200)
            dlg_open = pg.evaluate("!document.querySelector('#zpUiLayer .zp-confirm').hidden")
            check("D4-1 全局确认框 Dialog 出现", dlg_open, f"hidden={not dlg_open}")
            u = back(pg)
            dlg_after = pg.evaluate("!document.querySelector('#zpUiLayer .zp-confirm').hidden")
            check("D4-2 返回先关闭确认框 Dialog（rank5，不离开页面）", (not dlg_after) and "order_detail" in u, f"dlg={not dlg_after} url={u}")
            c.close()
        run(browser, base, "D4", d4)

        def d5(b, base):
            c, pg = ctx(b); pg.goto(base + "/admin", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            pg.click("#menuBtn"); pg.wait_for_timeout(300)
            pg.click("#editPass"); pg.wait_for_timeout(300)
            u = back(pg)
            dlg_after = pg.evaluate("!document.getElementById('dlg').hidden")
            check("D5 管理员子对话框返回先关闭 Dialog（rank10）", (not dlg_after) and p_url(pg).startswith("/admin"), f"dlg={not dlg_after} url={u}")
            c.close()
        run(browser, base, "D5", d5)

        def d6(b, base):
            c, pg = ctx(b); pg.goto(base + "/admin", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            pg.click("#menuBtn"); pg.wait_for_timeout(300)
            u = back(pg)
            drawer_after = pg.evaluate("!document.getElementById('menuBg').hidden")
            check("D6 管理员系统设置 Drawer 返回先关闭 Drawer（rank20）", (not drawer_after) and p_url(pg).startswith("/admin"), f"drawer={not drawer_after} url={u}")
            c.close()
        run(browser, base, "D6", d6)

        # ---- E. 跨区防火墙 ----
        def e1(b, base):
            c, pg = ctx(b); pg.goto(base + "/admin?from=home", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            target = pg.evaluate("window.zpResolveBack()")
            check("E1 管理员端 from=home → 防火墙拦截，仍 /admin", target == "/admin", f"target={target}")
            c.close()
        run(browser, base, "E1", e1)

        def e2(b, base):
            c, pg = ctx(b); pg.goto(base + "/pages/data.html?from=admin", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            target = pg.evaluate("window.zpResolveBack()")
            check("E2 业务端 from=admin → 防火墙拦截，回业务根 /home", target == "/home", f"target={target}")
            c.close()
        run(browser, base, "E2", e2)

        browser.close()
        srv.shutdown()

    print("\n" + "=" * 64, flush=True)
    print("P0-1 返回体系 E2E 结果:", "全部通过 ✅" if not fails else f"失败 {len(fails)} 项: {fails}", flush=True)
    print("=" * 64, flush=True)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
