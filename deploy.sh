#!/usr/bin/env bash
# 智配One · 部署辅助脚本
# 用法（在项目根目录执行）：
#   bash deploy.sh            # 只部署
#   bash deploy.sh secrets    # 只导入密钥（读 secrets.json）
#   bash deploy.sh all        # 导入密钥 + 部署
#   bash deploy.sh check      # 部署后检查 /api/health
#
# Windows 用户在 Git Bash 里执行同样命令

set -euo pipefail

PROJECT="${ZP_PROJECT:-tianyou-zhipei}"
MODE="${1:-deploy}"
WRANGLER="npx wrangler@latest"

# 发布前必须执行：给静态资源引用打上 ?v=<内容哈希>，并重建 SW 预缓存、递增 SW 版本，
# 否则浏览器 HTTP 缓存 / Service Worker 会继续提供旧版 JS/CSS，用户看不到本次修改。
# 见 scripts/bump_asset_versions.py（内部调用 tools/stamp_assets.py 刷 HTML 引用）
stamp() {
  echo "==> 刷新资源版本号 + 重建 SW 预缓存 + 递增 SW 版本"
  python3 scripts/bump_asset_versions.py || { echo "✗ 版本号刷新失败"; exit 1; }
}

# 安全护栏：secrets.json 一旦被 git 跟踪即视为密钥泄露前兆，阻断一切会触碰仓库/部署的操作。
# 文件存在但未跟踪（.gitignore 已忽略）属正常临时态，仅提醒操作后删除。
guard_secrets() {
  if git ls-files --error-unmatch secrets.json >/dev/null 2>&1; then
    echo "✗ 安全阻断：secrets.json 已被 git 跟踪，继续会把密钥提交进仓库！" >&2
    echo "  请先停止跟踪并清理（切勿直接 commit）：" >&2
    echo "    git rm --cached secrets.json && git commit -m 'security: 停止跟踪 secrets.json'" >&2
    exit 1
  fi
  if [ -f secrets.json ]; then
    echo "⚠ 提醒：当前目录存在 secrets.json（未被跟踪，安全），操作结束后务必删除：$ rm -f secrets.json"
  fi
}

case "$MODE" in

  secrets)
    guard_secrets
    echo "==> 导入密钥（读取 secrets.json）"
    if [ ! -f secrets.json ]; then
      echo "✗ 找不到 secrets.json，请先创建它（见部署指南第 7 步）"
      exit 1
    fi
    $WRANGLER pages secret bulk secrets.json --project-name="$PROJECT"
    echo "✓ 密钥导入完成"
    echo "⚠ 记得删除 secrets.json：$ rm -f secrets.json"
    ;;

  deploy)
    guard_secrets
    echo "==> 部署到 Cloudflare Pages（项目：$PROJECT）"
    stamp
    $WRANGLER pages deploy . --project-name="$PROJECT"
    echo "✓ 部署完成"
    echo "⚠ 如果你刚改过环境变量，密钥会在本次部署中生效"
    ;;

  all)
    guard_secrets
    echo "==> 导入密钥"
    [ -f secrets.json ] || { echo "✗ 找不到 secrets.json"; exit 1; }
    $WRANGLER pages secret bulk secrets.json --project-name="$PROJECT"
    echo "==> 部署"
    stamp
    $WRANGLER pages deploy . --project-name="$PROJECT"
    echo "✓ 全部完成"
    echo "⚠ 记得删除 secrets.json"
    ;;

  check)
    echo "==> 检查后端健康状态"
    URL="https://${PROJECT}.pages.dev/api/health"
    echo "GET $URL"
    BODY="$(curl -sS --max-time 20 "$URL" || echo '请求失败')"
    echo "$BODY"
    if echo "$BODY" | grep -q '"status":"ok"'; then
      echo "✓ Functions 已正常运行"
    else
      echo "✗ 后端没起来 —— 多半是 functions/ 没部署上，或环境变量没配"
      echo "  排查：部署指南第 13 节故障排查表"
    fi
    ;;

  *)
    echo "用法：bash deploy.sh [deploy|secrets|all|check]"
    exit 1
    ;;
esac
