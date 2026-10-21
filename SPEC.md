# 技术方案（SPEC）

> 产品侧的问题判断与流程见 `PRODUCT.md`，本文只写技术侧的范围、并发思路与实现步骤。验收案例统一在 `ACCEPTANCE.md`，不在此重复。

## 范围与假设

- 单服务、单数据库（Wasp 0.25 + Prisma + PostgreSQL），不考虑分布式锁、消息队列或幂等键。
- 额度是 `User.credits` 整数字段，变更只发生在生成流程内。
- 「模型调用」= `mockAi.ts` 的 `generateMockSchedule`，失败时抛异常。
- 已知限制：预扣成功后进程崩溃，该次预扣不自动退回（TASK.md 明确不要求崩溃补偿）。补偿需要预扣记录表 + 对账，见待办。

## 并发处理思路

透支的根源是「读 → 判断 → 写」三步分离。解法是把三步合并成一条带条件的原子 UPDATE：

```sql
UPDATE "User" SET credits = credits - 1 WHERE id = $1 AND credits > 0
```

- PostgreSQL 对同一行的写操作天然加锁串行，两个并发事务只有一个能匹配到行。
- 用 Prisma 表达即 `user.updateMany({ where: { id, credits: { gt: 0 } }, data: { credits: { decrement: 1 } } })`，返回的 `count === 0` 表示预扣失败（额度不足或已被并发请求扣走）。
- 失败退回用无条件 `increment`，退回永远成功，不需要补偿事务。

不选的方案：`SELECT ... FOR UPDATE` 事务（能做但代码更长，且本题单条 UPDATE 已足够）；应用层互斥锁（多实例下失效，本题虽单实例但不该引入这种脆弱性）。

## 实现步骤

| # | 改动 | 文件 |
|---|------|------|
| 1 | 新增 `reserveCredit` / `refundCredit` / `getCredits`，只依赖结构化的 Prisma delegate 类型，不耦合 Wasp | `src/demo-ai-app/credits.ts`（新增） |
| 2 | `generatePlan` 重排：鉴权 → 校验入参 → 取任务 → **预扣（失败即 402）** → 调用 → 成功：存 `PlanResult` 返回 `{ schedule, creditsRemaining }`；失败：退回后抛 502 | `src/demo-ai-app/operations.ts` |
| 3 | 新增 `getUserCredits` 查询并在 Wasp 声明（entities: User） | `operations.ts` + `demo-ai-app.wasp.ts` |
| 4 | 前端：余额常显（`data-testid="credits-display"`）、四场景 toast 文案、失败后刷新余额 | `src/demo-ai-app/DemoAppPage.tsx` |
| 5 | 验证脚本（对真实 PG 复现 credits.ts 的 SQL 语义，覆盖 AC1–AC5） | `scripts/verify-credits.mjs`（新增） |

状态码约定：402 = 额度不足（未发起调用），502 = 调用失败且额度已退回。前端据此分流提示。

## 验收案例

见 `ACCEPTANCE.md` AC1–AC6，每个案例的前置条件、操作、预期结果均已写明。验证记录见 `VERIFICATION.md`。
