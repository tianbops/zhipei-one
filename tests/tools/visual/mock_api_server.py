#!/usr/bin/env python3
"""智配One 本地 mock API + 静态服务 —— 视觉验证基建（仅本地开发用，勿接入生产）。

用途：列表页数据全部来自 /api/*，离线 file:// 打开只会显示「加载中…」，
任何视觉验证（headless 截图 / Card→Row 结构核对）都必须先由本服务顶起后端。

用法：
    python3 tests/tools/visual/mock_api_server.py        # 默认 127.0.0.1:8099
    PORT=8090 python3 tests/tools/visual/mock_api_server.py
再配合 inspect_page.js 截图 / 读取页面几何。

样本数据是「形状正确」的最小集（字段名从各页 render 函数反推）：
  /api/base        → x.base.stores / x.base.version / x.canMaintain / x.route.name
  /api/waybills/*  → d.success + d.waybill{summary, stores[{name,note,pending,...}]}
形状写错时页面静默显示空列表（不报错）——这正是必须用截图确认渲染的原因。
"""
import http.server, json, re, os, urllib.parse
from http.server import BaseHTTPRequestHandler

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))

SAMPLE_STORES = [
    {"name": "朝阳大悦城店", "originalName": "朝阳大悦城店", "aliases": ["大悦城", "CY"], "note": "B1 扶梯旁", "navigation": "https://maps.example.com/c1", "routeOrder": 1},
    {"name": "中关村鼎好店", "originalName": "中关村鼎好店", "aliases": [], "note": "上午件多", "navigation": "https://maps.example.com/c2", "routeOrder": 2},
    {"name": "西单大悦城店", "originalName": "西单大悦城店", "aliases": ["西单"], "note": "", "navigation": "", "routeOrder": 3},
    {"name": "国贸三期店", "originalName": "国贸三期店", "aliases": [], "note": "需上楼", "navigation": "https://maps.example.com/c4", "routeOrder": 4},
    {"name": "望京 SOHO 店", "originalName": "望京 SOHO 店", "aliases": ["望京"], "note": "", "navigation": "", "routeOrder": 5},
]

def api_response(path, query):
    if path == "/api/me" or path.startswith("/api/me?"):
        return {"username": "demo", "role": "user", "routeId": "R-001"}
    if path == "/api/dispatch":
        return {"dispatchRoute": {"id": "R-001", "name": "测试线路"}, "routeName": "测试线路"}
    if path.startswith("/api/base"):
        # 实际契约：x.base.stores / x.base.version / x.canMaintain / x.route.name
        return {"routeId": "R-001",
                "base": {"version": 1, "stores": SAMPLE_STORES},
                "canMaintain": True,
                "route": {"name": "1号线"}}
    if path.startswith("/api/routes"):
        return {"routes": [
            {"id": "R-001", "name": "测试线路", "storeCount": 5},
            {"id": "R-002", "name": "城东线", "storeCount": 3},
        ]}
    if path.startswith("/api/route-requests"):
        return {"requests": [
            {"id": "REQ-1", "routeName": "城东线", "applicant": "张三", "status": "pending", "createdAt": "2026-10-07"},
            {"id": "REQ-2", "routeName": "城西线", "applicant": "李四", "status": "approved", "createdAt": "2026-10-06"},
            {"id": "REQ-3", "routeName": "通州线", "applicant": "王五", "status": "rejected", "createdAt": "2026-10-05"},
        ]}
    if path.startswith("/api/route-binding"):
        return {"boundRouteId": None}
    if path.startswith("/api/account-settings"):
        return {"accounts": [
            {"id": "acc-1", "name": "主账号", "role": "owner", "username": "demo"},
            {"id": "acc-2", "name": "配送员 A", "role": "member", "username": "rider_a"},
            {"id": "acc-3", "name": "配送员 B", "role": "member", "username": "rider_b"},
        ], "notify": {"enabled": True}}
    if path.startswith("/api/waybills/latest"):
        # 实际契约：d.success + d.waybill{summary, stores[{name,note,navigation,pending,matchMethod}]}
        return {"success": True,
                "waybill": {"id": "W-001", "vehicle": "京A12345", "confirmedAt": "2026-10-08 09:12",
                            "summary": {"total": 4},
                            "stores": [
                                {"name": "朝阳大悦城店", "note": "B1 扶梯旁", "navigation": "https://maps.example.com/c1", "pending": False, "matchMethod": "auto"},
                                {"name": "中关村鼎好店", "note": "", "navigation": "", "pending": False, "matchMethod": "auto"},
                                {"name": "望京 SOHO 店", "note": "上午件多", "navigation": "", "pending": False, "matchMethod": "auto"},
                                {"name": " unidentified store", "rawName": "unknown-004", "note": "", "navigation": "", "pending": True, "matchMethod": "none",
                                 "candidates": [{"name": "望京 SOHO 店", "score": 0.62}], "matchDiagnostics": {"reason": "below_threshold"}},
                            ]}}
    if path.startswith("/api/history"):
        return {"months": [{"y": 2026, "m": 10, "has": True}, {"y": 2026, "m": 9, "has": True}],
                "date": "2026-10-07",
                "summary": {"count": 3, "stores": 14},
                "items": [
                    {"time": "09:12", "store": "朝阳大悦城店", "parcels": 12, "status": "done"},
                    {"time": "10:31", "store": "中关村鼎好店", "parcels": 8, "status": "done"},
                    {"time": "11:05", "store": "望京 SOHO 店", "parcels": 5, "status": "done"},
                ]}
    # 默认：成功空对象
    return {"success": True}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            self._send(200, api_response(path, parsed.query))
            return
        # 静态文件
        rel = path.lstrip("/")
        if rel == "" or rel.endswith("/"):
            rel = "index.html"
        fp = os.path.normpath(os.path.join(ROOT, rel))
        if not fp.startswith(ROOT) or not os.path.isfile(fp):
            self._send(404, json.dumps({"error": "not found"}))
            return
        ctype = "text/html; charset=utf-8"
        if fp.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif fp.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif fp.endswith(".json"):
            ctype = "application/json; charset=utf-8"
        with open(fp, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._send(200, {"success": True})
            return
        self._send(404, json.dumps({"error": "not found"}))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8099"))
    srv = http.server.HTTPServer(("127.0.0.1", port), H)
    print(f"mock server on http://127.0.0.1:{port}")
    srv.serve_forever()
