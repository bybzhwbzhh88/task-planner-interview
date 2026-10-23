# VERIFICATION.md — 验证记录

逐项对应 [SPEC.md §6](SPEC.md) 的验收案例 AC-1..AC-6。环境：

- Node v24.20.0、Wasp CLI 0.25.0、PostgreSQL 18（Docker 开发库容器）、API 端口 3001（`wasp start` 默认）。
- 所有自动化命令在 2026-10-23 于本仓库分支 `tech/credits-reserve-refund` 实际执行，输出为原样摘要。

## 基础检查（README「基础检查」一节）

| 命令 | 预期 | 实际 |
| --- | --- | --- |
| `wasp compile` | 编译通过 | ✅ `Your wasp project has successfully compiled` |
| `npx tsc --project tsconfig.src.json --noEmit` | 无错误 | ✅ 通过（含测试文件） |
| `npx tsc --project tsconfig.wasp.json --noEmit` | 无错误 | ✅ 通过 |

## 自动化验证 A：核心流程测试（vitest，含并发）

命令：`npm test`（= 先执行 `scripts/test-db-setup.sh` 重建一次性测试库，再 `vitest run`）。

覆盖 AC-1/2/3/4/6 及 E3（落库失败退还），直接调用 `generatePlanWithQuota`（`src/demo-ai-app/planGeneration.ts`），断言数据库终态与 `mock-ai.started` 日志次数（捕获 `console.info`）。

| 验收案例 | 断言要点（预期） | 实际 |
| --- | --- | --- |
| AC-1 成功消耗 | credits 3→2；`PlanResult` +1 且内容与返回一致；`mock-ai.started`/`succeeded` 各 1 次且同 `callId` | ✅ 通过 |
| AC-2 额度不足 | credits=0 → `insufficient_credits`；**`mock-ai.started` 为 0 次**；无 `PlanResult` | ✅ 通过 |
| AC-3 模型失败退还 | `[fail]` 任务 → `provider_failed`；credits 保持 2（预留后退还）；`mock-ai.failed` 1 次且与 started 同 `callId`；`credits.refunded` 日志 1 次 | ✅ 通过 |
| AC-4 并发（1 额度×10 请求） | 恰 1 成功 + 9 个 `insufficient_credits`；终值 0 且全程 ≥0；`mock-ai.started` 恰 1 次 | ✅ 通过 |
| AC-4 并发（3 额度×20 请求） | 恰 3 成功 + 17 个不足；终值 0；`mock-ai.started` 恰 3 次；`PlanResult` 3 行 | ✅ 通过 |
| AC-6 空任务列表 | `no_tasks`；不预留（`credits.reserved` 0 次）、不调模型（started 0 次） | ✅ 通过 |
| E3 落库失败退还 | 注入失败的 `planResult.create` → `provider_failed`；credits 回到 1；`credits.refunded` 1 次 | ✅ 通过 |

实际输出（两次连续运行，均通过；第二次证明可重复执行）：

```text
$ npm test
applying migrations/20261015081629_init/migration.sql
test database ready: 'taskplanner_test' (fresh, migrations applied)

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Duration  3.95s ... / 3.37s ...
```

## 自动化验证 B：HTTP 端到端（真实路由 + 会话认证 + 并发）

命令：`node scripts/verify-http.mjs http://localhost:3001`（需 `wasp start` 运行中；每次运行创建随机新账号，不污染开发库数据）。

脚本走与浏览器客户端完全相同的链路：`POST /auth/username/signup|login` 取 `sessionId` → `Authorization: Bearer` 调 `POST /operations/*`（superjson 包体）。用户 A 验证 AC-1→AC-4→AC-2 顺序链路；用户 B 验证 AC-3 及恢复场景。

| 验收案例 | 断言（预期） | 实际 |
| --- | --- | --- |
| AC-1 | 首次生成 200、返回日程、额度 3→2 | ✅ PASS |
| AC-4 | 剩 2 额度时 10 个并发请求：恰 2 个 200 + 8 个 402，并发后额度恰为 0 | ✅ PASS |
| AC-2 | 额度用尽后单次请求 402，文案含「额度…重置」；额度保持 0 | ✅ PASS |
| AC-3 | `[fail]` 任务 → 500，文案含「未消耗额度」；额度保持 3；删除后重试 200、额度 3→2 | ✅ PASS |
| AC-6（附带） | 删除账号下唯一任务后直接调 `generate-plan` → 400 | ✅ 首次脚本运行中实际观察到（当时用例设置删除了唯一任务，服务端按设计返回 400 `no_tasks`，据此修正了脚本用例） |

实际输出（两次运行均 `ALL PASSED`，第二次为可重复性确认）：

```text
$ node scripts/verify-http.mjs http://localhost:3001
user A: 注册并登录成功
  PASS  user A 初始额度为 3
  PASS  AC-1: 首次生成返回 200
  PASS  AC-1: 返回日程内容
  PASS  AC-1: 额度 3 → 2
  PASS  AC-4: 10 个并发请求恰好 2 个 200
  PASS  AC-4: 其余 8 个为 402
  PASS  AC-4: 并发后额度为 0（未透支）
  PASS  AC-2: 额度不足返回 402
  PASS  AC-2: 402 文案说明额度已用完及下一步
  PASS  AC-2: 额度仍为 0
user B: 注册并登录成功
  PASS  AC-3: 模型失败返回 500
  PASS  AC-3: 500 文案说明本次未消耗额度
  PASS  AC-3: 额度退还后仍为 3
  PASS  AC-3: 删除 [fail] 任务后重试成功
  PASS  AC-3: 成功后额度 3 → 2
ALL PASSED
```

说明：`mock-ai.started` 次数上界（调用数 ≤ 已预留额度数）在验证 A 中按日志逐条断言；验证 B 的并发场景共享同一核心流程与数据库行锁，故 HTTP 层 2×200 + 8×402 的结果与之一致。

## AC-5 用户理解（人工浏览器步骤）——**本环境未执行，明确标注**

本验证环境无浏览器，UI 改动仅通过编译/类型检查与代码评审确认，未做浏览器实测。接手者按下表人工执行（预期即实现内容，对应位置已给出）：

| 步骤 | 操作 | 预期 |
| --- | --- | --- |
| 1 | 登录后打开首页 | 「生成日程」按钮上方常显「剩余额度：N 个」（`DemoAppPage.tsx:232`），额度为 0 时变红并提示「额度已用完」 |
| 2 | 添加任务并生成 | 出现日程卡片；toast「日程已生成，本次消耗 1 个额度。」；余额立即减 1 |
| 3 | 用 `wasp db studio` 将 credits 置 0，再点生成 | toast「额度不足」+ 说明「…可在下方查看历史日程；如需继续使用，请联系管理员重置额度。」（`DemoAppPage.tsx:116-121`）；按钮仍可点击但请求以 402 结束 |
| 4 | 添加含 `[fail]` 的任务再生成 | toast「生成失败」+「模型接口返回错误，本次未消耗额度。请检查任务列表后重试。」；余额不变 |
| 5 | 查看历史日程区 | 列出历次生成记录（新→旧），点「查看」复用同一日程渲染组件展示，标题标注生成时间（`DemoAppPage.tsx:271-279`） |

toast 文案与服务端 HTTP 报文一致（验证 B 已在 HTTP 层实测 402/500 的 message 字段就是上述文案来源，`operations.ts:48-58`）。

## 未验证 / 已知限制

- AC-5 浏览器人工步骤：如上，未执行。
- 崩溃窗口额度丢失、退还不补偿：按题目范围排除（[SPEC.md §2](SPEC.md)）。
- HTTP 脚本依赖 `wasp start` 的开发端口（默认 3001）；若端口不同，作为第一参数传入。
