#!/bin/sh
# DaMail installer / upgrader · DaMail 一键安装与升级
#
#   curl -fsSL https://damail.app/install.sh | sh
#
# Downloads docker-compose.yml into ./damail, creates .env on first install (random MASTER_KEY and
# database password), then runs docker compose pull && docker compose up -d. An existing .env is never
# touched, so running it again upgrades.
# 在 ./damail 下载 docker-compose.yml；第一次安装时生成 .env（随机 MASTER_KEY 和数据库密码）；
# 然后 docker compose pull && docker compose up -d。已有 .env 时不会改动，再跑一次就是升级。
#
# Optional environment variables · 可选环境变量：
#   DAMAIL_DIR         install directory · 安装目录（default ./damail）
#   DAMAIL_PUBLIC_URL  public URL · 对外访问地址（default http://localhost:8787, e.g. https://mail.example.com）
#   DAMAIL_PORT        host port · 本机端口（default 8787）
#   DAMAIL_BIND        listen address · 监听地址（default 127.0.0.1; 0.0.0.0 to expose directly）
#   DAMAIL_VERSION     image version · 镜像版本（default latest, e.g. v0.1.0）
#   DAMAIL_LANG        zh or en, skips the language prompt · 跳过语言选择
set -eu

DIR=${DAMAIL_DIR:-damail}
RAW=${DAMAIL_RAW:-https://raw.githubusercontent.com/gopkg-dev/damail/main}
PORT=${DAMAIL_PORT:-8787}
BIND=${DAMAIL_BIND:-127.0.0.1}
PUBLIC_URL=${DAMAIL_PUBLIC_URL:-http://localhost:$PORT}

# 语言：DAMAIL_LANG=zh / en 直接指定；否则在终端里让用户选（默认跟随系统语言）；没有终端时按系统语言
# Language: DAMAIL_LANG=zh / en; otherwise ask on the terminal (defaulting to the system language)
choose_lang() {
  case "${DAMAIL_LANG:-}" in
    zh*) ZH=1; return ;;
    en*) ZH=; return ;;
  esac
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in zh*) def=1 ;; *) def=2 ;; esac
  ans=
  # curl | sh 时标准输入是脚本本身，从 /dev/tty 读用户输入 · stdin is the script under curl | sh
  if (exec </dev/tty) 2>/dev/null; then
    printf '\nLanguage / 语言\n  1) 简体中文\n  2) English\nChoose / 请选择 [%s]: ' "$def" >/dev/tty
    read -r ans </dev/tty || ans=
  fi
  case "${ans:-$def}" in
    1 | zh* | Zh* | ZH*) ZH=1 ;;
    *) ZH= ;;
  esac
}
choose_lang
t() { if [ -n "$ZH" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m %s\n' "$(t '错误：' 'Error:')" "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "$(t '没有找到 docker，请先安装 Docker：' 'docker not found. Install Docker first:') https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "$(t '没有找到 docker compose 插件，请安装 Docker Compose v2' 'The docker compose plugin is missing. Install Docker Compose v2')"
docker info >/dev/null 2>&1 || die "$(t '无法连接 Docker：没有启动，或当前用户没有权限（可以用 sudo 运行，或把用户加入 docker 组）' 'Cannot reach Docker: it is not running, or this user lacks permission (run with sudo or join the docker group)')"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "$(t '需要 curl 或 wget' 'curl or wget is required')"
fi

# 32 random bytes as 64 hex characters
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

mkdir -p "$DIR"
cd "$DIR"

say "$(t '下载 docker-compose.yml' 'Downloading docker-compose.yml')"
fetch "$RAW/docker-compose.yml" docker-compose.yml.tmp
mv docker-compose.yml.tmp docker-compose.yml

if [ -f .env ]; then
  say "$(t '已有 .env，保留现有配置（升级）' 'Keeping the existing .env (upgrade)')"
else
  say "$(t '生成 .env（随机 MASTER_KEY 和数据库密码）' 'Creating .env with a random MASTER_KEY and database password')"
  case "$PUBLIC_URL" in https://*) SECURE=true ;; *) SECURE=false ;; esac
  (
    umask 077
    cat > .env <<EOF
# DaMail settings. All options: https://damail.app/docs/configuration/
# MASTER_KEY encrypts mailbox passwords and tokens. Back up this file: if the key is lost,
# saved mailboxes must be added again.
MASTER_KEY=$(rand_hex)
POSTGRES_PASSWORD=$(rand_hex | cut -c1-32)
PUBLIC_URL=$PUBLIC_URL
# true when DaMail is served over HTTPS
COOKIE_SECURE=$SECURE
DAMAIL_BIND=$BIND
DAMAIL_PORT=$PORT
DAMAIL_VERSION=${DAMAIL_VERSION:-latest}
EOF
  )
fi

say "$(t '拉取镜像' 'Pulling images')"
docker compose pull
say "$(t '启动' 'Starting')"
docker compose up -d

say "$(t '等待服务就绪' 'Waiting for DaMail to become ready')"
i=0
until docker compose exec -T app wget -qO- http://127.0.0.1:8787/healthz >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    docker compose logs --tail 50 app
    die "$(t '服务没有在 2 分钟内启动，日志见上方' 'DaMail did not start within 2 minutes; see the logs above')"
  fi
  sleep 2
done

URL=$(sed -n 's/^PUBLIC_URL=//p' .env)
LOCAL_PORT=$(sed -n 's/^DAMAIL_PORT=//p' .env)
DIR_ABS=$(pwd)
LOCAL="http://localhost:${LOCAL_PORT:-8787}"
echo
if [ -n "$ZH" ]; then
  cat <<EOF
DaMail 已启动 🎉

  打开      $URL$([ "$URL" = "$LOCAL" ] || printf '（本机 %s）' "$LOCAL")
  安装目录  $DIR_ABS
  升级      再运行一次安装命令，或在安装目录执行 docker compose pull && docker compose up -d

第一次打开时创建管理员账号。请备份 $DIR_ABS/.env，MASTER_KEY 丢失后已保存的邮箱需要重新添加。
配置域名和 HTTPS：https://damail.app/zh/docs/quick-start/
EOF
else
  cat <<EOF
DaMail is running 🎉

  Open       $URL$([ "$URL" = "$LOCAL" ] || printf ' (on this machine: %s)' "$LOCAL")
  Directory  $DIR_ABS
  Upgrade    run the install command again, or docker compose pull && docker compose up -d in the directory

Create the admin account on first visit. Back up $DIR_ABS/.env: if MASTER_KEY is lost, saved mailboxes must be added again.
Domain and HTTPS setup: https://damail.app/docs/quick-start/
EOF
fi
