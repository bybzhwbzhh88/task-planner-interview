# 验证记录

> 结论：数据库层验证 **6/6 场景、28 条断言全部通过**（含基线问题复现）。环境与命令可复现，原始输出见下文。`wasp compile` / Wasp 侧 `tsc --noEmit` / 页面端到端**未运行**（Windows 装不了 Wasp CLI，原因见 `SPEC.md` 第 7 节），已在文末明确标注。

## 环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-26 |
| 系统 | Windows 10（22H2） |
| Node | v24.15.0 |
| PostgreSQL | 16.9（EDB 原生二进制，本机端口 5433，数据库 `quota_verify`） |
| Prisma | CLI / Client 5.19.1（工具目录独立安装） |
| 验证脚本 | `scripts/verify-quota.mjs`（esbuild 打包仓库真实源码后加载） |

## 命令（可复现）

```bash
# 工具目录（Windows 无法安装 Wasp CLI 时的替代路径）
mkdir quota-tools && cd quota-tools && npm init -y
npm install @prisma/client@5.19.1 prisma@5.19.1 esbuild typescript zod

export DATABASE_URL="postgresql://postgres@localhost:5433/quota_verify"
npx prisma db push --schema ../task-planner-interview/schema.prisma

PRISMA_CLIENT_DIR=$(pwd) node ../task-planner-interview/scripts/verify-quota.mjs
```

实际执行（Git Bash，Windows）：

```bash
cd /d/WorkBuddy/.pgtool
export DATABASE_URL="postgresql://postgres@localhost:5433/quota_verify" PRISMA_CLIENT_DIR="D:/WorkBuddy/.pgtool"
/d/node.exe D:/WorkBuddy/task-planner-interview/scripts/verify-quota.mjs
```

## 结果

```text
========== 验证结果 ==========
PASS  A0 基线对照（PASS = 旧逻辑的问题被复现）
      ✓ 基线额度为 0 时模型仍被调用 1 次（复现 P1：调用发生在判断之前）
      ✓ 基线并发 10 请求后 credits = -9（复现 P2/P3：额度透支）
      ✓ 基线并发时模型被调用 10 次，额度只有 1（复现超发调用）
PASS  A1 成功生成
      ✓ 日程包含 2 个任务（预期 2）
      ✓ 返回剩余额度 2（预期 2）
      ✓ 数据库额度 2（预期 2）
      ✓ PlanResult 1 条（预期 1）
      ✓ 模型调用 1 次（预期 1）
PASS  A2 额度不足
      ✓ 抛出 QuotaExhaustedError（预期 QuotaExhaustedError）
      ✓ 模型调用 0 次（预期 0：额度不足不得发起调用）
      ✓ 数据库额度 0（预期 0）
      ✓ PlanResult 0 条（预期 0）
PASS  A3 模型失败
      ✓ 抛出 ProviderError（预期 ProviderError）
      ✓ 模型调用 1 次（预期 1）
      ✓ 数据库额度 2（预期 2：已退还）
      ✓ PlanResult 0 条（预期 0）
PASS  A4 并发不透支（1 额度 / 10 并发）
      ✓ 成功 1 次（预期 1）
      ✓ 额度不足 9 次（预期 9）
      ✓ 其它错误 0 次（预期 0）
      ✓ 数据库额度 0（预期 0，不得为负）
      ✓ PlanResult 1 条（预期 1）
      ✓ 模型调用 1 次（预期 1：失败请求不发起调用）
PASS  A5 并发多额度（3 额度 / 10 并发）
      ✓ 成功 3 次（预期 3）
      ✓ 额度不足 7 次（预期 7）
      ✓ 其它错误 0 次（预期 0）
      ✓ 数据库额度 0（预期 0，不得为负）
      ✓ PlanResult 3 条（预期 3）
      ✓ 模型调用 3 次（预期 3：失败请求不发起调用）
==============================
6/6 个场景通过，断言 28 条。
```

## 日志证据（同一次运行的结构化日志摘录）

说明：日志有两层 `callId`——plan 层（`plan.*` / `credits.*` 事件）由 `generatePlanForUser` 生成，mock 层（`mock-ai.*` 事件）由 `mockAi.ts` 内部生成。两层的关联靠**计数**而不是同一个 ID（本次运行 `mock-ai.started` 共 17 次 = A0 基线 11 次 + 新逻辑 6 次，与各场景断言一致）。

「额度不足 → 未发起调用」的证据是计数而非推断：A2 场景内 `provider` 计数为 0（脚本断言「模型调用 0 次」），即该场景没有产生任何 `mock-ai.started`：

```json
{"event":"credits.exhausted","callId":"ca097989-e885-4050-bd86-cb8820dc04ed","userId":"a9fe7b99-3a62-41dd-9978-0b00ac319256","reserved":false}
```

「占位成功 → 模型失败 → 退还」的成对证据（同一 plan 层 callId `32f23eca`：先 reserved 后 refunded；对应场景里 mock 层打出 `mock-ai.failed`）：

```json
{"event":"credits.reserved","callId":"32f23eca-eb15-4152-b4ff-c8dfdf2f0d3b","userId":"754592b9-19db-4e5c-9afa-57e044245497","reserved":true,"rows":1}
{"event":"mock-ai.failed","callId":"fc56c800-9dc8-465f-96e9-dd666275a9ac"}
{"event":"credits.refunded","callId":"32f23eca-eb15-4152-b4ff-c8dfdf2f0d3b","userId":"754592b9-19db-4e5c-9afa-57e044245497","rows":1}
```

## 类型与语法检查

```bash
# credits.ts / planGeneration.ts 独立严格类型检查（Prisma 类型来自 5.19.1）
tsc --noEmit --strict --skipLibCheck --module esnext \
    --moduleResolution bundler --target esnext --types node \
    src/demo-ai-app/credits.ts src/demo-ai-app/planGeneration.ts
# 结果：无输出（通过）

# 三个改动文件 esbuild 语法检查
# operations.ts / DemoAppPage.tsx / demo-ai-app.wasp.ts → SYNTAX OK
```

## 未运行的检查（明确标注）

| 检查 | 原因 | 补齐方式 |
| --- | --- | --- |
| `wasp compile` | Wasp CLI 0.25 npm 包 `os` 限 linux/darwin，Windows `EBADPLATFORM`；本机 WSL Ubuntu 未注册（0x80370102） | Linux/macOS 上执行 `wasp compile` |
| `npx tsc --project tsconfig.src.json --noEmit` | 同上：`@wasp.sh/spec` 指向 `.wasp/` 生成物，无法在 Windows 安装依赖 | 同上 |
| `npx tsc --project tsconfig.wasp.json --noEmit` | 同上 | 同上 |
| 页面端到端（A1–A3 UI 部分） | 同上 | `wasp start` 后按 `SPEC.md` 6 节操作 |
| `operations.ts` / `DemoAppPage.tsx` 完整类型检查 | 依赖 `wasp/entities`、`wasp/server` 等生成类型 | 同上；已做 esbuild 语法检查兜底 |
