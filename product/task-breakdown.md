# 开发任务拆解

> 对应需求 [requirements.md](./requirements.md)、流程 [flow.md](./flow.md)。仓库为 Wasp 0.25 + Prisma + PostgreSQL，改动集中在 `src/demo-ai-app/`。

## 任务总览

| # | 任务 | 文件 | 对应需求 | 预估 |
| --- | --- | --- | --- | --- |
| T1 | 把"先查后扣"改为"原子预扣" | `src/demo-ai-app/operations.ts` | F1 | M |
| T2 | 模型失败时回滚预扣的额度 | `src/demo-ai-app/operations.ts` | F2 | S |
| T3 | 新增"查询当前剩余额度"接口 | `operations.ts` + `demo-ai-app.wasp.ts` | F3 | S |
| T4 | 前端展示剩余额度与三态 toast | `DemoAppPage.tsx` | F3/F4 | M |
| T5 | 并发可重复验证脚本 | 仓库根 `scripts/` | 验收 C4 | M |
| T6 | 自验四项场景并回填 SUBMISSION | — | 验收 C1–C4 | S |

## T1. 原子预扣（核心，防止透支 + 不足不调用）

现状问题在 `generatePlan`：先 `await generateMockSchedule(...)`，之后才在事务里读 `context.user.credits > 0`。

改造要点：

1. **删掉**"先调模型再判额度"的顺序；把额度判断挪到调用模型之前。
2. 用一条带条件的 UPDATE 同时完成"判断 + 扣减"：
   ```ts
   const res = await context.entities.User.updateMany({
     where: { id: context.user.id, credits: { gt: 0 } },
     data: { credits: { decrement: 1 } },
   });
   if (res.count === 0) {
     throw new HttpError(402, "out_of_credits"); // 此时还没调模型
   }
   ```
   - 用 `updateMany` 而不是 `update`，因为需要拿 `count` 判断有没有命中行；`update` 在无命中时会直接抛错。
   - `WHERE credits > 0` 由数据库行锁串行化并发请求——这是防止透支的具体落点，不依赖应用层锁。
3. 预扣成功后再 `await generateMockSchedule(...)`。

## T2. 模型失败回滚

现状：`generateMockSchedule` 遇到 `[fail]` 直接 throw。改造：

1. 用 `try/catch` 包住模型调用。
2. catch 到失败时，先 `User.update({ where:{id}, data:{ credits:{ increment: 1 } } })` 把 T1 预扣的 1 个额度加回去，再把错误转成前端可识别的"模型失败"错误码（建议 502 或自定义 `mock_provider_failed`）抛给前端。
3. 成功路径不变：写 `PlanResult`，额度已在 T1 扣好，**不要再扣第二次**。
4. 注意：`mock-ai.started` 日志仍在模型调用入口打印，用于对账；成功/失败日志由 mockAi 自身打印，保持现状。

## T3. 查询剩余额度接口

- 新增一个 query（如 `getMyCredits`），返回 `{ credits: number }`，从 `User` 表读实时值，不要在前端本地累加。
- 在 `demo-ai-app.wasp.ts` 中注册该 query。

## T4. 前端展示与提示

- `DemoAppPage.tsx` 用 `useQuery(getMyCredits)` 拉剩余额度，在按钮上方显示"剩余额度：X 次"。
- 生成成功后，刷新一次额度查询（或用接口返回值直接更新本地状态），显示"已消耗 1 次，剩余 X 次"。
- 按 [flow.md §3.2](./flow.md) 改三类 toast 文案；402 时按钮置灰为"额度已用完"。
- 失败 toast 必须点明"本次未扣额度"，避免用户以为被误扣。

## T5. 并发验证脚本

- 见 [acceptance.md C4](./acceptance.md)。脚本对同一测试账号并发打 N 次生成请求，断言：最终额度 = max(初始 − 成功数, 0)，且成功数 ≤ 初始额度，全程不出现负额度。

## T6. 自验与回填

- 按 [acceptance.md](./acceptance.md) 跑 C1–C4，把每条的"实际结果"填进 `SUBMISSION.md`；没跑到的项明确标注"未运行"。

## 明确不做（与需求一致）

不加充值入口、不加新表、不引入分布式锁/队列、不做崩溃补偿。
