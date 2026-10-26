# 提交说明

- 姓名或称呼：小缪
- 应聘方向：产品
- 打码手机号：`136****6099`

PR 标题：`产品｜小缪｜136****6099`

> 文档与代码在 AI 辅助下完成。所有「实际结果」均为本地真实运行所得，未执行的部分已逐条标注，不含推测。

## 结果概览

**问题判断**：额度处理的问题不在「少一个 `if`」，而在于三件事被混在同一条时间线里——扣费时机、并发一致性、失败反馈。现有代码里，模型调用发生在额度判断之前（`operations.ts` 先调 `generateMockSchedule`，后判断 `credits`），判断依据又是请求开始时的用户快照，所以额度为 0 时仍会发起一次模型调用，并发时两个请求都能通过检查、把余额扣到 -1。另外前端不显示余额，失败时只弹通用错误，用户无法判断额度有没有被扣。

**主要方案**：选「先占位、失败退还」（方案 B）——把额度检查改成一条带 `credits > 0` 条件的更新，扣到才调用模型；模型或落库失败则退还。扣减在数据库层面天然串行，因此不需要应用层加锁，也不用依赖事务隔离级别。前端补上常驻余额、按钮三态，以及能回答「发生了什么 / 扣没扣 / 下一步做什么」的文案。

**完成状态**：产品方向五份交付物已齐（需求、流程、原型、任务拆解、验收案例）。应用已在 WSL2 + Ubuntu 26.04 + PostgreSQL 18.6 上实际跑通：先用原始代码复现了三个缺陷，再按 `04-tasks.md` 落地了额度处理的修复，AC-01 ~ AC-07 全部通过实测（含 5 并发场景），并补上 7 个不依赖数据库的单元测试。剩下 AC-08 / AC-09 是页面呈现，代码已实现、构建通过，但视觉未做浏览器人工核对，已在下方标注。

## 交付入口

| 交付物 | 文件 |
|---|---|
| 需求分析（问题诊断、R1–R5 规则与判定口径、方案对比） | [docs/01-requirements.md](docs/01-requirements.md) |
| 流程（主流程、并发链路、失败退还链路） | [docs/02-flows.md](docs/02-flows.md) |
| 原型与状态文案 | [docs/03-prototype.md](docs/03-prototype.md) |
| 开发任务拆解（T-01 ~ T-08）与实现状态 | [docs/04-tasks.md](docs/04-tasks.md) |
| 验收案例（AC-00 ~ AC-09）与实测记录 | [docs/05-acceptance.md](docs/05-acceptance.md) |

代码改动（供对照阅读，产品方向不要求，但设计已在其中落地）：

| 文件 | 改动 |
|---|---|
| [src/demo-ai-app/credits.ts](src/demo-ai-app/credits.ts) | 新增。`tryConsumeCredit` 条件扣减、`refundCredit` 退还 |
| [src/demo-ai-app/operations.ts](src/demo-ai-app/operations.ts) | `generatePlan` 改为先扣后调、失败退还；新增 `getMyCredits` 查询；删除 `=== null` 死代码 |
| [src/demo-ai-app/demo-ai-app.wasp.ts](src/demo-ai-app/demo-ai-app.wasp.ts) | 注册 `getMyCredits` |
| [src/demo-ai-app/DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx) | 余额展示、按钮三态、402 / 424 分支提示 |
| [scripts/verify-quota.sh](scripts/verify-quota.sh) | 新增。AC-01 ~ AC-07 的一键复验脚本，31 项断言 |
| [src/demo-ai-app/credits.test.ts](src/demo-ai-app/credits.test.ts) | 新增。7 个单元测试，假存储覆盖扣减 / 退还 / 并发判定 |
| [vitest.config.ts](vitest.config.ts)、[src/test/wasp-server.stub.ts](src/test/wasp-server.stub.ts) | 新增。测试配置与 `wasp/server` 占位，`package.json` 补 `npm test` |

### 运行与复验

```bash
cp .env.server.example .env.server && cp .env.client.example .env.client
wasp install && wasp db migrate-dev

# 单元测试：不需要数据库和 dev server
npm test

# 终端一：启动并把日志写到文件，脚本要靠它判断模型有没有被调用
wasp start 2>&1 | tee /tmp/wasp.log

# 终端二：端到端复验
bash scripts/verify-quota.sh --log /tmp/wasp.log
```

单元测试跑 `src/demo-ai-app/credits.test.ts`，7 个用例，约 0.2 秒。

端到端脚本会新建一个临时账号，自己造任务、改额度、发并发请求，逐项对照预期，最后打印「通过 N / 失败 N」。不用 `--log` 时跳过三处「模型是否被调用」的断言，其余照常执行。

阅读顺序建议：`01` 看判断和取舍 → `04` 看怎么落地 → `05` 看怎么验。`02` 与 `03` 是给开发对齐细节用的。

## 验证记录

**环境**：Windows 11 + WSL2 2.7.14 / Ubuntu 26.04.1 / Node 24.22.1 / Wasp 0.25.0 / PostgreSQL 18.6。应用以 `wasp start` 运行，client `:3000`、server `:3001`。

**方法**：不改代码，直接用 HTTP 打服务端操作端点（请求体是 superjson 格式 `{"json":{"hours":8}}`，鉴权 `Authorization: Bearer <sessionId>`），额度用 `psql` 直接改 `User.credits`，结果以服务端 `mock-ai.*` 日志与数据库值为准。

### 基础检查

| 命令 | 结果 |
|---|---|
| `wasp db migrate-dev` | 迁移 `20261015081629_init` 应用成功，库与 schema 同步 |
| `npx tsc -p tsconfig.src.json --noEmit` | exit 0 |
| `npx tsc -p tsconfig.wasp.json --noEmit` | exit 0 |
| `npm test` | 7 passed，耗时约 0.2 s |

### AC-00 现状复现（已执行，三个缺陷全部成立）

| 案例 | 操作 | 预期（若缺陷成立） | 实际 |
|---|---|---|---|
| AC-00.1 | `credits = 0`，调 `generate-plan` | 返回 402 但日志已有 `mock-ai.started` | **HTTP 402**；`mock-ai.started` + `mock-ai.succeeded` 各 1 条；`credits` 仍 0。**缺陷成立**：402 发生在模型返回之后 |
| AC-00.2 | `credits = 1`，两个请求同时发出 | 两个都成功，余额扣到 -1 | **200 / 200**；`credits = -1`；`mock-ai.started` 2 条。**缺陷成立**：快照判断导致透支 |
| AC-00.3 | 任务含 `[fail]`，`credits = 3` | 通用错误，用户无法判断是否扣费 | **HTTP 500** + Express 默认 HTML 堆栈页；`mock-ai.started` + `mock-ai.failed`；`credits` 仍 3。**缺陷成立**：额度碰巧未扣（事务根本没执行），但错误不可读、无重试入口 |

AC-00.3 同时印证 `generatedSchedule === null` 是死代码——`mockAi.ts` 抛异常而非返回 `null`，错误走的是通用 500。

### AC-01 ~ AC-07 改后行为（已执行，全部通过）

| 案例 | 前置 | 操作 | HTTP | 余额变化 | `PlanResult` | `mock-ai.started` | 结论 |
|---|---|---|---|---|---|---|---|
| AC-01 | `credits = 3` | 生成一次 | 200 | 3 → 2 | +1 | 1 | 通过 |
| AC-02 | `credits = 0` | 直接调接口 | 402 | 0 → 0 | 0 | **0** | 通过 |
| AC-03 | `credits = 2`，含 `[fail]` | 生成一次 | 424 | 2 → 2 | 0 | 1（含 failed） | 通过 |
| AC-04 | `credits = 2`，触发器模拟插入失败 | 生成一次 | 424 | 2 → 2 | 0 | 1 | 通过 |
| AC-05 | `credits = 1` | 并发 2 | 1×200 / 1×402 | → 0 | +1 | 1 | 通过 |
| AC-06 | `credits = 2` | 并发 5 | 2×200 / 3×402 | → 0 | +2 | 2 | 通过 |
| AC-07 | `credits = 3`，含 `[fail]` | 并发 5 | 3×424 / 2×402 | → 3 | 0 | 3 | 通过 |

关键对比：同一个「额度为 0 就生成」的操作，**改前 `mock-ai.started` 有 1 条（AC-00.1），改后为 0 条（AC-02）**——模型不再被白白调用。并发透支同理，改前 `credits = -1`，改后余额停在 0 且多出的请求拿 402。

AC-04 的模拟方式：在 `PlanResult` 上装 `BEFORE INSERT` 触发器抛异常，让模型成功但落库失败，确认走的是退还分支（余额不变、无新增记录），测完即删触发器。

AC-01 ~ AC-07 已全部固化为 `scripts/verify-quota.sh`，一条命令跑完 31 项断言，本机实测全部通过。AC-04 的触发器由脚本自行创建、只对本脚本的临时账号生效，退出时（含中途失败）由 `trap` 兜底删除。

### AC-08 / AC-09 前端呈现（代码已实现，视觉未核对）

按钮旁常驻「剩余 N 次」、余额 0 时置灰并附说明、402 / 424 两条不同文案，均已实现且 `tsc` 与 Vite 构建通过。但**没有做浏览器人工核对**，因此不计入「通过」。服务端的对应行为已由 AC-01 ~ AC-07 覆盖。

## 待办与交接

**未完成**

- AC-08 / AC-09 的页面视觉核对（登录后目视确认余额位置、置灰态、两条错误文案）。

**已知问题（本期不处理）**

- **崩溃丢额度**：扣减与退还之间若进程崩溃，额度不会自动恢复。`TASK.md` 已把「服务崩溃后的自动补偿」排除在范围外，记录在此避免被误认为遗漏。
- **退还本身失败时额度会被吞**：代码里用 `try/catch` 包住了退还，失败只打日志（`generatePlan failed AND refund failed`），没有重试或补偿队列。量级低时可接受，但要靠日志发现。
- **额度只由本流程修改**是当前假设；若之后出现其他扣减入口，必须复用同一套条件更新，否则 R4 失效。

**已处理**

- 删掉了 `generatePlan` 里 `generatedSchedule === null` 的死代码分支——`mockAi.ts` 失败时抛 `Error` 从不返回 `null`，该分支永远进不去。现在统一由 `try/catch` 处理并退还额度。
- 补上了单元测试：`tryConsumeCredit` / `refundCredit` 改为接收可注入的 client（默认仍是 `prisma`），7 个用例用假存储覆盖「余额不足不扣」「连续扣减不跨负」「余额 1 并发 2 只成功 1 次」「扣减与退还相抵」。`npm test` 不需要数据库，适合进 CI。

**接手须知**

- 改动顺序是 `credits.ts` → `generatePlan` → 前端，这个顺序不要颠倒。先改前端会出现「按钮灰了但接口还能调」的假象；先改扣减再改调用顺序会出现「扣了但没调」的中间态，两者都会让问题定位变难。
- 记录「本次未扣额度」的文案必须有服务端退还逻辑支撑，不能只在前端写死。当前 402 / 424 两条文案分别对应「没扣」和「扣了又退」，改动退还逻辑时要同步复核这两句话是否还成立。
- 条件扣减依赖 `UPDATE ... WHERE credits > 0` 的单条语句原子性。若之后引入分库或缓存余额，这套保证会失效，需要重新设计（例如改用带版本的乐观锁）。
