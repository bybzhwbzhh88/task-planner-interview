#!/usr/bin/env bash
#
# 额度处理验收脚本（AC-01 ~ AC-07）
#
# 前置：
#   1. dev server 已启动（wasp start），并把输出写进日志文件：
#        wasp start 2>&1 | tee /tmp/wasp.log
#   2. 有 psql 可连到同一个库（默认读 .env.server 里的 DATABASE_URL）
#   3. 数据库账号需能建触发器（仅 AC-04 用；脚本自行创建，退出时连同函数一起删除）
#
# 用法：
#   bash scripts/verify-quota.sh
#   bash scripts/verify-quota.sh --log /tmp/wasp.log
#   bash scripts/verify-quota.sh --base http://localhost:3001 --db "postgresql://..."
#
# 说明：
#   --log 不传时，跳过「模型是否被调用」的断言（需要读服务端日志），
#   其余基于 HTTP 码与数据库余额的断言照常执行。
#   脚本会新建一个临时账号 verify_<随机数>，不影响已有数据。

set -uo pipefail

BASE=${BASE:-http://localhost:3001}
LOG=${LOG:-}
DB=${DB:-}

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --log)  LOG="$2";  shift 2 ;;
    --db)   DB="$2";   shift 2 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

if [ -z "$DB" ]; then
  if [ -f .env.server ]; then
    DB=$(grep -E '^DATABASE_URL=' .env.server | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  fi
fi
if [ -z "$DB" ]; then
  echo "找不到 DATABASE_URL，请用 --db 指定，或在项目根目录运行本脚本"; exit 2
fi

PASS=0; FAIL=0; SKIP=0
check() { # 名称 期望 实际
  if [ "$2" = "$3" ]; then
    PASS=$((PASS+1)); printf '    \033[32m✓\033[0m %-28s %s\n' "$1" "$3"
  else
    FAIL=$((FAIL+1)); printf '    \033[31m✗\033[0m %-28s 期望 %s，实际 %s\n' "$1" "$2" "$3"
  fi
}
skip() { SKIP=$((SKIP+1)); printf '    \033[33m-\033[0m %-28s 跳过：%s\n' "$1" "$2"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

PSQL=(psql "$DB" -tA -v ON_ERROR_STOP=1)
q() { "${PSQL[@]}" -c "$1" | tr -d '[:space:]'; }
set_credits() { q "UPDATE \"User\" SET credits=$1 WHERE id='$USERID';" >/dev/null; }
credits() { q "SELECT credits FROM \"User\" WHERE id='$USERID';"; }
plan_count() { q "SELECT count(*) FROM \"PlanResult\" WHERE \"userId\"='$USERID';"; }

api() { # 路径 JSON
  curl -s -X POST "$BASE/operations/$1" -H "Authorization: Bearer $SID" \
    -H 'Content-Type: application/json' -d "$2"
}
plan() { # 输出文件（可选）
  local out=${1:-/dev/null}
  curl -s -X POST "$BASE/operations/generate-plan" -H "Authorization: Bearer $SID" \
    -H 'Content-Type: application/json' -d '{"json":{"hours":8}}' \
    -o "$out" -w '%{http_code}'
}
plan_async() { # 前缀
  curl -s -X POST "$BASE/operations/generate-plan" -H "Authorization: Bearer $SID" \
    -H 'Content-Type: application/json' -d '{"json":{"hours":8}}' \
    -o "/tmp/vq_$1.json" -w '%{http_code}\n' > "/tmp/vq_$1.code"
}
mark() { [ -n "$LOG" ] && wc -l < "$LOG" || echo 0; }
since() { tail -n +$(($1+1)) "$LOG"; }
count_started() { since "$1" | grep -c 'mock-ai.started'; }
count_failed() { since "$1" | grep -c 'mock-ai.failed'; }
clean_fail() { q "DELETE FROM \"Task\" WHERE description LIKE '[fail]%' AND \"userId\"='$USERID';" >/dev/null; }

# AC-04 用：装一个只对本账号生效的 BEFORE INSERT 触发器，让「模型成功、落库失败」可复现。
TRIGGER_ON=0
trigger_on() {
  q "CREATE OR REPLACE FUNCTION vq_fail_planresult() RETURNS trigger AS \$\$ BEGIN RAISE EXCEPTION 'vq simulated insert failure'; END; \$\$ LANGUAGE plpgsql;" >/dev/null
  q "DROP TRIGGER IF EXISTS vq_fail_planresult ON \"PlanResult\";" >/dev/null 2>&1
  q "CREATE TRIGGER vq_fail_planresult BEFORE INSERT ON \"PlanResult\" FOR EACH ROW WHEN (NEW.\"userId\" = '$USERID') EXECUTE FUNCTION vq_fail_planresult();" >/dev/null
  TRIGGER_ON=1
}
trigger_off() {
  q "DROP TRIGGER IF EXISTS vq_fail_planresult ON \"PlanResult\";" >/dev/null 2>&1
  q "DROP FUNCTION IF EXISTS vq_fail_planresult();" >/dev/null 2>&1
  TRIGGER_ON=0
}
# 中断退出也必须撤掉触发器，否则后续用例都会被它带崩。
cleanup() { [ "$TRIGGER_ON" = "1" ] && trigger_off >/dev/null 2>&1; }
trap cleanup EXIT

# ---------- 建临时账号 ----------
U="verify_$RANDOM$RANDOM"
PW="verify1234"
curl -s -X POST "$BASE/auth/username/signup" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"$PW\"}" -o /dev/null
SID=$(curl -s -X POST "$BASE/auth/username/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"$PW\"}" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
if [ -z "$SID" ]; then echo "登录失败，检查 dev server 是否在 $BASE 运行"; exit 2; fi

UID_ROW=$(q "SELECT u.id FROM \"User\" u JOIN \"Auth\" a ON a.\"userId\"=u.id JOIN \"AuthIdentity\" ai ON ai.\"authId\"=a.id WHERE ai.\"providerUserId\"='$U';")
if [ -z "$UID_ROW" ]; then echo "数据库里找不到刚创建的账号，检查 --db 是否指向同一个库"; exit 2; fi
USERID="$UID_ROW"

api create-task '{"json":{"description":"写周报"}}' >/dev/null
api create-task '{"json":{"description":"准备面试"}}' >/dev/null

echo "临时账号: $U"
echo "服务地址: $BASE"
[ -n "$LOG" ] && echo "日志文件: $LOG" || echo "日志文件: 未提供（跳过模型调用断言）"

# ---------- AC-01 ----------
section "AC-01 正常生成消耗 1 次"
set_credits 3
B=$(plan_count)
CODE=$(plan /tmp/vq_ac01.json)
check "HTTP" 200 "$CODE"
check "credits" 2 "$(credits)"
check "PlanResult 新增" 1 "$(( $(plan_count) - B ))"
check "getMyCredits" 2 "$(api get-my-credits '{"json":{}}' | sed -n 's/.*"json":\([0-9]*\).*/\1/p')"

# ---------- AC-02 ----------
section "AC-02 额度为 0 时不发起模型调用"
set_credits 0
M=$(mark)
CODE=$(plan /tmp/vq_ac02.json)
check "HTTP" 402 "$CODE"
check "credits 不变" 0 "$(credits)"
if [ -n "$LOG" ]; then
  check "mock-ai.started" 0 "$(count_started "$M")"
else
  skip "mock-ai.started" "需要 --log"
fi

# ---------- AC-03 ----------
section "AC-03 模型失败不消耗额度"
set_credits 2
api create-task '{"json":{"description":"[fail] 准备面试"}}' >/dev/null
M=$(mark)
CODE=$(plan /tmp/vq_ac03.json)
check "HTTP" 424 "$CODE"
check "credits 退回" 2 "$(credits)"
if [ -n "$LOG" ]; then
  check "mock-ai.started" 1 "$(count_started "$M")"
  check "mock-ai.failed" 1 "$(count_failed "$M")"
else
  skip "mock-ai 计数" "需要 --log"
fi
clean_fail

# ---------- AC-04 ----------
section "AC-04 落库失败不消耗额度"
set_credits 2
B=$(plan_count); M=$(mark)
trigger_on
check "触发器已就位" 1 "$(q "SELECT count(*) FROM pg_trigger WHERE tgname='vq_fail_planresult';")"
CODE=$(plan /tmp/vq_ac04.json)
check "HTTP" 424 "$CODE"
check "credits 退回" 2 "$(credits)"
check "PlanResult 未新增" 0 "$(( $(plan_count) - B ))"
if [ -n "$LOG" ]; then
  check "mock-ai.started" 1 "$(count_started "$M")"
  # 失败发生在 INSERT，不在模型侧，所以不该出现 failed
  check "mock-ai.failed" 0 "$(count_failed "$M")"
else
  skip "mock-ai 计数" "需要 --log"
fi
trigger_off
check "触发器已清理" 0 "$(q "SELECT count(*) FROM pg_trigger WHERE tgname='vq_fail_planresult';")"

# ---------- AC-05 ----------
section "AC-05 并发不透支：credits=1，并发 2"
set_credits 1
B=$(plan_count); M=$(mark)
rm -f /tmp/vq_ac05_*.code
for i in 1 2; do plan_async "ac05_$i" & done; wait
OK200=$(cat /tmp/vq_ac05_*.code | grep -c '^200$'); OK402=$(cat /tmp/vq_ac05_*.code | grep -c '^402$')
check "成功数" 1 "$OK200"
check "拒绝数" 1 "$OK402"
check "credits" 0 "$(credits)"
check "PlanResult 新增" 1 "$(( $(plan_count) - B ))"
if [ -n "$LOG" ]; then check "mock-ai.started" 1 "$(count_started "$M")"; else skip "mock-ai.started" "需要 --log"; fi

# ---------- AC-06 ----------
section "AC-06 并发放大：credits=2，并发 5"
set_credits 2
B=$(plan_count); M=$(mark)
rm -f /tmp/vq_ac06_*.code
for i in 1 2 3 4 5; do plan_async "ac06_$i" & done; wait
OK200=$(cat /tmp/vq_ac06_*.code | grep -c '^200$'); OK402=$(cat /tmp/vq_ac06_*.code | grep -c '^402$')
check "成功数" 2 "$OK200"
check "拒绝数" 3 "$OK402"
check "credits" 0 "$(credits)"
check "PlanResult 新增" 2 "$(( $(plan_count) - B ))"
if [ -n "$LOG" ]; then check "mock-ai.started" 2 "$(count_started "$M")"; else skip "mock-ai.started" "需要 --log"; fi

# ---------- AC-07 ----------
section "AC-07 并发中失败退还的净额"
set_credits 3
api create-task '{"json":{"description":"[fail] 准备面试"}}' >/dev/null
M=$(mark)
rm -f /tmp/vq_ac07_*.code
for i in 1 2 3 4 5; do plan_async "ac07_$i" & done; wait
check "credits 回到 3" 3 "$(credits)"
NEG=$(q "SELECT count(*) FROM \"User\" WHERE id='$USERID' AND credits < 0;")
check "余额从未为负" 0 "$NEG"
if [ -n "$LOG" ]; then
  check "started 与 failed 相等" "$(count_started "$M")" "$(count_failed "$M")"
else
  skip "started/failed 对比" "需要 --log"
fi
clean_fail

# ---------- 汇总 ----------
printf '\n\033[1m汇总\033[0m  通过 %d / 失败 %d / 跳过 %d\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] && { echo "全部通过"; exit 0; } || { echo "有用例未通过"; exit 1; }
