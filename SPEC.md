# 额度处理改进 SPEC

> 状态速览（先读这一段）
>
> - **问题判断**：`generatePlan` 把额度判断放在模型调用之后，且判断依据是请求上下文里的旧快照 `context.user.credits`，扣减又是无条件 `decrement`。三点叠加导致：额度为 0 仍会发起模型调用；并发请求可以透支成负数；用户看不懂失败原因。
> - **采用方案**：把「一次带条件的原子 UPDATE」当作唯一的额度闸门——`updateMany({ where: { id: userId, credits: { gte: 1 } }, data: { credits: { decrement: 1 } } })`，更新行数 0 即判定额度不足并直接返回 402。占位成功后才调用模型；模型失败则 `increment: 1` 退还。额度逻辑抽成不依赖 Wasp 运行时的模块，验证脚本直接复用同一份代码。
> - **当前完成状态**：实现完成；数据库层验证已真实运行（真实 PostgreSQL 16 + Prisma 直连，6/6 场景、28 条断言全部通过，含基线问题复现）。Windows 上无法安装 Wasp CLI（仅 linux/darwin 发行版），因此 `wasp compile` / `tsc --noEmit`（Wasp 生成物相关）/ 页面端到端**未在本机运行**，见 [第 7 节](#7-验证方式与环境限制) 与 `VERIFICATION.md`。

## 1. 问题判断

基线代码在 `src/demo-ai-app/operations.ts` 的 `generatePlan`，注释标明了这是留给面试题的待改进实现。逐条对照 `TASK.md` 的目标规则：

| # | 现状 | 违反的规则 |
| --- | --- | --- |
| P1 | 先 `await generateMockSchedule()`，之后才判断 `context.user.credits > 0` | 额度不足时不应发起模型调用（额度 0 时日志仍会出现 `mock-ai.started`） |
| P2 | 判断依据 `context.user.credits` 是请求上下文快照，不是数据库当前值 | 同一账号并发时，多个请求读到同一个旧值，都会认为自己有额度 |
| P3 | `data: { credits: { decrement: 1 } }` 无 `credits >= 1` 条件约束 | 缺少唯一原子闸门，余额可以被扣成负数 |
| P4 | 模型失败抛 `HttpError(500)`，前端统一弹 "Error" | 用户不理解结果，不知道下一步能做什么 |
| P5 | 页面不展示剩余额度；额度为 0 时「生成日程」按钮仍可点击 | 用户不知道还能不能生成 |

补充：P1/P4 叠加后，模型失败其实**没有**扣额度（抛错发生在扣减之前），这一点碰巧是对的，但流程顺序本身是错的，需要按「占位 → 调用 → 成功留存 / 失败退还」重排。

## 2. 范围与假设

| 假设 | 理由 |
| --- | --- |
| 一次 `generatePlan` 调用 = 一次生成任务 = 一次模型调用 = 扣 1 个额度 | `TASK.md`：「每成功生成一次日程，消耗 1 个额度」；不要求跨请求复用结果 |
| 只考虑单服务、单数据库 | `TASK.md` 明确的范围 |
| 并发指同一账号在同一进程内同时到达的多个请求 | 单实例部署下的真实并发形态 |
| 模型失败 = 提供者抛错（`mockAi.ts` 中任务描述含 `[fail]` 触发） | 模拟接口的既定行为 |
| 额度以 `User.credits`（Int）为唯一事实来源，不新增表或字段 | 改动最小，避免迁移风险；可追溯性用结构化日志保证 |

**明确不做**（`TASK.md` 已排除，或属于后续工作）：支付与订阅、跨账号防刷、按 Token 精确计价、服务崩溃后的自动补偿、后台任务队列、额度过期与重置。

## 3. 流程

### 3.1 成功流程

1. 校验登录，未登录 → 401。
2. 校验入参 `hours`，不合法 → 400。
3. **原子占位**：`updateMany({ where: { id: userId, credits: { gte: 1 } }, data: { credits: { decrement: 1 } } })`。
   - 更新行数 `0` → 抛额度不足错误，**不调用模型**，→ 402。
4. 调用模型（本地模拟接口，约 500ms）。
5. 成功 → 写入 `PlanResult` 并返回日程与剩余额度。
6. 失败（抛错）→ **退还** `increment: 1`，不写 `PlanResult`，→ 502。

### 3.2 异常流程

| 场景 | 触发条件 | 服务端行为 | 额度变化 | 用户可见 |
| --- | --- | --- | --- | --- |
| 未登录 | 无有效 session | 401，无任何数据库写入 | 不变 | 跳转登录页 |
| 参数不合法 | `hours` 非数字 | 400 | 不变 | 输入校验提示 |
| 额度不足 | `credits = 0` | 402，不调用模型 | 不变（0） | 「额度已用完」并说明如何继续 |
| 模型失败 | 任务描述含 `[fail]`，或提供者抛错 | 502，写明未消耗额度 | 先 -1 后 +1，净变化 0 | 「生成失败，未消耗额度，可重试」 |
| 并发超额 | `credits = 1` 时并发 10 个请求 | 1 个 200，9 个 402 | 恰好 -1，不为负 | 部分成功 + 其余提示额度不足 |

## 4. 并发处理思路

**唯一闸门是一条带条件的原子 UPDATE。** 三个请求同时到达、`credits = 1` 时，PostgreSQL 对同一行的更新串行化：第一个请求把 `credits` 改成 0 并返回更新行数 1；后两个请求的 `WHERE credits >= 1` 不再匹配，返回更新行数 0 → 402。额度不会被扣成负数，也不会有两次调用同时通过。

为什么不采用其它做法：

- **不用「先 SELECT 再 UPDATE」**（现状 P2/P3）：读到的值在写入前就可能失效（TOCTOU 窗口）。
- **不用 `context.user.credits` 快照**：它是请求上下文里带过来的旧值，并发下必然陈旧。
- **不依赖事务 + `SELECT ... FOR UPDATE`**：也能保证正确性，但需要事务包裹整个模型调用（500ms 的远程等待会长期持有行锁）。条件更新把临界区缩小到一条语句，且天然幂等。

**退还的处理**：退还只在「本次占位成功」之后执行一次，写在 `catch` 里，一次请求最多退还一次。退还语句自身失败时记录 `credits.refund_failed` 错误日志并向用户返回 502，额度会少退 1——这是已知限制（见第 8 节）。

**日志可自证**：占位、退还、落库按 plan 层 `callId` 打印结构化日志（`mockAi.ts` 内部另有自己的 callId，两层靠计数对应）。额度不足的 402 路径上不会出现 `mock-ai.started`，这条断言（模型调用次数 = 0）直接写进验证脚本。

## 5. 实现拆解

| 任务 | 文件 | 内容 |
| --- | --- | --- |
| T1 | `src/demo-ai-app/credits.ts`（新增） | `reserveCredit` / `refundCredit` / `getCredits`，参数是最小化的存储接口，不 import `wasp/server`，可被脚本直接复用 |
| T2 | `src/demo-ai-app/planGeneration.ts`（新增） | `generatePlanForUser({ db, userId, tasks, hours, provider })`：占位 → 调用 → 成功写 `PlanResult` / 失败退还；定义 `QuotaExhaustedError`、`ProviderError` |
| T3 | `src/demo-ai-app/operations.ts`（改） | `generatePlan` 变薄：登录校验 + 参数校验 + 调 T2 + 错误映射（402 / 502 / 401）；新增 `getCredits` query |
| T4 | `src/demo-ai-app/demo-ai-app.wasp.ts`（改） | 注册 `getCredits` query（`entities: ["User"]`） |
| T5 | `src/demo-ai-app/DemoAppPage.tsx`（改） | 展示剩余额度；额度为 0 时禁用按钮；402 与模型失败分别提示并给出下一步 |
| T6 | `scripts/verify-quota.mjs`（新增） | 四类场景 + 并发断言，可重复执行 |

T1/T2 刻意不依赖 Wasp 运行时：验证脚本通过动态 `import()` 加载**同一份**业务代码，而不是复制一份逻辑去测，避免「测的不是线上代码」。

## 6. 验收案例

共同前置条件：已安装依赖、数据库已迁移、存在一个已登录账号；`credits` 通过 `wasp db studio` 或脚本直接设置。

| 编号 | 场景 | 前置条件 | 操作 | 可观察的预期结果 |
| --- | --- | --- | --- | --- |
| A0 | 基线对照（反向证据） | 复刻 `114aeb2` 的旧额度逻辑 | 同一账号并发发起 10 次生成 | 旧逻辑下额度为 0 时模型仍被调用；`credits = 1` 时并发 10 次后 `credits = -9`、模型被调用 10 次。问题被复现 = 修复有必要 |
| A1 | 成功生成 | `credits = 3`，至少 1 条任务，任务描述不含 `[fail]` | 点击「生成日程」 | 页面显示日程；额度显示变为 2；服务端日志出现 `mock-ai.started` 与 `mock-ai.succeeded`（同一 `callId`）；`PlanResult` 新增 1 条 |
| A2 | 额度不足 | `credits = 0`，至少 1 条任务 | 点击「生成日程」 | 返回 402；页面提示额度已用完且按钮禁用；服务端日志**没有** `mock-ai.started`；`credits` 保持 0；`PlanResult` 不新增 |
| A3 | 模型失败 | `credits = 2`，任务描述包含 `[fail]` | 点击「生成日程」 | 返回 502；页面提示生成失败且明确未消耗额度；日志出现 `mock-ai.started` 与 `mock-ai.failed`；`credits` 仍为 2；`PlanResult` 不新增 |
| A4 | 并发不透支 | `credits = 1`，至少 1 条任务 | 同一账号并发发起 10 次生成 | 恰好 1 次成功、9 次 402；`credits = 0`（不为负）；模型调用次数 = 1；`PlanResult` 新增 1 条 |
| A5 | 并发多额度 | `credits = 3`，至少 1 条任务 | 同一账号并发发起 10 次生成 | 恰好 3 次成功、7 次 402；`credits = 0`；模型调用次数 = 3 |

A0 / A4 / A5 由 `scripts/verify-quota.mjs` 覆盖（A0 是对旧逻辑的复刻对照，用来证明问题真实存在）；A1–A3 同时由脚本和页面两种路径验证。

## 7. 验证方式与环境限制

```bash
# 0) 准备一个工具目录（Windows 跑不了 Wasp 时验证数据库层用）
mkdir quota-tools && cd quota-tools && npm init -y
npm install @prisma/client@5.19.1 prisma@5.19.1 esbuild typescript zod

# 1) 数据库层验证（覆盖 A0–A5，不需要 Wasp）
export DATABASE_URL="postgresql://postgres@localhost:5433/quota_verify"
npx prisma db push --schema ../task-planner-interview/schema.prisma
PRISMA_CLIENT_DIR=$(pwd) node ../task-planner-interview/scripts/verify-quota.mjs

# 2) 应用内验证（需要 Linux/macOS + Wasp 0.25）
wasp db migrate-dev && wasp start     # 页面操作 A1–A3
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
```

上述第 2 组（需要 Wasp）已由 `scripts/wsl-verify.sh` 串成一条命令，在 WSL/Linux 内 `bash scripts/wsl-verify.sh` 即可依次跑完装环境、拉代码、建表、A0–A5、`wasp compile`、两个 `tsc --noEmit`，日志落盘 `~/verify-logs/`；加 `--with-page` 附带 `wasp start` + curl 冒烟。

脚本如何做到「测的是真实代码」：脚本用 `createRequire` 从 `PRISMA_CLIENT_DIR`（默认当前目录）加载 `@prisma/client` 与 `esbuild`；esbuild 把 `src/demo-ai-app/planGeneration.ts`、`mockAi.ts`（连同无扩展名相对导入）打包成 Node 可加载的 ESM 后动态 `import()`，因此 A0–A5 跑的是仓库里同一份逻辑与同一个模拟接口；`provider` 参数包一层计数器，用来断言调用次数。A0 是对基线 `generatePlan`（`114aeb2`）额度行为的**复刻**（先调用、快照判断、无条件扣减），已在脚本里明确标注，不算线上代码。

**环境限制（真实情况，不掩饰）**：Wasp CLI 0.25 的 npm 包 `os` 字段为 `linux,darwin`，Windows 上无法安装（`EBADPLATFORM`）；本机 WSL 的 Ubuntu 发行版未注册（虚拟机平台未启用，错误 0x80370102）。因此：

- **已运行**：数据库层验证（真实 PostgreSQL 16.9，`scripts/verify-quota.mjs`，6/6 场景通过）；`credits.ts` 与 `planGeneration.ts` 的独立 `tsc --noEmit --strict` 类型检查；改动文件的 esbuild 语法检查。
- **未运行**：`wasp compile`、两个 `tsc --noEmit`（依赖 `.wasp/` 生成物）、页面端到端（A1–A3 的 UI 部分）。`operations.ts` / `DemoAppPage.tsx` 的完整类型检查也依赖 Wasp 生成物，未在本机执行。接手者在 Linux/macOS 上按上面第 2 步命令补齐即可。

逐条运行记录见 `VERIFICATION.md`。

## 8. 风险、已知限制与待办

| 项 | 说明 |
| --- | --- |
| 进程崩溃导致额度丢失 | 占位成功但进程在写 `PlanResult` 或退还前崩溃，额度不会回来。`TASK.md` 明确不要求崩溃补偿，故未引入 Ledger 表或后台补偿任务；若要补，建议加一张 `CreditLedger` 记录 `reserve/refund/settle` 三态并配定时任务 |
| 退还失败 | 退还语句自身失败时返回 502 并记录 `credits.refund_failed`，需人工核对 |
| 客户端刷新时机 | 剩余额度来自 `getCredits` query 与 action 返回值的组合；页面未做实时推送，其它标签页生成后本页需刷新 |
| 未在真机跑通的项 | `wasp compile`、两个 `tsc --noEmit`、页面端到端（A1–A3 的 UI 部分）。接手者在 Linux/macOS 上按第 7 节命令补齐即可 |
