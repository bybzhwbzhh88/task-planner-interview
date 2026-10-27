#!/usr/bin/env bash
# =============================================================================
# WSL 一键验证脚本 —— task-planner-interview 额度处理改动
#
# 背景：Windows 上 Wasp CLI 无发行版，验证需在 WSL (Ubuntu 22.04) 内完成。
# 本脚本把「装环境 → 拉代码 → 建表 → 跑验证 → 编译检查」串成一条命令，
# 输出全部落盘到 ~/verify-logs/，方便直接贴回或归档。
#
# 用法：
#   bash scripts/wsl-verify.sh              # 静态检查 + 数据库层验证（A0-A5）
#   bash scripts/wsl-verify.sh --with-page  # 额外启动 wasp start 做页面冒烟
#
# 幂等：可重复执行，不会破坏已有环境。
# =============================================================================
set -uo pipefail

REPO_URL="https://github.com/seven710z/task-planner-interview.git"
BRANCH="quota-handling"
WORK="$HOME/task-planner-interview"
LOG_DIR="$HOME/verify-logs"
NODE_MAJOR=24
WASP_VERSION="0.25.0"
PG_PORT=5433          # Windows 侧 PostgreSQL 端口（WSL 内 localhost 可转发访问）
PG_DB="quota_verify"
DATABASE_URL="postgresql://postgres@localhost:${PG_PORT}/${PG_DB}"

WITH_PAGE=0
[ "${1:-}" = "--with-page" ] && WITH_PAGE=1

mkdir -p "$LOG_DIR"
ts() { date "+%H:%M:%S"; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_DIR/run.log"; }
fail() { log "FAILED: $*"; exit 1; }

# ---------------------------------------------------------------------------
log "=== 0. 记录环境 ==="
{
  echo "date: $(date)"
  echo "uname: $(uname -a)"
  echo "node: $(node -v 2>/dev/null || echo missing)"
  echo "npm: $(npm -v 2>/dev/null || echo missing)"
  echo "wasp: $(wasp version 2>/dev/null || echo missing)"
} | tee "$LOG_DIR/env.txt"

# ---------------------------------------------------------------------------
log "=== 1. Node ${NODE_MAJOR} ==="
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  log "installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >>"$LOG_DIR/run.log" 2>&1 \
    || fail "nvm install failed"
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_MAJOR" >>"$LOG_DIR/run.log" 2>&1 || fail "nvm install node $NODE_MAJOR"
nvm use "$NODE_MAJOR" >>"$LOG_DIR/run.log" 2>&1 || fail "nvm use node $NODE_MAJOR"
log "node ready: $(node -v)"

# ---------------------------------------------------------------------------
log "=== 2. 代码（ext4 内部，勿用 /mnt）==="
if [ -d "$WORK/.git" ]; then
  cd "$WORK" || fail "cd $WORK"
  git fetch origin >>"$LOG_DIR/run.log" 2>&1 || log "WARN: git fetch 失败，沿用本地代码"
  git checkout "$BRANCH" >>"$LOG_DIR/run.log" 2>&1 || fail "git checkout"
  git pull --ff-only >>"$LOG_DIR/run.log" 2>&1 || log "WARN: git pull not fast-forward, keep local HEAD"
else
  git clone "$REPO_URL" "$WORK" >>"$LOG_DIR/run.log" 2>&1 || fail "git clone"
  cd "$WORK" || fail "cd $WORK"
  git checkout "$BRANCH" >>"$LOG_DIR/run.log" 2>&1 || fail "git checkout $BRANCH"
fi
log "HEAD: $(git rev-parse --short HEAD)  branch: $(git rev-parse --abbrev-ref HEAD)"

# ---------------------------------------------------------------------------
log "=== 3. Wasp CLI ${WASP_VERSION} ==="
if ! command -v wasp >/dev/null 2>&1; then
  npm install -g "@wasp.sh/wasp-cli@${WASP_VERSION}" >>"$LOG_DIR/run.log" 2>&1 \
    || fail "wasp-cli install failed"
fi
log "wasp: $(wasp version 2>&1 | tail -1)"

log "=== 3b. wasp install（生成 .wasp + node_modules，可能数分钟）==="
wasp install >>"$LOG_DIR/wasp-install.log" 2>&1 || { tail -30 "$LOG_DIR/wasp-install.log"; fail "wasp install"; }
log "wasp install ok"

# ---------------------------------------------------------------------------
log "=== 4. PostgreSQL ==="
if ! (exec 3<>"/dev/tcp/localhost/$PG_PORT") 2>/dev/null; then
  log "WARN: localhost:$PG_PORT 不可达（Windows 侧 PG 未启动？）"
  log "      请在 Windows 上先启动 PostgreSQL；或在 WSL 内 sudo apt install postgresql"
  log "      本脚本继续尝试，建表步骤可能失败"
fi
export DATABASE_URL
log "DATABASE_URL=$DATABASE_URL"

log "=== 4b. 建表 ==="
npx prisma db push --schema schema.prisma --skip-generate \
  >>"$LOG_DIR/prisma-push.log" 2>&1 || { tail -30 "$LOG_DIR/prisma-push.log"; fail "prisma db push"; }
log "schema pushed"

# ---------------------------------------------------------------------------
log "=== 5. 额度逻辑验证（A0-A5，28 断言）==="
# 项目根只声明了 prisma CLI（devDependencies），没有 @prisma/client 与 esbuild；
# 脚本需要这两者，因此准备一个独立的工具目录（与 SUBMISSION.md 记录的方式一致）。
TOOLS="$HOME/quota-tools"
if [ ! -d "$TOOLS/node_modules/@prisma/client" ]; then
  log "准备验证工具目录 $TOOLS（@prisma/client@5.19.1 + esbuild）..."
  mkdir -p "$TOOLS"
  cp schema.prisma "$TOOLS/schema.prisma"
  (
    cd "$TOOLS" || exit 1
    npm init -y >/dev/null 2>&1
    npm install @prisma/client@5.19.1 prisma@5.19.1 esbuild
    npx prisma generate --schema schema.prisma
  ) >> "$LOG_DIR/tools-install.log" 2>&1 \
    || { tail -25 "$LOG_DIR/tools-install.log"; fail "验证工具依赖准备失败"; }
  log "工具目录就绪"
fi
# 脚本用 createRequire 从 PRISMA_CLIENT_DIR 加载 @prisma/client；仓库 node_modules 里没有
PRISMA_CLIENT_DIR="$TOOLS" node scripts/verify-quota.mjs \
  > "$LOG_DIR/verify-quota.log" 2>&1
verify_rc=$?
tail -40 "$LOG_DIR/verify-quota.log"
[ $verify_rc -eq 0 ] || fail "verify-quota.mjs exit=$verify_rc"
log "数据库层验证通过"

# ---------------------------------------------------------------------------
log "=== 6. 编译与类型检查 ==="
wasp compile >>"$LOG_DIR/wasp-compile.log" 2>&1 || { tail -40 "$LOG_DIR/wasp-compile.log"; fail "wasp compile"; }
log "wasp compile ok"

npx tsc --project tsconfig.src.json --noEmit >>"$LOG_DIR/tsc-src.log" 2>&1 \
  || { tail -40 "$LOG_DIR/tsc-src.log"; fail "tsc --project tsconfig.src.json"; }
log "tsc src ok"

npx tsc --project tsconfig.wasp.json --noEmit >>"$LOG_DIR/tsc-wasp.log" 2>&1 \
  || { tail -40 "$LOG_DIR/tsc-wasp.log"; fail "tsc --project tsconfig.wasp.json"; }
log "tsc wasp ok"

# ---------------------------------------------------------------------------
if [ "$WITH_PAGE" = "1" ]; then
  log "=== 7. 页面冒烟（wasp start 后台 + curl）==="
  wasp start >>"$LOG_DIR/wasp-start.log" 2>&1 &
  wasp_pid=$!
  ok=0
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null http://localhost:3000 2>>"$LOG_DIR/wasp-start.log"; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" = "1" ]; then
    log "HTTP 200 from localhost:3000"
    curl -fsS http://localhost:3000/demo-app -o /dev/null -w "demo-app status=%{http_code}\n" \
      | tee -a "$LOG_DIR/page-smoke.log"
  else
    log "WARN: 60 秒内未起来，见 wasp-start.log"
  fi
  kill "$wasp_pid" 2>/dev/null || true
  sleep 2
  kill -9 "$wasp_pid" 2>/dev/null || true
  log "wasp start 已停止"
fi

log "=== 全部完成，日志目录：$LOG_DIR ==="
ls -la "$LOG_DIR"
