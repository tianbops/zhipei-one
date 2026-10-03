# 适配One

全新重建基线。

## 核心链路
上传运单 → OCR识别 → 提取 → 匹配 → 规划 → 保存

## 数据模型
User → Route → Route Base / Today / History / Learning

## 客户端
Web、微信小程序、Android 统一调用服务端 API。

本次重建不兼容旧业务代码，不迁移测试业务数据。旧版本仅作为归档参考。
