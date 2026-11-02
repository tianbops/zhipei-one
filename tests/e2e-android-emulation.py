#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Android 真机 E2E · 沙箱前置仿真回归
================================================================
运行：python3 -u tests/e2e-android-emulation.py
依赖：playwright（chromium-1208，已装）

用途
----
本脚本是《Android 真机 E2E 用例清单》在沙箱内的**前置门禁**：用桌面
Chromium 模拟 Pixel 5（touch + PWA standalone + 物理返回键语义 +
横竖屏），提前验证真机特有的交互维度不会回归。真机执行仍须按清单
用真实设备跑一遍。

Android 特有维度与桌面 E2E 的差异
----------------------------------
1. 物理返回键 / 手势返回：Android 上等价于浏览器 `history.back()`
   （popstate），本脚本用 `hw_back=history.back()` 代表，并验证其与
   顶部返回按钮 `#backBtn`（调 `zpHandleBack()`）落到同一目标。
2. PWA standalone：注入 `display-mode:standalone`，模拟已安装 PWA
   在独立窗口运行（无浏览器地址栏，返回全靠 app 内逻辑）。
3. 触摸布局：is_mobile + has_touch，验证 Drawer/Sheet 在触摸事件下
   返回层级正确。
4. 横竖屏：AM7 先展开首页三横 Drawer，再切 landscape，验证物理键仍
   先关 Drawer 不离开首页。
5. SW 版本：AM8 fetch /sw.js 校验 VERSION=zp-pwa-16（发布后客户端
   刷新拿新版）。本脚本只 fetch 不注册 SW，避免缓存干扰稳定性。

覆盖矩阵（聚焦移动特有 + 真机前兜底）
  AM1 今日页：物理返回键 = 顶部返回（均回 /home）
  AM2 历史详情：物理返回键 = 顶部返回（均回 /pages/history）
  AM3 详情菜单 Drawer + 物理键先关 Drawer（不离开详情）
  AM4 首页上传 Sheet + 物理键先关 Sheet（不离开首页）
  AM5 管理员：系统设置→修改密码→物理键返回（两步返回，抽屉仍开）→再返回→工作台
  AM6 管理员根：物理键首次返回 = exit-armed（不离开）
  AM7 横屏下首页三横 Drawer + 物理键先关 Drawer
  AM8 客户端可拉取 sw.js 且 VERSION=zp-pwa-16
"""
import sys, os, re, json, time, threading, http.server, socketserver
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8191
CHROME = "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"

ANDROID_UA = ("Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")

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
        # Android 仿真：开放真实 sw.js 供 fetch 校验版本（不注册 SW，避免缓存干扰）
        if path == "/sw.js":
            return self._serve_file(self.directory + "/sw.js")
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


# 注入 display-mode:standalone，模拟已安装 PWA 独立窗口
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
    while time.time() - t0 < 180:
        time.sleep(5)
        print(f"[watchdog {int(time.time()-t0)}s] at={_LAST['name']}", flush=True)
    print(f"[watchdog] TIMEOUT at={_LAST['name']}", flush=True)
    os._exit(2)


def p_url(page):
    u = urlparse(page.url)
    return u.path + ("?" + u.query if u.query else "")


def back(page, wait=500):
    """顶部返回按钮语义：调 zpHandleBack()"""
    page.evaluate("window.zpHandleBack()")
    page.wait_for_timeout(wait)
    return p_url(page)


def hw_back(page, wait=500):
    """Android 物理返回键 / 手势返回语义：等价于 history.back()（popstate）"""
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
        # Android Pixel 5 仿真：touch + PWA standalone + 物理键语义
        c = browser.new_context(
            viewport={"width": 393, "height": 851},
            device_scale_factor=3,
            is_mobile=True,
            has_touch=True,
            user_agent=ANDROID_UA,
            locale="zh-CN",
        )
        pg = c.new_page()
        pg.set_default_timeout(9000)
        pg.set_default_navigation_timeout(12000)
        pg.add_init_script(STANDALONE)
        return c, pg

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])

        # AM1 今日页：物理返回键 = 顶部返回（均回 /home）
        def am1(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            pg.click("a[href*='account.html?from=home']"); pg.wait_for_timeout(700)
            click_url = back(pg)                                          # 顶部返回按钮
            c.close()
            c2, pg2 = ctx(b); pg2.goto(base + "/home", wait_until="domcontentloaded"); pg2.wait_for_timeout(700)
            pg2.click("a[href*='account.html?from=home']"); pg2.wait_for_timeout(700)
            sys_url = hw_back(pg2)                                        # Android 物理返回键
            c2.close()
            check("AM1 今日页：顶部返回 = 物理返回键（均回 /home）",
                  urlparse(click_url).path == "/home" and urlparse(sys_url).path == "/home",
                  f"click={click_url} hw={sys_url}")
        run(browser, base, "AM1", am1)

        # AM2 历史详情：物理返回键 = 顶部返回（均回 /pages/history）
        def am2(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            pg.click("a[href*='history.html?from=home']"); pg.wait_for_timeout(700)
            pg.click(".history-date-main"); pg.wait_for_timeout(800)
            click_url = back(pg)
            c.close()
            c2, pg2 = ctx(b); pg2.goto(base + "/home", wait_until="domcontentloaded"); pg2.wait_for_timeout(700)
            pg2.click("a[href*='history.html?from=home']"); pg2.wait_for_timeout(700)
            pg2.click(".history-date-main"); pg2.wait_for_timeout(800)
            sys_url = hw_back(pg2)
            c2.close()
            check("AM2 历史详情：顶部返回 = 物理返回键（均回 /pages/history）",
                  urlparse(click_url).path == "/pages/history" and urlparse(sys_url).path == "/pages/history",
                  f"click={click_url} hw={sys_url}")
        run(browser, base, "AM2", am2)

        # AM3 运单详情顶部分享按钮：触控可见，且三横菜单已移除
        def am3(b, base):
            c, pg = ctx(b); pg.goto(base + "/pages/order_detail?id=w-test&source=process&from=process", wait_until="domcontentloaded"); pg.wait_for_timeout(800)
            share = pg.locator("#shareBtn")
            check("AM3-1 详情页分享按钮触控可见", share.count() == 1 and share.is_visible(), f"count={share.count()}")
            no_menu = pg.evaluate("document.getElementById('menuBtn') === null && document.getElementById('menuPanel') === null")
            check("AM3-2 详情页三横菜单已移除", no_menu, f"no_menu={no_menu}")
            c.close()
        run(browser, base, "AM3", am3)

        # AM4 首页上传 Sheet + 物理返回键先关 Sheet（不离开首页）
        def am4(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(700)
            pg.click("#uploadAction"); pg.wait_for_timeout(300)
            sheet_open = pg.evaluate("!document.getElementById('uploadArea').hidden")
            check("AM4-1 首页上传 Bottom Sheet 打开(touch)", sheet_open, f"hidden={not sheet_open}")
            u = hw_back(pg)
            sheet_after = pg.evaluate("!document.getElementById('uploadArea').hidden")
            check("AM4-2 物理返回键先关 Sheet（不离开首页）",
                  (not sheet_after) and u.startswith("/home"), f"sheet={not sheet_after} url={u}")
            c.close()
        run(browser, base, "AM4", am4)

        # AM5 管理员：系统设置→修改密码→物理键返回（两步返回，抽屉仍开）→再返回→工作台
        def am5(b, base):
            c, pg = ctx(b); pg.goto(base + "/admin", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            pg.click("#menuBtn"); pg.wait_for_timeout(300)
            drawer_open = pg.evaluate("!document.getElementById('menuBg').hidden")
            check("AM5-1 ☰ 打开系统设置抽屉(touch)", drawer_open, f"menuBg.hidden={not drawer_open}")
            pg.click("#editPass"); pg.wait_for_timeout(300)
            dlg_open = pg.evaluate("!document.getElementById('dlg').hidden")
            drawer_while_dlg = pg.evaluate("!document.getElementById('menuBg').hidden")
            check("AM5-2 打开子页→子对话框出现、抽屉已收起",
                  dlg_open and not drawer_while_dlg, f"dlg={dlg_open} drawer={drawer_while_dlg}")
            hw_back(pg)
            dlg_after = pg.evaluate("!document.getElementById('dlg').hidden")
            drawer_after_back = pg.evaluate("!document.getElementById('menuBg').hidden")
            check("AM5-3 子对话框物理键返回→关对话框、留在管理员工作台",
                  (not dlg_after) and p_url(pg).startswith("/admin"), f"dlg={not dlg_after} url={p_url(pg)}")
            hw_back(pg)
            drawer_final = pg.evaluate("!document.getElementById('menuBg').hidden")
            check("AM5-4 系统设置物理键返回→关抽屉、留工作台",
                  (not drawer_final) and p_url(pg).startswith("/admin"), f"drawer={drawer_final} url={p_url(pg)}")
            c.close()
        run(browser, base, "AM5", am5)

        # AM6 管理员根：物理返回键首次 = exit-armed（不离开）
        def am6(b, base):
            c, pg = ctx(b); pg.goto(base + "/admin", wait_until="domcontentloaded"); pg.wait_for_timeout(900)
            r = pg.evaluate("window.zpHandleBack()")
            pg.wait_for_timeout(300)
            check("AM6 管理员根首次返回 = exit-armed（不离开）",
                  r == "exit-armed" and p_url(pg).startswith("/admin"), f"r={r} url={p_url(pg)}")
            c.close()
        run(browser, base, "AM6", am6)

        # AM7 横屏下首页三横 Drawer + 物理返回键先关 Drawer
        def am7(b, base):
            c, pg = ctx(b); pg.goto(base + "/pages/history?from=home", wait_until="domcontentloaded"); pg.wait_for_timeout(800)
            pg.click("#historyPickerBtn"); pg.wait_for_timeout(300)
            drawer_open = pg.evaluate("!document.getElementById('historyPicker').hidden")
            check("AM7-1 竖屏历史页日历选择器打开", drawer_open, f"hidden={not drawer_open}")
            pg.set_viewport_size({"width": 851, "height": 393})   # 切横屏
            pg.wait_for_timeout(400)
            u = hw_back(pg)
            drawer_after = pg.evaluate("!document.getElementById('historyPicker').hidden")
            check("AM7-2 横屏下物理返回键仍先关日历选择器（不离开历史页）",
                  (not drawer_after) and u.startswith("/pages/history"), f"picker={not drawer_after} url={u}")
            c.close()
        run(browser, base, "AM7", am7)

        # AM8 客户端可拉取 sw.js，且 VERSION 与仓库当前 sw.js 一致（发布后新版生效）
        # 版本号从 sw.js 现读，避免每次 bump 都要改断言（此前硬写 zp-pwa-16 导致必挂）
        def am8(b, base):
            c, pg = ctx(b); pg.goto(base + "/home", wait_until="domcontentloaded"); pg.wait_for_timeout(500)
            txt = pg.evaluate("async()=>{try{const r=await fetch('/sw.js');return await r.text();}catch(e){return 'ERR:'+e;}}")
            pg.wait_for_timeout(600)
            want = ""
            try:
                want = re.search(r'VERSION\s*=\s*["\']([^"\']+)["\']', open(os.path.join(ROOT, "sw.js")).read()).group(1)
            except Exception:
                pass
            hit = bool(want) and want in (txt or "")
            check(f"AM8 客户端可拉取 sw.js 且 VERSION={want}（与仓库一致）",
                  hit, f"want={want} len={len(txt or '')} -> {txt[:80] if txt else ''}")
            c.close()
        run(browser, base, "AM8", am8)

        browser.close()
        srv.shutdown()

    print("\n" + "=" * 64, flush=True)
    print("Android 仿真回归结果:", "全部通过 ✅" if not fails else f"失败 {len(fails)} 项: {fails}", flush=True)
    print("=" * 64, flush=True)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
