# 测试结果

2026-10-23，Linux、Node 24.14.1、Wasp 0.25.0、Prisma 5.19.1、Docker PostgreSQL 18，测试库 `task_planner_quota_test`，连接池 10。测试使用原有本地模拟模型。

按 README 安装依赖，准备已迁移的测试库后执行：

```sh
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
export TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/task_planner_quota_test'
npm test
```

| 检查 | 预期 | 实际 |
| --- | --- | --- |
| 编译、两项类型检查 | 无错误 | 通过 |
| 流程分支与输入类型，19 项 | 先预扣后调用，非法请求不扣额，明确失败只退款一次，未知结果不盲目退款 | 19/19 通过 |
| 真实数据库，15 项 | 成功扣额并保存；零额度无调用；失败退回；并发不透支；退款后可再次生成；慢调用不持锁；账号隔离；提交响应不确定时不重复写入 | 15/15 通过 |
| 分级并发，45 项 | 每档 10/50/100/500/1000 请求，争抢、成功、失败各三轮，余额、调用日志及保存数一致 | 45/45 通过，共 14940 个请求 |

千请求场景的三轮结果均一致：

| 场景 | 初始额度 | 成功 | 额度不足 | 模型明确失败 | 模型调用 | 保存 | 最终额度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 少额度争抢 | 3 | 3 | 997 | 0 | 3 | 3 | 0 |
| 全额成功 | 1000 | 1000 | 0 | 0 | 1000 | 1000 | 0 |
| 全额失败 | 1000 | 0 | 0 | 1000 | 1000 | 0 | 1000 |

```text
Test Files  1 passed (1)
     Tests  79 passed (79)
  Duration  56.73s
```

提交响应不确定的用例在真实数据库提交前后注入异常。所有测试位于 [tests/quota.test.ts](tests/quota.test.ts)，执行结束清理本次创建的账号及关联数据。
