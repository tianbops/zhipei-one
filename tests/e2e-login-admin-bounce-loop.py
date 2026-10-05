#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归测试：登录页↔管理端「来回跳动」死循环（2026-10-05 生产事故）。

生产现象（用户视频）：普通用户登录后进入管理员页，随后 登录页↔管理端 每
~3 秒互跳一次，永不停止。管理端横幅显示「当前账号无管理员权限」。

根因分析：
  登录页 index.html 的角色自动直达用的是全站唯一【不带参数】的稳定 URL
  /api/me，而管理端用的是 ?adminCheck=<时间戳>。任何按 URL 缓存的中间层
  （CDN/代理/边缘节点）都可能给稳定 URL 命中【旧会话时代（管理员在线时）
  的 200 响应】。于是：
    登录页读到陈旧"管理员"角色 → replace /admin
    管理端 ?adminCheck 拿到真实"普通用户" → 「无权限」→ replace /
    登录页再次命中陈旧响应 → …… 无限循环。
  旧代码里管理端把非管理员弹回登录页（/），是循环成形的结构性条件。

修复（本测试断言的新行为）：
  1) index.html：/api/me?autoMe=<时间戳>（与管理端同款防缓存）；
     自动直达保险丝 —— 10 秒内满 3 次自动跳转即停手留在登录页。
  2) admin.html：非管理员（会话有效）直接送回业务端 /home，不再回登录页
     —— 无论哪端读到陈旧角色，最坏只多跳一跳，循环在结构上不可能成形。
  3) home.js：/api/me?homeMe=<时间戳> 同款防缓存。

测试服务器复现生产分歧：/api/me（无参数）→ 返回【管理员】（陈旧）；
/api/me?任意参数 → 返回【普通用户】（真实）。并复现 Cloudflare Pages
pretty-URL 308（/admin.html→/admin、/home.html→/home）。

断言：
  A) 旧代码（6ba3814）：从 / 进入 → 在 / 与 /admin 间至少来回 3 次
     （复现视频中的死循环）。
  B) 新代码，同样的分歧环境，从 / 进入 → 穿过 /admin 后停在 /home，
     4 秒内不再跳动；菜单显示普通用户名（home 拿到真实身份）。
  C) 新代码，普通用户直接落在 /admin → 显示「无管理员权限」后停在 /home。
  D) 新代码，纯普通用户会话：从 / 一跳直达 /home。
  E) 新代码，纯管理员会话：从 / 一跳直达 /admin 且稳定，头部显示管理员名。
  F) 新代码，未登录：/admin 显示「身份验证失败」→ 回登录页并保持稳定。
  G) 保险丝：预置 zpAutoHop={n:3} 后，登录页自动直达被跳过（停在 /）。
"""
import sys, time, threading, http.server, socketserver, os, json
from playwright.sync_api import sync_playwright

NEW_ROOT = "/tmp/ghrepo"
OLD_ROOT = "/tmp/oldcode"
PORT_NEW = 8151
PORT_OLD = 8152
CHROME = "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"

ADMIN = {"success": True, "user": {"id": "a1", "username": "tianbops", "role": "admin", "name": "系统管理员"}}
USER = {"success": True, "user": {"id": "u1", "username": "zsxff", "role": "user", "name": "张三"}}


class _Base(http.server.SimpleHTTPRequestHandler):
    mode = "divergent"
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
            if self.mode == "unauth":
                return self._json({"success": False, "error": "未登录"}, 401)
            if self.mode == "admin":
                return self._json(ADMIN)
            if self.mode == "user":
                return self._json(USER)
            # divergent：稳定 URL（无参数）→ 陈旧的管理员响应
            return self._json(ADMIN if not q else USER)
        if p == "/api/routes":
            return self._json({"success": True, "routes": []})
        if p == "/api/admin/users":
            return self._json({"success": True, "users": []})
        if p == "/api/admin/route-requests":
            return self._json({"success": True, "requests": []})
        if p == "/api/invite-codes":
            return self._json({"success": True, "codes": []})
        if p.startswith("/api/"):
            return self._json({"success": True})
        return super().do_GET()


def make_handler(root, mode):
    class H(_Base):
        pass
    H.mode = mode
    H.__init__ = (lambda d: lambda self, *a, **k: _Base.__init__(self, *a, directory=d, **k))(root)
    return H


def serve(port, root, mode):
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", port), make_handler(root, mode))
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


def track(page, seconds, interval=0.15):
    """轮询记录 location.pathname 变化，返回 (路径序列, 最终路径)"""
    seq = []
    end = time.time() + seconds
    last = None
    while time.time() < end:
        try:
            p = page.evaluate("location.pathname")
            last = p
        except Exception:
            # 导航进行中上下文销毁属正常，短暂退避后继续，别中断轮询
            page.wait_for_timeout(int(interval * 1000))
            continue
        if not seq or seq[-1] != p:
            seq.append(p)
        page.wait_for_timeout(int(interval * 1000))
    return seq, (seq[-1] if seq else (last or ""))


def new_page(ctx, init=None):
    page = ctx.new_page()
    page.add_init_script(STANDALONE)
    if init:
        page.add_init_script(init)
    return page


def main():
    srv_new_div = serve(PORT_NEW, NEW_ROOT, "divergent")
    srv_new_user = serve(PORT_NEW + 10, NEW_ROOT, "user")
    srv_new_admin = serve(PORT_NEW + 20, NEW_ROOT, "admin")
    srv_new_unauth = serve(PORT_NEW + 30, NEW_ROOT, "unauth")
    srv_old_div = serve(PORT_OLD, OLD_ROOT, "divergent")
    time.sleep(0.4)

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])

        # ===== A) 旧代码：复现死循环 =====
        # 旧循环里 /（登录页）阶段极短（就地自动跳转），location.pathname 轮询采样不到，
        # 改用 framenavigated 事件收集每次导航（含瞬态的 /）来判定振荡。
        from urllib.parse import urlparse
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = new_page(ctx)
        visited = []
        page.on("framenavigated", lambda f: (visited.append(f.url) if f == page.main_frame else None))
        page.goto(f"http://127.0.0.1:{PORT_OLD}/", wait_until="domcontentloaded")
        page.wait_for_timeout(12000)
        paths = [urlparse(u).path for u in visited]
        check("A) 旧代码复现死循环：登录页↔管理端反复互跳",
              paths.count("/admin") >= 2 and "/" in paths,
              f"导航次数={len(paths)} admin={paths.count('/admin')} 登录={paths.count('/')}")
        ctx.close()

        # ===== B) 新代码：同样分歧环境，收敛到 /home =====
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = new_page(ctx)
        page.goto(f"http://127.0.0.1:{PORT_NEW}/", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)   # 等 /admin 的 1.2s 弹回 + /home 加载
        seq, last = track(page, 4)
        check("B1) 分歧环境下新代码最终稳定停在 /home", last == "/home", f"路径序列={seq}")
        check("B2) 4 秒观察期内无任何再跳动", len(seq) <= 1, f"路径序列={seq}")
        uname = page.evaluate("(()=>{const e=document.getElementById('menuUsername');return e?e.textContent:''})()")
        check("B3) 首页菜单显示真实普通用户名 zsxff（拿到未污染身份）", uname == "zsxff", f"实际={uname!r}")
        ctx.close()

        # ===== C) 新代码：普通用户直接落在 /admin =====
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = new_page(ctx)
        page.goto(f"http://127.0.0.1:{PORT_NEW}/admin.html", wait_until="domcontentloaded")
        page.wait_for_timeout(500)
        banner = page.evaluate("document.getElementById('who').textContent")
        check("C1) 直接进 /admin 显示「当前账号无管理员权限」", banner == "当前账号无管理员权限", f"实际={banner!r}")
        page.wait_for_timeout(2200)
        seq, last = track(page, 4)
        check("C2) 随后停在 /home（不再回登录页）", last == "/home", f"路径序列={seq}")
        check("C3) 观察期内无再跳动", len(seq) <= 1, f"路径序列={seq}")
        ctx.close()

        # ===== D) 新代码：纯普通用户会话，/ 一跳直达 /home =====
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = new_page(ctx)
        page.goto(f"http://127.0.0.1:{PORT_NEW+10}/", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        seq, last = track(page, 3)
        check("D) 纯普通用户：从 / 直达 /home 且稳定", last == "/home" and len(seq) <= 1, f"路径序列={seq}")
        ctx.close()

        # ===== E) 新代码：纯管理员会话，/ 一跳直达 /admin 且稳定 =====
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = new_page(ctx)
        page.goto(f"http://127.0.0.1:{PORT_NEW+20}/", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        who = page.evaluate("document.getElementById('who').textContent")
        seq, last = track(page, 3)
        check("E) 纯管理员：从 / 直达 /admin 稳定且显示管理员身份",
              last == "/admin" and len(seq) <= 1 and "tianbops" in who, f"路径序列={seq} who={who!r}")
        ctx.close()

        # ===== F) 新代码：未登录直接进 /admin → 回登录页并保持 =====
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = new_page(ctx)
        page.goto(f"http://127.0.0.1:{PORT_NEW+30}/admin.html", wait_until="domcontentloaded")
        page.wait_for_timeout(400)
        banner = page.evaluate("document.getElementById('who').textContent")
        page.wait_for_timeout(2200)
        seq, last = track(page, 3)
        check("F) 未登录：显示「身份验证失败」→ 回登录页稳定停留",
              banner.startswith("身份验证失败") and last in ("/", "/index.html") and len(seq) <= 1,
              f"banner={banner!r} 路径序列={seq}")
        ctx.close()

        # ===== G) 保险丝：自动直达达上限后停手 =====
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = new_page(ctx, init="try{sessionStorage.setItem('zpAutoHop',JSON.stringify({t:Date.now(),n:3}))}catch(e){}")
        page.goto(f"http://127.0.0.1:{PORT_NEW}/", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        seq, last = track(page, 2)
        check("G) 保险丝触发：登录页不再自动直达，稳定停留", last in ("/", "/index.html") and len(seq) <= 1, f"路径序列={seq}")
        ctx.close()

        browser.close()

    print("\n结果:", "全部通过 ✅" if not fails else f"失败项: {fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
