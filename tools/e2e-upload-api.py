#!/usr/bin/env python3
"""智配One · 运维工具：直连 API 上传运单做端到端验证（不经过浏览器 UI）。

用途：验证 OCR / 门店匹配 / 去重 / 规划 / 自动取代全链路，尤其支持
「乱序上传多张截图」以复现并回归验证「相册多选顺序不可靠」类问题。

用法：
  python3 tools/e2e-upload-api.py --base https://xxx.pages.dev \
      --user cs1234 --pass 123456 --route <routeId> img1.jpg img2.jpg img3.jpg

说明：
  - 登录调度账号后，以 multipart 把图片按给定顺序 POST 到 /api/waybills/process；
  - 打印 门店数 / 待定数 / 匹配合并 / 边缘裁剪 / 被取代旧单 等关键结果。
"""
import argparse
import json
import sys

import requests


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://tianyou-zhipei.pages.dev")
    ap.add_argument("--user", required=True)
    ap.add_argument("--pass", dest="password", required=True)
    ap.add_argument("--route", required=True, help="routeId")
    ap.add_argument("--date", default=None)
    ap.add_argument("--vehicle", default=None)
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    s = requests.Session()
    r = s.post(f"{args.base}/api/login", json={"username": args.user, "password": args.password}, timeout=30)
    if r.status_code != 200 or not r.json().get("success"):
        print("登录失败:", r.status_code, r.text[:200], file=sys.stderr)
        sys.exit(1)

    data = {"routeId": args.route}
    if args.date:
        data["date"] = args.date
    if args.vehicle:
        data["vehicle"] = args.vehicle
    files = [("file", (f"img{i}.jpg", open(f, "rb"), "image/jpeg")) for i, f in enumerate(args.files, 1)]
    try:
        r2 = s.post(f"{args.base}/api/waybills/process", files=files, data=data, timeout=300)
    finally:
        for _, (_, fh, _) in files:
            fh.close()

    body = r2.json()
    wb = body.get("waybill") or {}
    sm = wb.get("summary") or {}
    dg = wb.get("diagnostics") or {}
    print("HTTP", r2.status_code, "| success =", body.get("success"), "| code =", body.get("code"))
    print("id =", wb.get("id"), "| stage =", wb.get("stage"))
    print("total =", sm.get("total"), "| pending =", sm.get("pending"), "| matched =", sm.get("matched"), "| merged =", sm.get("merged"))
    print("imageCount =", (wb.get("ocr") or {}).get("imageCount"), "| edgeTrimmed =", dg.get("edgeTrimmed"), "| superseded =", body.get("superseded"))
    pend = [x.get("rawName") or x.get("name") for x in (wb.get("stores") or []) if x.get("pending")]
    print("待定条目 =", pend)
    print("\n结果已写入 /tmp/e2e-upload-result.json")
    open("/tmp/e2e-upload-result.json", "w").write(json.dumps(body, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
