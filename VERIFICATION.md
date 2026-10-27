# 验证记录

> 结论：**全部可自动化验证项均已在真实环境跑通**。
> - 额度逻辑：**6/6 场景、28 条断言通过**（含基线问题复现），在 Windows 与 WSL 原生 PostgreSQL 上各跑一遍，结果一致。
> - Wasp 侧：`wasp compile` **通过**；`tsc --project tsconfig.src.json --noEmit` 与 `tsc --project tsconfig.wasp.json --noEmit` **均为 EXIT=0**。
> - 页面端到端（浏览器里点按钮走 A1–A3）**未运行**，原因与补齐方式见文末。
>
> 值得一提的是：`wasp compile` 首次运行抓出了一个真实类型错误（`GeneratePlanOutcome` 不满足 Wasp 的 `Payload` 约束），已修复并记录在文末「编译期发现并修复的问题」。

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

## 编译与类型检查（WSL 实测）

环境：WSL2 + Ubuntu 22.04，Node v24.22.1（nvm），Wasp CLI 0.25.0，PostgreSQL 14（WSL 内原生）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Wasp 编译 | `wasp compile` | ✅ `Your wasp project has successfully compiled.` |
| 公共/服务端类型检查 | `npx tsc --project tsconfig.src.json --noEmit` | ✅ EXIT=0，无报错输出 |
| Wasp 生成物类型检查 | `npx tsc --project tsconfig.wasp.json --noEmit` | ✅ EXIT=0，无报错输出 |
| 额度逻辑（WSL 复跑） | `node scripts/verify-quota.mjs` | ✅ 6/6 场景、28 条断言 |

`wasp db` 阶段提示 `Your Prisma schema does not match your database`（`task_planner_dev` 为新建空库），不影响编译与上述验证——额度验证使用独立的 `quota_verify` 库。

## 编译期发现并修复的问题

`wasp compile` 首次运行失败：

```text
src/demo-ai-app/operations.ts(37,3): error TS2344:
Type 'GeneratePlanOutcome' does not satisfy the constraint 'Payload'.
  Type 'GeneratePlanOutcome' is not assignable to type 'SuperJSONObject'.
    Index signature for type 'string' is missing in type 'GeneratePlanOutcome'.
```

**原因**：Wasp action 的返回值必须满足 `Payload`（即 `SuperJSONObject`，带 string index signature）。TypeScript 只会给 **type alias 的对象类型**隐式生成 index signature，**interface 不会**。原实现写的是 `export interface GeneratePlanOutcome`。

**修复**（commit `87d4821`）：改为 `export type GeneratePlanOutcome = { schedule; creditsRemaining }`，编译随即通过。

该问题在 Windows 上无法暴露——Wasp CLI 无 Windows 发行版，当时只能做 esbuild 语法检查（语法合法，但类型契约不满足）。它说明「未运行项如实标注、后续真机补齐」这个做法是有价值的。

## 仍未运行

| 检查 | 原因 | 补齐方式 |
| --- | --- | --- |
| 页面端到端（浏览器操作 A1–A3） | 需 `wasp start` 后人工登录点击 | `wasp start` 后按 `SPEC.md` 第 6 节：额度 3 生成后变 2；额度 0 时按钮禁用；任务描述含 `[fail]` 时提示「不消耗额度，可重试」 |

其余改动文件（`operations.ts` / `DemoAppPage.tsx`）的完整类型检查已由 `tsc --project tsconfig.src.json` 覆盖，无需再单独兜底。

## 一键重跑全部验证

```bash
# 在 WSL (Ubuntu 22.04) 内，项目必须在 ext4（~/），不要放 /mnt
bash scripts/wsl-verify.sh              # 装环境 → 建表 → A0–A5 → wasp compile → 两个 tsc
bash scripts/wsl-verify.sh --with-page  # 额外 wasp start + curl 页面冒烟
```

脚本幂等、可重复执行，全过程日志落盘 `~/verify-logs/`，退出码非 0 即为失败。

数据库默认连 `localhost:5433`（Windows 侧）；若在 WSL 内用原生 PostgreSQL，设 `PG_PORT=5432` 并把 `DATABASE_URL` 写成 `postgresql://postgres:postgres@localhost:5432/quota_verify`。
