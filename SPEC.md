# 日程生成额度处理 SPEC

> 状态：已实现并验证。环境、代码、自动化测试和界面反馈已对齐；实际结果见 [VERIFICATION.md](VERIFICATION.md)。

## 结论

现版本先调用模拟模型、后检查额度，并且使用请求开始时的 `context.user.credits` 判断。零额度请求仍会触发 `mock-ai.started`，并发请求也可能一起通过旧余额判断。

本次采用“数据库条件预占 1 个额度，成功后提交结果，失败后归还”的方案：

1. 调用模型前，通过 PostgreSQL 条件更新原子扣减 1 个额度。
2. 预占失败立即返回 `402`，不读取任务之外的额外数据，也不调用模型。
3. 模型失败或结果保存失败时，在同一请求中归还额度。
4. 成功后返回日程与数据库中的最新余额。
5. 前端利用 Wasp Action 自带的实体查询失效机制刷新 `useAuth`，不新增余额查询接口。

该方案复用现有 `User.credits`，不需要数据库迁移。

## 环境基线

以下项目已在本机验证：

| 项目 | 当前配置 |
| --- | --- |
| 系统 | WSL2 Ubuntu |
| Node.js | 24.14.1 |
| npm | 11.11.0 |
| Wasp CLI | 0.25.0 |
| PostgreSQL | 16.15，Docker 容器 `task-planner-postgres` |
| 数据库端口 | `127.0.0.1:5433` |
| Web | `http://localhost:3000` |
| API | `http://localhost:3001` |

本地配置：

- `.env.server` 使用独立开发数据库，文件被 `.gitignore` 忽略。
- `.env.client` 已创建，项目当前没有客户端环境变量。
- Wasp 0.25.0 只提供 Linux/macOS 包，因此在 WSL2 中运行。
- README 的 `wasp compile` 和两项 `tsc --noEmit` 检查已通过。
- 初始迁移已应用，数据库包含 `User`、`Task`、`PlanResult` 和 Wasp 鉴权表。

运行命令统一在仓库根目录的 WSL2 终端执行；数据库容器不是 README 默认的 `wasp start db`，因此测试前需确认 `task-planner-postgres` 正在运行。

## 范围与假设

- 单服务、单 PostgreSQL 数据库，不处理多区域复制或分布式锁。
- 每次 `generatePlan` 调用代表一次独立生成，不要求幂等键或跨请求复用结果。
- 客户端不会自动重试生成请求；成功响应丢失后由用户主动重试，视为一次新生成。
- 预占期间数据库中的可用额度会临时减少 1，失败归还后恢复。
- 服务进程在预占后崩溃、数据库在归还时不可用，不要求自动补偿，但必须记录可诊断错误并人工核查。
- 不实现支付、订阅、跨账号防刷、精确 Token 计价和额度消费历史。
- 模拟模型由 `src/demo-ai-app/mockAi.ts` 提供，一次 `mock-ai.started` 代表一次真实调用。

## 接口契约

`generatePlan` 输入：

```ts
{
  hours: number; // 1 到 24
}
```

成功返回：

```ts
{
  schedule: GeneratedSchedule;
  creditsRemaining: number;
}
```

错误契约：

| 状态码 | 含义 | 是否预占过额度 | 是否调用模型 |
| --- | --- | --- | --- |
| `400` | 参数非法或没有可规划任务 | 否 | 否 |
| `401` | 未登录 | 否 | 否 |
| `402` | 额度不足 | 否，条件更新未命中 | 否 |
| `502` | 模拟模型明确失败 | 是，已归还 | 是 |
| `500` | 结果保存或额度归还异常 | 视失败阶段而定 | 可能为是 |

前端依据 `err.statusCode` 区分 `402`、`502` 和其他错误。Wasp 客户端会将服务端 `HttpError` 转为带 `statusCode` 的 `WaspHttpError`。

## 成功流程

1. 校验登录态、`hours` 和任务列表。
2. 执行原子条件更新，预占当前用户的 1 个额度：

   ```ts
   const reservation = await context.entities.User.updateMany({
     where: {
       id: context.user.id,
       credits: { gt: 0 },
     },
     data: {
       credits: { decrement: 1 },
     },
   });
   ```

3. 只有 `reservation.count === 1` 才调用 `generateMockSchedule`。
4. 模型成功后，在一个数据库事务中创建 `PlanResult` 并读取最新用户余额：

   ```ts
   const saved = await prisma.$transaction(async (tx) => {
     const planResult = await tx.planResult.create({
       data: {
         userId,
         content: JSON.stringify(schedule),
       },
     });
     const user = await tx.user.findUniqueOrThrow({
       where: { id: userId },
       select: { credits: true },
     });
     return {
       planResult,
       creditsRemaining: user.credits,
     };
   });
   ```

5. 事务成功后，该请求不再执行归还。
6. 返回 `{ schedule, creditsRemaining }`，前端显示新日程和准确余额。

模型调用是外部 I/O，不放在数据库事务中；数据库事务只在模型成功后执行结果保存和余额读取。

## 异常流程

| 场景 | 处理 | 用户可观察结果 |
| --- | --- | --- |
| 未登录 | 返回 `401` | 不预占、不调用模型 |
| 参数超出范围 | 返回 `400` | 不预占、不调用模型 |
| 没有可规划任务 | 返回 `400` | 不预占、不调用模型 |
| 条件更新命中 0 行 | 返回 `402` | 无 `mock-ai.started`，额度不变 |
| 模型抛错 | 归还预占额度，返回 `502` | 有 started/failed 日志，无成功结果，额度恢复 |
| 结果事务失败 | 归还预占额度，返回 `500` | 不留下成功结果，额度恢复 |
| 归还失败 | 记录 `credit_refund_failed`，返回 `500` | 提示刷新确认并联系维护者，进入人工核查 |

所有额度不足和内部错误都使用明确中文消息，不以静默失败或仅在控制台打印结束。

## 并发控制

条件更新等价于：

```sql
UPDATE "User"
SET "credits" = "credits" - 1
WHERE "id" = $userId AND "credits" > 0;
```

PostgreSQL 在并发更新同一行时串行获取行锁，并在等待后重新检查 `credits > 0`。由此得到：

- 每个成功预占只扣 1。
- 余额为 0 时不会有任何请求进入模型调用。
- 同一账号并发请求不会把 `credits` 扣成负数。
- 分支判断完全以数据库更新结果为准，不依赖 `context.user.credits`。

若初始额度为 1，同时发起 4 个请求，只有一个请求的 `count` 为 1；其余请求直接收到 `402`。若初始额度为 3，则最多 3 个请求进入模型调用。

## 失败补偿

请求维护 `reservationOpen` 状态：

- 条件更新成功后设为 `true`。
- 模型失败时调用一次 `credits: { increment: 1 }`，成功后设为 `false`。
- 结果事务失败时执行同样的归还。
- 结果事务成功后设为 `false`，不执行归还。
- 补偿不使用重试循环，避免同一请求重复增加额度。

归还日志至少包含 `userId`、失败阶段、原始错误类型和归还结果。额度归还是当前基础设施故障下的最后一致性边界；进程崩溃后的自动恢复不在本次范围。

## 前端行为

- 页头继续使用 `useAuth()` 展示 `user.credits`，不新增独立余额查询。
- Wasp Action 声明了 `User` 实体；生成的客户端 Action 会在 `finally` 中使使用 `User` 的查询失效。已在 `.wasp/out` 生成代码中确认这一行为。
- 因此 `generatePlan` 无论成功或抛出错误，`useAuth` 都会重新获取数据库余额。
- 生成区域同时使用 `useAuth()`，显示“每次消耗 1 个额度，当前剩余 X”。
- 没有任务、额度为 0 或正在生成时禁用按钮。
- 额度不足提示“本次未调用模型、未扣额度；演示版本不提供充值或购买”。
- 模型失败提示“日程生成失败，额度未扣除”，保留已有日程并允许重试。
- 成功提示“生成成功，已扣除 1 个额度”，并显示返回的剩余额度。

## 实现步骤

| 顺序 | 文件 | 改动 |
| --- | --- | --- |
| 1 | `src/demo-ai-app/quotaGeneration.ts` | 编排预占、模型调用、结果保存和单次归还 |
| 2 | `src/demo-ai-app/operations.ts` | 执行原子条件更新、事务保存和 HTTP 错误映射 |
| 3 | `src/demo-ai-app/demo-ai-app.wasp.ts` | 保留 `generatePlan` 的 `User` 实体声明，使 `useAuth` 自动刷新 |
| 4 | `src/demo-ai-app/DemoAppPage.tsx` | 适配新返回结构、额度状态和差异化错误提示 |
| 5 | `src/client/App.tsx` | 继续保持页头 `useAuth` 余额展示 |
| 6 | `tests/`、`scripts/` 和 `package.json` | 已增加单元测试和可重复接口并发验证入口 |
| 7 | `VERIFICATION.md` | 已按 Q1-Q7 记录命令、预期结果和实际结果 |

前端不依赖旧响应猜测余额；服务端返回的 `creditsRemaining` 用于即时提示，`useAuth` 刷新后的数据库值用于最终展示。

## 验收案例

| ID | 前置条件 | 操作 | 可观察的预期结果 |
| --- | --- | --- | --- |
| Q1 成功 | 新账号额度 3，至少一条正常任务 | 调用一次生成接口 | `200`，返回日程和余额 2；新增 1 条 `PlanResult`；1 次 `mock-ai.started` |
| Q2 额度不足 | 账号额度 0，已有任务 | 调用生成接口 | `402`；0 次 `mock-ai.started`；额度仍为 0；不新增 `PlanResult` |
| Q3 模型失败 | 账号额度 2，任务包含 `[fail]` | 调用生成接口 | `502`；额度恢复为 2；有 started/failed 日志；不新增 `PlanResult` |
| Q4 并发 1 额度 | 账号额度 1，已有正常任务 | 同时发起 4 个生成请求 | 1 个成功，3 个 `402`；1 次 `mock-ai.started`；最终额度 0；只新增 1 条 `PlanResult` |
| Q5 并发 3 额度 | 账号额度 3，已有正常任务 | 同时发起 5 个生成请求 | 3 个成功，2 个 `402`；3 次 `mock-ai.started`；最终额度 0；新增 3 条 `PlanResult` |
| Q6 前端反馈 | 额度 0，用户刷新页面 | 查看并点击生成区域 | 页头显示 0；按钮禁用；说明未扣额度且演示版不提供充值 |
| Q7 保存失败 | 模型成功，测试将结果事务设为失败 | 调用生成接口 | `500`；无成功结果；额度恢复为请求前数值；提示已归还 |

## 验证方式

### 自动化测试

- 单元测试覆盖：成功扣 1、模型失败归还、保存失败归还、归还只执行一次。
- PostgreSQL 集成测试覆盖：并发条件更新、`credits >= 0`、成功预占数等于初始额度。
- 接口验证覆盖：认证、创建任务、并发生成、查询额度和 `PlanResult`。

验证命令：

```sh
npm run test:quota
npm run verify:quota
```

`verify:quota` 使用独立测试数据库，不修改日常开发数据，并输出每次请求的状态码、最终额度和 `mock-ai.started` 数量。

### 基础检查

```sh
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
```

实际验证结果统一写入 `VERIFICATION.md`。未运行的检查必须明确标注，不以“环境已启动”代替额度验收。

## 完成状态与边界

- 已实现原子预占、模型失败归还、保存失败归还、并发防透支和前端反馈。
- `npm run test:quota` 覆盖成功、余额不足、模型失败、保存失败和归还失败。
- `npm run verify:quota` 使用独立数据库完成 Q1-Q5 的真实接口验证。
- Q6 已在 Chrome 中手动检查零额度和成功生成后的即时余额刷新。
- 支付、订阅、跨账号防刷和进程崩溃后的自动补偿仍按任务范围排除。
- 已于 2026-10-22 创建 [Pull Request #10](https://github.com/bybzhwbzhh88/task-planner-interview/pull/10)。
