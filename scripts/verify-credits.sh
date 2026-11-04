#!/usr/bin/env bash
# 可重复执行的额度验证脚本（对应 SPEC.md 的 AC-1 ~ AC-10）
#
# 用法:
#   bash scripts/verify-credits.sh [--base http://localhost:3001] [--log <应用日志路径>]
#
# 前置:
#   1. 本地 PostgreSQL 已启动，且已执行 wasp db migrate-dev
#   2. wasp start 正在运行，其标准输出被重定向到 --log 指定的文件
#      （脚本靠统计该日志中的 mock-ai.started 次数，证明「额度不足时未调用模型」）
#
# 鉴权: Wasp 0.25 的 login 返回 {"sessionId": "<jwt>"}，
#       后续请求需带 Authorization: Bearer <sessionId>（不是 cookie）。
#
# 退出码: 0 = 全部通过；1 = 有断言失败；2 = 参数或环境错误
set -u

BASE="http://localhost:3001"
APP_LOG="${APP_LOG:-$HOME/app_fg.log}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --log)  APP_LOG="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

BIN="${PG_BIN:-$HOME/.local/pgroot/usr/lib/postgresql/16/bin}"
export LD_LIBRARY_PATH="$HOME/.local/pgroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
PSQL="$BIN/psql -h 127.0.0.1 -p 5432 -U postgres -d task_planner -tA"

[ -x "$BIN/psql" ] || { echo "psql not found at $BIN" >&2; exit 2; }
[ -f "$APP_LOG" ]  || { echo "app log not found: $APP_LOG" >&2; exit 2; }

PASS=0; FAIL=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
# 不要命名为 head，会覆盖 coreutils 的 head
section() { echo; echo "===== $1 ====="; }

sql() { $PSQL -c "$1" 2>/dev/null; }
set_credits() { sql "UPDATE \"User\" SET credits=$2 WHERE id='$1';" >/dev/null; }
get_credits() { sql "SELECT credits FROM \"User\" WHERE id='$1';"; }
plan_count()  { sql "SELECT count(*) FROM \"PlanResult\" WHERE \"userId\"='$1';"; }
started_count() { grep -c 'mock-ai\.started' "$APP_LOG" || true; }

BODY_HOURS='{"json":{"hours":8}}'
OUT=$(mktemp)

add_task() {
  curl -s -o /dev/null --max-time 20 -H "Authorization: Bearer $TOKEN" \
    -X POST "$BASE/operations/create-task" \
    -H 'Content-Type: application/json' -d "{\"json\":{\"description\":\"$1\"}}"
}
gen() {  # 回显 HTTP 状态码，正文写入 $OUT
  curl -s -o "$OUT" -w '%{http_code}' --max-time 30 -H "Authorization: Bearer $TOKEN" \
    -X POST "$BASE/operations/generate-plan" -H 'Content-Type: application/json' -d "$BODY_HOURS"
}
gen_concurrent() {  # $1=输出目录 $2=序号
  curl -s -o "$1/b$2" -w '%{http_code}' --max-time 60 -H "Authorization: Bearer $TOKEN" \
    -X POST "$BASE/operations/generate-plan" -H 'Content-Type: application/json' \
    -d "$BODY_HOURS" > "$1/c$2"
}

# ────────── 准备账号 ──────────
U="verify$(date +%s)$RANDOM"
P="Passw0rd!23"
section "准备：注册并登录测试账号 $U"
CODE=$(curl -s -o "$OUT" -w '%{http_code}' --max-time 20 -X POST "$BASE/auth/username/signup" \
  -H 'Content-Type: application/json' -d "{\"username\":\"$U\",\"password\":\"$P\"}")
echo "  signup -> $CODE"

CODE=$(curl -s -o "$OUT" -w '%{http_code}' --max-time 20 -X POST "$BASE/auth/username/login" \
  -H 'Content-Type: application/json' -d "{\"username\":\"$U\",\"password\":\"$P\"}")
TOKEN=$(grep -o '"sessionId":"[^"]*"' "$OUT" | cut -d'"' -f4)
if [ "$CODE" = "200" ] && [ -n "$TOKEN" ]; then
  ok "登录成功 (HTTP 200)，取得 sessionId（长度 ${#TOKEN}）"
else
  bad "登录失败 (HTTP $CODE)"; cat "$OUT"; exit 1
fi

# 注意：UID 是 bash 只读变量，这里必须用别的名字
USER_ID=$(sql "SELECT a.\"userId\" FROM \"AuthIdentity\" ai JOIN \"Auth\" a ON a.id=ai.\"authId\" WHERE ai.\"providerUserId\"='$U';")
[ -n "$USER_ID" ] && ok "userId=$USER_ID，初始 credits=$(get_credits "$USER_ID")" || { bad "取不到 userId"; exit 1; }

# 确认鉴权真的通了
CODE=$(curl -s -o "$OUT" -w '%{http_code}' --max-time 20 -H "Authorization: Bearer $TOKEN" \
  -X POST "$BASE/operations/get-credit-balance" -H 'Content-Type: application/json' -d '{"json":{}}')
BAL=$(grep -o '"credits":[0-9]*' "$OUT" | cut -d: -f2)
[ "$CODE" = "200" ] && ok "get-credit-balance 可用，返回 credits=$BAL" || bad "额度查询失败 (HTTP $CODE)"

# ────────── AC-9 / AC-10 ──────────
section "AC-9 未登录被拒"
CODE=$(curl -s -o "$OUT" -w '%{http_code}' --max-time 20 -X POST "$BASE/operations/generate-plan" \
  -H 'Content-Type: application/json' -d "$BODY_HOURS")
[ "$CODE" = "401" ] && ok "无 Authorization 头返回 401" || bad "期望 401，实际 $CODE"

section "AC-10 入参非法"
CODE=$(curl -s -o "$OUT" -w '%{http_code}' --max-time 20 -H "Authorization: Bearer $TOKEN" \
  -X POST "$BASE/operations/generate-plan" -H 'Content-Type: application/json' \
  -d '{"json":{"hours":"not-a-number"}}')
C=$(get_credits "$USER_ID")
[ "$CODE" = "400" ] && ok "非法 hours 返回 400" || bad "期望 400，实际 $CODE"
[ "$C" = "3" ] && ok "额度未被扣除 (credits=3)" || bad "期望 3，实际 $C"

# ────────── AC-1 ──────────
section "AC-1 成功生成扣 1 额度"
add_task "写周报"
set_credits "$USER_ID" 3
S0=$(started_count); CODE=$(gen); S1=$(started_count)
C=$(get_credits "$USER_ID"); PR=$(plan_count "$USER_ID")
[ "$CODE" = "200" ] && ok "生成返回 200" || bad "期望 200，实际 $CODE"
[ "$C" = "2" ] && ok "credits 3 -> 2" || bad "期望 2，实际 $C"
[ "$PR" = "1" ] && ok "PlanResult 新增 1 行" || bad "期望 1，实际 $PR"
[ "$((S1-S0))" = "1" ] && ok "mock-ai.started +1（模型确实被调用）" || bad "started 增量=$((S1-S0))"

# ────────── AC-2 ──────────
section "AC-2 连续 3 次用尽额度"
set_credits "$USER_ID" 3
for i in 1 2 3; do
  CODE=$(gen); [ "$CODE" = "200" ] || bad "第 $i 次期望 200，实际 $CODE"
done
C=$(get_credits "$USER_ID")
[ "$C" = "0" ] && ok "3 次成功后 credits=0" || bad "期望 0，实际 $C"

# ────────── AC-3 核心 ──────────
section "AC-3 额度不足不调用模型（核心案例）"
set_credits "$USER_ID" 0
PR0=$(plan_count "$USER_ID"); S0=$(started_count)
CODE=$(gen); S1=$(started_count)
C=$(get_credits "$USER_ID"); PR1=$(plan_count "$USER_ID")
[ "$CODE" = "402" ] && ok "返回 402" || bad "期望 402，实际 $CODE"
[ "$C" = "0" ] && ok "credits 保持 0，未透支" || bad "期望 0，实际 $C"
[ "$((PR1-PR0))" = "0" ] && ok "PlanResult 无新增" || bad "新增=$((PR1-PR0))"
if [ "$((S1-S0))" = "0" ]; then
  ok "mock-ai.started 增量 0 —— 证明额度不足时未发起模型调用"
else
  bad "mock-ai.started 增量=$((S1-S0))，额度不足却调用了模型"
fi
echo "  402 正文: $(cut -c1-170 "$OUT")"

# ────────── AC-4 ──────────
section "AC-4 模型明确失败不扣额度"
add_task "这个任务 [fail] 会失败"
set_credits "$USER_ID" 3
PR0=$(plan_count "$USER_ID"); S0=$(started_count)
CODE=$(gen); S1=$(started_count)
C=$(get_credits "$USER_ID"); PR1=$(plan_count "$USER_ID")
[ "$CODE" = "502" ] && ok "返回 502（模型失败，区别于保存失败的 500）" || bad "期望 502，实际 $CODE"
[ "$C" = "3" ] && ok "credits 回补为 3，净变化 0" || bad "期望 3，实际 $C"
[ "$((PR1-PR0))" = "0" ] && ok "PlanResult 无新增" || bad "新增=$((PR1-PR0))"
[ "$((S1-S0))" = "1" ] && ok "mock-ai.started +1（调用已发起后失败）" || bad "started 增量=$((S1-S0))"
echo "  502 正文: $(cut -c1-170 "$OUT")"

# ────────── AC-5 ──────────
section "AC-5 删除 [fail] 任务后恢复成功"
sql "DELETE FROM \"Task\" WHERE \"userId\"='$USER_ID' AND description LIKE '%[fail]%';" >/dev/null
set_credits "$USER_ID" 3
CODE=$(gen); C=$(get_credits "$USER_ID")
[ "$CODE" = "200" ] && ok "返回 200" || bad "期望 200，实际 $CODE"
[ "$C" = "2" ] && ok "credits 3 -> 2" || bad "期望 2，实际 $C"

# ────────── 并发 ──────────
run_concurrent() {
  N=$1; CREDITS=$2; LABEL=$3
  section "$LABEL"
  set_credits "$USER_ID" "$CREDITS"
  PR0=$(plan_count "$USER_ID"); S0=$(started_count)
  TMPD=$(mktemp -d)
  for i in $(seq 1 "$N"); do gen_concurrent "$TMPD" "$i" & done
  wait
  OKN=0; REJN=0; OTHN=0
  for i in $(seq 1 "$N"); do
    case "$(cat "$TMPD/c$i" 2>/dev/null)" in
      200) OKN=$((OKN+1));;
      402) REJN=$((REJN+1));;
      *)   OTHN=$((OTHN+1)); echo "    意外状态码: $(cat "$TMPD/c$i" 2>/dev/null)";;
    esac
  done
  S1=$(started_count); C=$(get_credits "$USER_ID"); PR1=$(plan_count "$USER_ID")
  EXPECT=$(( N < CREDITS ? N : CREDITS ))
  echo "  并发 $N 个请求，初始额度 $CREDITS，期望成功 $EXPECT"
  echo "  -> 200:$OKN  402:$REJN  其他:$OTHN"
  echo "  -> 最终 credits=$C，PlanResult 新增=$((PR1-PR0))，mock-ai.started 增量=$((S1-S0))"
  [ "$OKN" = "$EXPECT" ] && ok "成功数 $OKN == min($N,$CREDITS)" || bad "期望成功 $EXPECT，实际 $OKN"
  [ "$REJN" = "$((N-EXPECT))" ] && ok "拒绝数 $((N-EXPECT)) 且均为 402" || bad "期望拒绝 $((N-EXPECT))，实际 $REJN"
  [ "$OTHN" = "0" ] && ok "无意外状态码" || bad "出现 $OTHN 个意外状态码"
  [ "$C" = "0" ] && ok "credits 归 0，未变负数" || bad "期望 0，实际 $C"
  [ "$((PR1-PR0))" = "$EXPECT" ] && ok "PlanResult 新增 $EXPECT 行，与成功数一致" || bad "新增=$((PR1-PR0))"
  [ "$((S1-S0))" = "$EXPECT" ] && ok "started 增量 $EXPECT，被拒请求未触达模型" || bad "started 增量=$((S1-S0))"
  rm -rf "$TMPD"
}

run_concurrent 5 1 "AC-6 并发不透支（额度 1，同时发 5 个）"
run_concurrent 5 3 "AC-7 并发不透支（额度 3，同时发 5 个）"

section "AC-8 并发 + 模型失败混合（额度 2，同时发 4 个）"
# 预期推导：额度只有 2，故仅 2 个请求能预占成功并调用模型（随后失败 -> 502 且回补），
# 另 2 个请求预占失败 -> 402 且不触达模型。started 增量 == 预占成功数 == 2。
# 若出现 4 个 502，说明额度不足时仍调用了模型，违反 AC-3。
add_task "并发失败 [fail]"
set_credits "$USER_ID" 2
PR0=$(plan_count "$USER_ID"); S0=$(started_count)
TMPD=$(mktemp -d)
for i in 1 2 3 4; do gen_concurrent "$TMPD" "$i" & done
wait
N502=0; N402=0; NOTH=0
for i in 1 2 3 4; do
  case "$(cat "$TMPD/c$i" 2>/dev/null)" in
    502) N502=$((N502+1));;
    402) N402=$((N402+1));;
    *)   NOTH=$((NOTH+1)); echo "    意外状态码: $(cat "$TMPD/c$i" 2>/dev/null)";;
  esac
done
S1=$(started_count); C=$(get_credits "$USER_ID"); PR1=$(plan_count "$USER_ID")
echo "  -> 502:$N502  402:$N402  其他:$NOTH"
echo "  -> 最终 credits=$C，PlanResult 新增=$((PR1-PR0))，started 增量=$((S1-S0))"
[ "$N502" = "2" ] && ok "恰好 2 个 502（预占成功者调用模型后失败）" || bad "期望 2 个 502，实际 $N502"
[ "$N402" = "2" ] && ok "恰好 2 个 402（预占失败者未触达模型）" || bad "期望 2 个 402，实际 $N402"
[ "$NOTH" = "0" ] && ok "无意外状态码" || bad "出现 $NOTH 个意外状态码"
[ "$C" = "2" ] && ok "credits 回补为 2，净变化 0" || bad "期望 2，实际 $C"
[ "$((PR1-PR0))" = "0" ] && ok "PlanResult 无新增" || bad "新增=$((PR1-PR0))"
[ "$((S1-S0))" = "2" ] && ok "started 增量 2 == 预占成功数，被拒请求未触达模型" || bad "started 增量=$((S1-S0))，期望 2"
rm -rf "$TMPD"

section "AC-12 保存结果失败时回补额度"
# 用数据库触发器注入真实的 INSERT 失败，无需改动产品代码或 mock 依赖。
# 触发器在断言结束后立即删除，脚本整体保持可重复执行。
sql "DELETE FROM \"Task\" WHERE \"userId\"='$USER_ID' AND description LIKE '%[fail]%';" >/dev/null
cleanup_trigger() {
  sql "DROP TRIGGER IF EXISTS trg_inject_persist_failure ON \"PlanResult\";" >/dev/null
  sql "DROP FUNCTION IF EXISTS inject_persist_failure();" >/dev/null
}
cleanup_trigger
sql "CREATE FUNCTION inject_persist_failure() RETURNS trigger AS \$\$
       BEGIN RAISE EXCEPTION 'injected persist failure (AC-12)'; END;
     \$\$ LANGUAGE plpgsql;" >/dev/null
sql "CREATE TRIGGER trg_inject_persist_failure BEFORE INSERT ON \"PlanResult\"
     FOR EACH ROW EXECUTE FUNCTION inject_persist_failure();" >/dev/null

set_credits "$USER_ID" 3
PR0=$(plan_count "$USER_ID"); S0=$(started_count)
CODE=$(gen); S1=$(started_count)
C=$(get_credits "$USER_ID"); PR1=$(plan_count "$USER_ID")
cleanup_trigger   # 先清理，避免注入状态泄漏到后续步骤

[ "$CODE" = "500" ] && ok "保存失败返回 500（区别于模型失败的 502）" || bad "期望 500，实际 $CODE"
[ "$C" = "3" ] && ok "credits 回补为 3，净变化 0" || bad "期望 3，实际 $C"
[ "$((PR1-PR0))" = "0" ] && ok "PlanResult 无新增（写入确实失败）" || bad "新增=$((PR1-PR0))"
[ "$((S1-S0))" = "1" ] && ok "started 增量 1（预占成功、模型已调用，随后保存失败）" || bad "started 增量=$((S1-S0))"
echo "  500 正文: $(cut -c1-170 "$OUT")"

# 清理后确认系统恢复正常，证明注入没有留下副作用
section "AC-12b 移除注入后恢复正常"
CODE=$(gen); C=$(get_credits "$USER_ID")
[ "$CODE" = "200" ] && ok "触发器移除后生成恢复 200" || bad "期望 200，实际 $CODE"
[ "$C" = "2" ] && ok "credits 3 -> 2" || bad "期望 2，实际 $C"

echo
echo "=============================="
echo " 通过 $PASS 项，失败 $FAIL 项"
echo "=============================="
rm -f "$OUT"
[ "$FAIL" = "0" ] || exit 1
