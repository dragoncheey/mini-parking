#!/usr/bin/env bash
# 在服务器上以 root 运行一次，为 GitHub Actions 自动部署准备一个专用账号。
#
# 用法：
#   bash setup-deploy-user.sh "<部署公钥内容，例如 ssh-ed25519 AAAA... github-actions-deploy>"
#
# 它会：
#   1. 安装 rsync（如缺失）
#   2. 创建 deploy 用户并加入 docker 组
#   3. 把部署目录交给 deploy 用户，.env.server 设为仅本人可读
#   4. 把传入的公钥写入 deploy 的 authorized_keys
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/mini-parking}"
PUBLIC_KEY="${1:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行" >&2
  exit 1
fi

if [ -z "$PUBLIC_KEY" ]; then
  echo "用法: bash $0 \"ssh-ed25519 AAAA... github-actions-deploy\"" >&2
  exit 1
fi

case "$PUBLIC_KEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;;
  *) echo "看起来不是 SSH 公钥（注意不要传私钥）" >&2; exit 1 ;;
esac

if [ ! -f "$DEPLOY_PATH/.env.server" ]; then
  echo "$DEPLOY_PATH/.env.server 不存在，请先确认部署目录" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y rsync
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y rsync
  elif command -v yum >/dev/null 2>&1; then
    yum install -y rsync
  else
    echo "请手动安装 rsync" >&2
    exit 1
  fi
fi

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_PATH"
chmod 600 "$DEPLOY_PATH/.env.server"

HOME_DIR="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh"
AUTH_KEYS="$HOME_DIR/.ssh/authorized_keys"
touch "$AUTH_KEYS"
if ! grep -qxF "$PUBLIC_KEY" "$AUTH_KEYS"; then
  printf '%s\n' "$PUBLIC_KEY" >> "$AUTH_KEYS"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"

echo "完成：$DEPLOY_USER 已可通过该公钥登录，并能在 $DEPLOY_PATH 运行 docker compose。"
echo "自检：su - $DEPLOY_USER -c 'cd $DEPLOY_PATH && docker compose ps'"
