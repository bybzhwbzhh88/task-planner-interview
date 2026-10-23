# 技术｜杜柏浩｜180****3004

原实现先调用模型，再检查登录上下文中的额度，零额度会调用模型，并发可能透支。现改为数据库事务内先条件扣减，再调用模型和保存日程，失败整体回滚。实现已完成；真实 PostgreSQL 的 10 个测试、基础检查和浏览器验收均通过。

- 姓名或称呼：杜柏浩
- 应聘方向：技术
- 打码手机号：180****3004

## 交付入口

- [SPEC.md](SPEC.md)：范围、事务方案、任务拆解、A1–A9 验收案例。初稿单独提交于 `3987617`，先于任何代码变更。
- [服务端操作](src/demo-ai-app/operations.ts)：`credits > 0` 条件更新取得行锁；模型调用和结果保存使用同一交互事务，提交前不会释放锁；额度不足直接 402。额度查询读取数据库当前值。
- [模拟接口](src/demo-ai-app/mockAi.ts)：明确失败使用独立错误类型，服务端只将此类失败映射为 503，其余错误继续抛出。
- [页面](src/demo-ai-app/DemoAppPage.tsx)与[查询声明](src/demo-ai-app/demo-ai-app.wasp.ts)：额度、刷新按钮、操作中状态及成功/不足/失败提示；移除页头依赖登录快照的重复额度。
- [真实数据库测试](tests/credits.integration.test.ts)与[配置](tests/vitest.config.ts)：直接调用业务操作，真实执行 PostgreSQL SQL 和事务；仅替换 Wasp 模块布线，使用生成的 Wasp HttpError。A7 只注入结果保存失败，额度更新和回滚仍由真实数据库完成。

## 运行与重复验证

环境安装、启动和迁移遵循 [README](README.md#环境)。使用 Node 24.14.1+、Wasp 0.25.0 和 PostgreSQL，未引入新依赖或迁移。运行测试前须完成 `wasp install`、`wasp db migrate-dev` 和 `wasp compile`，以生成 PrismaClient 与 Wasp SDK。

使用独立本地测试数据库，在 `.env.server` 中填写其 `DATABASE_URL`；测试命令：

```sh
node --env-file=.env.server node_modules/vitest/vitest.mjs run --config tests/vitest.config.ts --reporter=verbose
```

也可以显式传入连接串（替换下方本地示例）：

```sh
DATABASE_URL='postgresql://task_planner:task_planner_local_test@127.0.0.1:5439/task_planner_interview' npm run test:credits -- --reporter=verbose
```

测试创建临时 UUID 用户，每例在 `finally` 中仅删除该用户的日程、任务和用户记录。没有 `DATABASE_URL` 会明确报错，不跳过验证。测试不需要先启动 Web 服务；浏览器验收另执行 `wasp start`，默认打开 `http://localhost:3000`。

## 实际验证记录

验证日期：2026-10-23（UTC+8）。环境：Node 24.21.0、npm 11.19.0、Wasp 0.25.0、PostgreSQL 16（Docker，本地独立测试库）。

执行上述显式连接串命令，结果：`Test Files 1 passed (1)`，`Tests 10 passed (10)`，耗时 6.52 秒。用例断言返回结果、当前额度、保存日程数量，以及 `mock-ai.started/succeeded/failed` 日志数量和 callId 配对。

| 案例 | 操作与预期（完整前置条件见 SPEC） | 实际结果 |
| --- | --- | --- |
| A1 | 3 额度成功一次，应扣 1、保存 1、调用 1 | 额度 2，日程 1，调用 1，保存内容等于返回值，通过 |
| A2 | 数据库 0、过期上下文 3，不应调用 | 402，额度 0，日程 0，调用 0，通过 |
| A3 | `[fail]` 失败后修正任务重试，失败不扣 | 首次 503，额度 1/日程 0；重试成功，额度 0/日程 1；共调用 2，通过 |
| A4 | 1 额度并发 5 次，重复 3 轮 | 每轮恰好 1 成功、4 个 402；额度 0，日程 1，调用 1，三轮通过 |
| A5 | 3 额度并发 5 次 | 恰好 3 成功、2 个 402；额度 0，日程 3，调用 3，通过 |
| A6 | 1 额度、失败任务并发 2 次，等待者可用回滚额度 | 两次均 503，额度仍 1，日程 0，调用 2，通过 |
| A7 | 模型成功后注入保存失败 | 原错误继续抛出，额度回到 1，日程 0，调用 1，通过 |
| A8 | 未登录调用生成和额度查询 | 两次均 401，无数据变化或模型调用，通过 |
| A9 | Chrome 注册、生成、失败；改数据库额度后刷新，再制造过期页面点击生成 | 初始 3；HTTP 200 后额度 2/日程 1、显示成功；HTTP 503 后仍 2/日程 1、显示未扣及修正建议；刷新 0 后禁用；页面显示 1、数据库 0 时 HTTP 402，显示未调用并刷新至 0；无页面异常，通过 |

基础检查实际结果：

| 命令 | 结果 |
| --- | --- |
| `wasp compile` | exit 0，SDK 生成成功 |
| `npx tsc --project tsconfig.src.json --noEmit` | exit 0 |
| `npx tsc --project tsconfig.wasp.json --noEmit` | exit 0 |
| `git diff --check` | exit 0 |

浏览器使用 Chrome 155.0.8059.80 与 Playwright 执行真实交互，HTTP 顺序为 `[200, 503, 402]`，并查询数据库核对额度和日程。临时浏览器用户及关联认证、任务、日程数据已清理。浏览器步骤是本次实际验收记录；仓库内可重复执行的自动化入口为 A1–A8 的数据库测试。

## 取舍与交接

- 事务等待、执行上限各 10 秒；同账号请求串行竞争用户行锁。500ms 本地模拟接口适用，长时间真实模型应重新设计预占/结算流程，不能直接照搬长事务。
- 不自动重试。客户端丢失响应时，服务端可能已提交；界面只提示结果待确认、刷新额度后决定是否重试，不宣称所有错误都未扣费。
- 本轮没有实现支付、订阅、跨请求幂等或服务崩溃后的自动补偿，均属于题目排除范围。超时/崩溃及真实模型连接未做故障注入测试；不据此声称覆盖这些情况。
- 使用 AI 协助需求拆解、实现、独立审查和验证；文档记录的是实际执行结果。无需额外 API Key 或第三方模型服务。
