# SPEC.md — 日程生成额度处理改进

> 状态：**v1.1（2026-10-23），已实现并通过自动化验证**（AC-5 浏览器人工步骤除外）。修订记入文末[修订记录](#修订记录)，与 Git 历史对应；文档与最终实现保持一致。

## 1. 问题判断与方案概要

**问题判断**：现状的额度检查发生在模型调用**之后**，且依据的是请求鉴权时载入的 `context.user.credits` 快照（`src/demo-ai-app/operations.ts:49` 先调模型、`:67` 才检查）。由此产生两条硬伤：

1. 额度为 0 时仍会发起模型调用（`mock-ai.started` 照常出现）；
2. 同一账号并发请求都读到同一快照并通过检查，`decrement` 又没有 `> 0` 保护，额度可被扣成负数，且 1 个额度可生成多份日程。

另有一处死代码：`operations.ts:50` 的 `null` 分支不可达（`mockAi.ts:15` 用 `throw` 而非返回 `null`）。

**方案**：采用**预留-退还（reserve & refund）**，核心三步——

1. **原子预留**：单条 `UPDATE "User" SET credits = credits - 1 WHERE id = ? AND credits > 0`（Prisma `updateMany`，返回受影响行数）。受影响行数为 0 即额度不足，立即返回，模型调用不会发生。
2. **调用模型并落库**：`generateMockSchedule` 成功后创建 `PlanResult`。预留与落库均为单条短语句，**不在约 500ms 的模型调用期间持有数据库事务或行锁**。
3. **失败退还**：预留之后的任何失败（模型抛错、结果落库失败）执行 `credits + 1` 退还，再向用户报错。用户提示中明确“本次未消耗额度”。

**当前完成状态**：见 [SUBMISSION.md](SUBMISSION.md)（含验证记录入口与待办交接）。

## 2. 范围与假设

范围（题目 `TASK.md` 已界定）：

- 只考虑当前单服务、单数据库的运行环境；不做支付、订阅、跨账号防刷、精确 Token 计价、服务崩溃后的自动补偿。
- 模型调用由本地 `src/demo-ai-app/mockAi.ts` 模拟；一次 `mock-ai.started` 日志代表一次已发起的接口调用。
- 不同请求代表不同生成任务，不做跨请求结果复用。

假设：

- A1 单实例部署（单进程或少量进程共享同一 PostgreSQL）。并发正确性完全交给数据库行级锁，不引入进程内锁、Redis 或其他协调组件。
- A2 额度扣减只发生在“生成日程”操作；注册赠送 3 个额度（`schema.prisma` 现状）维持不变。
- A3 “成功生成” = 模型返回结果**且** `PlanResult` 落库成功。落库失败视同生成失败，退还额度。
- A4 前端 `fetch`/`axios` 层抛出的非 `HttpError` 网络异常不代表模型失败，不涉及额度（此时服务端流程已结束）。

范围取舍（明确不做）：

- 进程在模型调用期间崩溃 → 额度停留在“已预留未退还”状态，不自动补偿（题目豁免项）。
- 退还操作本身失败的极端数据库故障：记录错误日志并抛出原异常，不做补偿。
- 历史日程仅做只读展示，不做管理（删除/重命名）功能。
- 不改 `schema.prisma`、不新增迁移。
- UI 不做自动化浏览器测试（本地无浏览器环境），以“服务端自动化测试 + 人工浏览器步骤”组合覆盖。

## 3. 流程定义

### 3.1 主流程（成功）

| 步骤 | 行为 | 失败去向 |
| --- | --- | --- |
| 1 | 鉴权（未登录 → 401） | 401 |
| 2 | zod 参数校验（`hours` 数值，收紧为 0.5–24，与前端输入框一致） | 400 |
| 3 | 读取用户任务列表；为空 → 400 `请先添加待办事项`（不预留、不调模型） | 400 |
| 4 | **原子预留** 1 个额度（见 §4） | 402（额度不足） |
| 5 | 调用 `generateMockSchedule`（约 500ms） | → 异常流程 E2 |
| 6 | 创建 `PlanResult` 落库 | → 异常流程 E3 |
| 7 | 返回日程；前端刷新余额显示 |  |

### 3.2 异常流程

| 编号 | 场景 | 行为 |
| --- | --- | --- |
| E1 | 额度不足 | 预留 `count = 0` → 402，**无 `mock-ai.started`**，额度不变 |
| E2 | 模型明确失败（任务含 `[fail]`） | `generateMockSchedule` 抛错 → **退还** → 500，提示含“本次未消耗额度，请检查任务后重试” |
| E3 | `PlanResult` 落库失败 | 同 E2：退还 → 500 |
| E4 | 空任务列表 | 400 `请先添加待办事项`，不预留、不调模型 |
| E5 | 参数非法 / 未登录 | 400 / 401（沿用现有行为） |

## 4. 并发处理思路

**现状为什么透支**：`generatePlan` 用 `context.user.credits` 判断是 check-then-act 竞态——该值是本次请求解析 Session 时读取的快照。两个并发请求都看到 `credits = 1`、都通过检查、都执行无保护的 `decrement`，额度变为 `-1`。

**本方案如何防止透支**：

- 预留是**一条**带条件的 `UPDATE ... WHERE credits > 0`。PostgreSQL 对目标行加锁，两个并发预留在该行上串行执行：第二个执行时 `credits` 已为 0，条件不满足，`count = 0` → 402。判断与扣减是同一条语句，不存在“先读后写”窗口。
- 不依赖 `context.user.credits` 快照做任何额度决策；余额展示走数据库实时查询（新增 `getUserCredits`）。
- **模型调用次数上界 = 初始额度**：只有预留成功（已扣减）才调用模型。并发 N 个请求、额度 1，则恰好 1 次 `mock-ai.started`。
- **不变式：`credits ≥ 0` 恒成立**。预留带 `> 0` 保护；退还只把“自己占用的那 1 个”加回。
- 不持有跨模型调用的长事务：预留与落库是独立短语句，避免 500ms 级别占用连接/锁；正确性不依赖事务包裹，而依赖单语句原子性。

## 5. 实现步骤

按顺序执行，每步可独立检查（`wasp compile` + `npx tsc --project tsconfig.src.json --noEmit`）：

1. 新增 `src/demo-ai-app/planGeneration.ts`：**无 wasp 运行时依赖**的核心流程模块（依赖注入 `PrismaClient` 形状参数），导出 `generatePlanWithQuota(db, userId, hours)` 与结果判别联合类型：
   `{ status: 'success', schedule } | { status: 'insufficient_credits' } | { status: 'no_tasks' } | { status: 'provider_failed', message }`。预留/退还为模块内函数，便于单测。类型只做 `import type`，运行时不触碰 `@prisma/client`。
2. 改写 `src/demo-ai-app/operations.ts`：`generatePlan` 变为薄封装（鉴权 + 校验 + 调核心 + 错误映射：`insufficient_credits`→402、`no_tasks`→400、`provider_failed`→500 中文文案）；删除不可达 `null` 分支；新增 `getUserCredits` 查询（实时读库）。
3. `src/demo-ai-app/demo-ai-app.wasp.ts`：注册 `getUserCredits`（`entities: ["User"]`）。
4. `src/demo-ai-app/DemoAppPage.tsx`：额度常显与刷新、三类结果提示、历史日程区块（复用已有 `getPlanResults` 查询与 `Schedule` 组件）。
5. 测试与脚本：`src/demo-ai-app/planGeneration.test.ts`（vitest，直连测试库调用核心流程）、`vitest.config.ts`（独立于 `vite.config.ts`）、`scripts/test-db-setup.sh`（在本地 PG 实例中确保测试库存在并应用迁移）。package.json 增加 `test` / `test:setup` scripts。
6. 文档：`VERIFICATION.md`（逐验收案例记录）、更新 `SUBMISSION.md` 与 `README.md` 运行说明。

## 6. 验收案例

每个案例含前置条件、操作、可观察的预期结果；执行记录（命令、预期、实际）见 [VERIFICATION.md](VERIFICATION.md)。

### AC-1 成功生成消耗 1 个额度

- **前置**：已注册用户，`credits = 3`；至少 1 条不含 `[fail]` 的任务。
- **操作**：点击“生成日程”（或运行成功路径测试）。
- **预期**：返回日程；该用户 `credits = 2`；`PlanResult` 新增 1 行；服务端日志依次出现 `mock-ai.started` 与 `mock-ai.succeeded`（相同 `callId`）；页面余额显示为 2。

### AC-2 额度不足不发起模型调用

- **前置**：`credits = 0`（用 `wasp db studio` 修改），任务若干。
- **操作**：点击“生成日程”。
- **预期**：请求以 402 结束；服务端日志**没有** `mock-ai.started`；`credits` 仍为 0；页面提示说明额度已用完及接下来可做什么（见 AC-5）。

### AC-3 模型失败不消耗额度（预留后退还）

- **前置**：`credits ≥ 1`；任务中包含 `[fail]`。
- **操作**：点击“生成日程”。
- **预期**：日志出现 `mock-ai.started` 后跟 `mock-ai.failed`；`credits` 前后不变（预留后又退还）；无新增 `PlanResult`；页面提示“生成失败，本次未消耗额度”；删除 `[fail]` 任务后重试可成功。

### AC-4 并发请求不透支（可重复测试）

- **前置**：测试库已就绪（`scripts/test-db-setup.sh`）；用户 `credits = 1`，正常任务。
- **操作**：`npx vitest run src/demo-ai-app/planGeneration.test.ts` 中并发用例——同一账号同时发起 10 个生成请求；再以 `credits = 3`、20 个请求重复。
- **预期**：`credits=1` 时恰好 1 个成功、9 个 402，终值 `credits = 0`，全程 `credits ≥ 0`，`mock-ai.started` 恰好 1 次；`credits=3` 时恰好 3 个成功、17 个 402，终值 0，`mock-ai.started` 恰好 3 次。

### AC-5 用户理解结果与下一步（人工浏览器步骤）

- **前置**：dev server 运行。
- **操作**：观察页面；依次触发成功、额度不足、模型失败三条路径；点击历史日程。
- **预期**：页面常显“剩余额度”；成功提示含消耗说明；额度不足提示说明“额度已用完，无法生成；可查看历史日程，如需继续测试请联系管理员重置额度”；模型失败提示说明“本次未消耗额度，请检查任务后重试”；历史日程可点开查看。此案例为人工步骤，记录于 VERIFICATION.md 并明确标注。

### AC-6 空任务列表不调用模型、不扣费

- **前置**：账号下没有任何任务。
- **操作**：绕过前端禁用，直接调用 `generatePlan` 操作（测试内为 `no_tasks` 分支）。
- **预期**：返回 400 `请先添加待办事项`；无 `mock-ai.started`；`credits` 不变；无新增 `PlanResult`。

## 7. 测试与运行方式

- `./scripts/test-db-setup.sh`：在本机 PostgreSQL 实例中幂等创建测试库（默认 `taskplanner_test`，与开发库隔离）并应用 `migrations/`。需 Docker 开发库容器运行中。
- `npm test`（= 先执行上述脚本，再 `vitest run`）：覆盖 AC-1/2/3/4/6 及 E3 的服务端行为；并发用例通过 `Promise.all` 同发 N 次并断言终态与 `mock-ai.started` 次数（捕获 `console.info`）。
- `node scripts/verify-http.mjs http://localhost:3001`（需 `wasp start` 运行中）：HTTP 端到端验证，走与浏览器相同的路由与会话认证（注册→登录→`POST /operations/*`），覆盖 AC-1/2/3/4；每次运行创建随机新账号，可重复执行。
- `wasp compile` 与 `README.md` 中两个 `tsc --noEmit` 检查保持通过。
- 测试对测试库自清理（按用户删除 `PlanResult`、`Task` 后删 `User`），可重复执行。

## 8. 假设、取舍与未完成事项的记录位置

完整清单在本文 §2；交接视角的摘要与待办在 [SUBMISSION.md](SUBMISSION.md)。已知限制：

- 崩溃窗口的额度丢失、退还不做补偿（题目豁免，见 §2）。
- AC-5 为人工验证，不提供浏览器自动化；HTTP 层已验证服务端文案与状态码，UI 文案与之一致。
- HTTP 层并发脚本已交付（§7）；其运行依赖 `wasp start` 的默认端口 3001，端口不同时需显式传入。

## 修订记录

| 日期 | 版本 | 变更 | 提交 |
| --- | --- | --- | --- |
| 2026-10-23 | v1 | 初稿：方案、流程、并发思路、实现步骤与验收案例 | `6ac0d43` |
| 2026-10-23 | v1.1 | 实现完成后同步：HTTP 端到端脚本由「待办」转为已交付（§7）；AC-5 标注为人工步骤并说明 HTTP 层已验证同源文案（§8）；测试库名定为 `taskplanner_test` | 文档提交（见 git log） |
