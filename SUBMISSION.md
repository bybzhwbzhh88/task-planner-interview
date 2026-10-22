# 提交说明

- 姓名或称呼：岳广鹏
- 应聘方向：技术
- 打码手机号：181****5259

## 结果概览

原实现先调用模型，再依据认证上下文中的旧额度扣减，既会在额度为 0 时浪费调用，也存在并发扣成负数的竞争。本次改为数据库原子预占：调用模型前用 `credits > 0` 条件一次扣减，失败时返还；成功返回日程和预占后余额，页面同步展示当前额度与明确结果。

当前已完成 spec、实现、真实 PostgreSQL 集成测试和页面验证。没有新增依赖或数据库迁移。

## 交付入口

- 需求、流程、并发方案与验收案例：[SPEC.md](SPEC.md)
- 计费核心：[src/demo-ai-app/creditBilling.ts](src/demo-ai-app/creditBilling.ts)
- Wasp 操作接线：[src/demo-ai-app/operations.ts](src/demo-ai-app/operations.ts)
- 页面交互：[src/demo-ai-app/DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx)
- 并发测试：[tests/credit-billing.integration.test.ts](tests/credit-billing.integration.test.ts)
- 测试命令：[scripts/test-credit.sh](scripts/test-credit.sh)
- 本地运行与测试说明：[README.md](README.md)

运行：

```sh
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
TEST_DATABASE_URL="postgresql://<user>:<password>@localhost:5432/<test_database>" npm run test:credit
```

## 验证记录

| 验收项 | 操作 | 预期 | 实际 |
| --- | --- | --- | --- |
| AC-01 成功扣费 | 集成测试；页面生成一次 | 200，余额 -1，1 次 started/succeeded，新增结果 | 测试通过；页面余额 3→2，提示“本次消耗 1 次额度，当前剩余 2 次” |
| AC-02 额度不足 | 将测试账号额度设为 0 后生成 | 402，余额 0，无 started，无结果 | 测试通过；页面提示未调用模型、未扣额度；该请求返回 402，且未新增 `mock-ai.started` |
| AC-03 模型失败 | 使用含 `[fail]` 的任务生成 | 502，余额不变，1 次 started/failed，无结果 | 测试通过；页面余额保持 3，日志为 started→failed→502，未新增 `PlanResult` |
| AC-04 并发不透支 | 余额 1，并发 5 次 | 1 成功、4 个 402，余额 0 | 测试通过：5 请求中 1 成功、4 个 `InsufficientCreditsError`，started 1 次 |
| AC-05 并发不透支 | 余额 3，并发 5 次 | 3 成功、2 个 402，余额 0 | 测试通过：3 成功、2 个 `InsufficientCreditsError`，started 3 次 |
| AC-06 页面可理解 | 浏览器完成成功、余额 0、模型失败 | 结果与下一步清楚 | 三种状态的提示、余额刷新和按钮文案均已验证 |

检查结果：`wasp compile` 通过；两份 `tsc --noEmit` 通过；`npm run test:credit` 为 5/5 通过。未单独注入数据库保存失败或返还失败，相关错误路径未计入本次实测证据。

## 待办与交接

- 产品没有充值入口；额度为 0 时只能提示联系管理员补充。
- 预占后进程崩溃不会自动返还额度；若继续产品化，应增加预占流水和补偿任务。
- 未实现幂等键、客户端重试去重、支付或跨账号防刷。
- 接手时先读 `SPEC.md`，再按 `README.md` 的额度验证一节跑测试；页面余额以 `getCreditBalance` 查询和服务端返回为准。
