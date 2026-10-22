# SPEC — 日程生成的额度处理

> **状态**：初稿 `v0.1`。写下本稿时业务代码零改动，结论来自对 `main@114aeb2` 的静态阅读。
> 标注「待验证」的断言会在环境跑通后回填，修订按 §11 追加记录，不改写初稿。
> 验证结果与证据见 [VERIFICATION.md](VERIFICATION.md)，交付索引见 [SUBMISSION.md](SUBMISSION.md)。

## 0. 判断、方案、当前状态

**判断**：TASK 的五条规则，现有实现破坏了两条。原因不是少写了一个 `if`，而是**额度校验的位置错了、判断与扣减不是原子的**。

| 目标规则 | 现状 | 根因 |
| --- | --- | --- |
| 成功一次扣 1 | 满足 | `operations.ts:68` 在模型成功后扣减 |
| 额度不足不发起调用 | **不满足** | `operations.ts:49` 先调用模型，`:67` 才判余额 |
| 模型失败不扣额度 | 偶然满足 | `mockAi.ts:13` 抛异常早于扣减；但 `operations.ts:50` 的 `=== null` 判空是死代码，契约靠巧合 |
| 并发不透支 | **不满足** | `:67` 用进函数时的 `credits` 判断，`:68` 无条件 `decrement`；`credits=1` 时并发两请求 → `-1` |
| 用户知情 | **不满足** | 无余额查询；`generatePlan` 只返回 schedule，成功后无法告知剩余 |

**方案**：把「够不够」的判断从应用层挪进 SQL 的 `WHERE`，改为 **reserve → commit / refund** 三段式。

1. `UPDATE "User" SET credits = credits - 1 WHERE id = ? AND credits > 0`；影响行数 `0` → 返回 `402`，**不调用模型**。
2. 预扣成功后才调用模型。
3. 成功 → 写 `PlanResult`，返回 `{ schedule, creditsRemaining }`；失败 → `credits + 1` 退还，返回 `502`「未扣额度」。

**当前状态**：初稿。代码未改动。待验证项见 §1.3，实施步骤见 §6，验收案例见 §7。

## 1. 范围与假设

### 1.1 范围内

- 四条额度规则：成功扣 1、不足不调用、失败不扣、并发不透支。
- 用户可理解的反馈：余额可见、结果可区分、失败后知道能否重试。
- 上述行为的可重复验证（脚本 + 记录）。

### 1.2 范围外（明确不做）

| 不做 | 理由 |
| --- | --- |
| 支付、订阅、跨账号防刷、精确 Token 计价 | TASK「范围」已排除 |
| 服务崩溃后的自动补偿 | TASK「范围」已排除；残留窗口在 §3.4 说明，不放任不管 |
| 幂等键 / 请求重放去重 | TASK 允许不同请求代表不同生成任务 |
| 过滤已完成任务（`isDone`）、`hours` 上下界校验 | 与额度无关，改动会扩大 diff 且不在验收范围 |
| 依赖升级、目录重构、UI 视觉改版 | `AGENTS.md` 要求避免无关升级 |

### 1.3 假设与待验证项

| ID | 假设 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| A1 | 单实例、单库，Postgres 行锁足以互斥 | TASK「范围」明确单服务单库 | 按题面接受 |
| A2 | `context.user.credits` 是每请求从 DB 读取，而非会话快照 | 打日志对比一次扣减后的读取值 | 待验证 |
| A3 | Prisma `{ decrement: 1 }` 生成原子 `SET credits = credits - 1` | 开 query log 观察 SQL | 待验证 |
| A4 | action 抛 `HttpError(402/502)` 后，客户端能拿到对应的 `statusCode` | 手工触发一次，看浏览器控制台 | 待验证；不成立则降级为 message 前缀协议（§4.3） |
| A5 | `mock-ai.started` 在每次真实调用前必定打印 | `mockAi.ts:11` 静态确认 | 已确认 |
| A6 | 基线 `tsc --noEmit` 可能本来就不通过 | 跑一次 `npx tsc --project tsconfig.src.json --noEmit` | 待验证；若失败，`operations.ts:50` 是首要嫌疑（`strict: true` 下与非 nullable 类型比 `null`） |
| A7 | 能在 Wasp 运行时之外实例化 Prisma 客户端打测试库 | 环境跑通后试 `import { PrismaClient } from "@prisma/client"` | 待验证；不影响主逻辑，仅影响测试形态（§8.1） |

A2 的结论不影响方案：即使 `context.user` 是会话快照，TOCTOU 窗口只会更大，`WHERE` 守卫仍然正确。

## 2. 目标行为

### 2.1 不变式

以下四条在**任何**合法请求序列下都成立，可直接作为断言：

| ID | 不变式 |
| --- | --- |
| I1 | `User.credits >= 0` 恒成立 |
| I2 | `User.credits <= 3` 恒成立（初始 3，无充值；退还只会回到预扣前的值） |
| I3 | 每次成功的生成恰好新增 1 条 `PlanResult`，且该请求净扣 1 |
| I4 | `mock-ai.started` 的条数 == 预扣成功的次数；额度不足的请求不产生该日志 |

I4 是规则「额度不足不发起调用」的可观测形式，也是 TASK 指定的证据锚点。

### 2.2 术语

| 术语 | 含义 |
| --- | --- |
| `callId` | 一次生成尝试的关联 ID，贯穿预扣、模型调用、退还三条日志 |
| reserve | 原子预扣 1 额度 |
| commit | 预扣后成功，写入 `PlanResult`，额度不再退回 |
| refund | 预扣后失败，退还 1 额度 |
| `creditsRemaining` | 预扣完成后的余额，随成功响应返回 |

### 2.3 成功流程

1. 校验登录（401）与参数（400）。
2. 读取该用户的 `Task`（行为不变）。
3. 生成 `callId`，打 `credits.begin`。
4. **reserve**：条件 `UPDATE`。`count === 1` → 打 `credits.reserved`；`count === 0` → 走 2.4。
5. 调用 `generateMockSchedule`，失败 → 走 2.5。
6. **commit**：`PlanResult.create` + 读回余额（同一事务）。
7. 返回 `{ schedule, creditsRemaining }`，打 `credits.committed`。

### 2.4 额度不足流程

1. `reserve` 返回 `count === 0`。
2. 打 `credits.reserve_failed`。
3. 抛 `HttpError(402)`，**不调用模型**，不写 `PlanResult`。
4. 客户端：专用 toast「额度已用完，本次未发起生成」，按钮转为禁用态。
5. 可观察证据：请求耗时明显低于 500ms（无模拟接口延迟）、`mock-ai.started` 计数不变。

### 2.5 模型失败流程

1. 模型抛错（`[fail]` 任务）→ 打 `mock-ai.failed`。
2. **refund**：`credits + 1`；成功打 `credits.refunded`，失败打 `credits.refund_failed`（不吞异常，见 §3.4）。
3. 抛 `HttpError(502)`。
4. 客户端：「生成失败，本次未扣额度，可重试」。
5. 可观察证据：余额与操作前一致；`PlanResult` 计数不变。

### 2.6 并发流程

N 个请求同时进入。`reserve` 的条件 `UPDATE` 在同一行上串行执行，因此：

- 只有 `credits` 个请求拿到 `count === 1`，其余拿到 `count === 0` 并返回 402。
- 拿到预扣的请求各自完成模型调用与 commit。
- 最终 `credits === 0`，且不会为负。

## 3. 并发处理思路

### 3.1 为什么是条件 UPDATE

`credits > 0` 出现在 `WHERE` 子句里，判断与扣减被压进同一条 SQL。Postgres 对该行的 UPDATE 加行级锁，第二个请求要么看到 `count = 0`，要么看到已扣减后的值——不存在"两个请求都读到 1"的窗口。锁只在语句执行期间持有，不跨越模型调用。

### 3.2 备选方案与取舍

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **条件 UPDATE（选）** | `WHERE id = ? AND credits > 0` + 检查 `count` | 一次往返、无长事务、无新依赖 |
| `SELECT ... FOR UPDATE` | 先锁行再判断再更新 | 正确但多一次往返；若要覆盖模型调用需跨调用持锁，退化为长事务 |
| 可串行化事务 | `SERIALIZABLE` + 捕获 40001 重试 | 单行更新的场景用不上，且引入重试状态机 |
| 应用层内存锁 | `Map<userId, Mutex>` | 正确性绑死在进程数上，单实例可用但更脆 |
| Redis 分布式锁 | — | 引入新依赖，超出「单服务单库」范围 |

### 3.3 为什么不在一个数据库事务里包住模型调用

那样失败自动回滚、最省事，但事务会持有行锁 ≥500ms 等待外部 IO。把额度正确性与模型延迟耦合，是不可接受的设计。代价是预扣与 commit 之间不再是原子对，见 3.4。

### 3.4 残留窗口（已知限制，不放任）

| 窗口 | 后果 | 处置 |
| --- | --- | --- |
| reserve 成功后进程崩溃 | 少 1 额度，无 `PlanResult` | TASK 已排除补偿；在 §9 登记为已知限制 |
| commit 写库失败 | 已预扣但无产物 | **catch 中退还**，抛 500 |
| refund 本身失败 | 用户少 1 额度 | 打 `credits.refund_failed` 便于人工定位；不会破坏 I1 |
| 重复 refund | 余额可能 +2 | 代码路径保证每次 reserve 至多一次 refund；I2 作为断言兜底 |

彻底解决这三格需要一张账本表（`CreditLedger`：`pending / committed / refunded`）。它不在本轮范围，理由见 §9，方案留在文档里供接手者取舍。

## 4. 接口契约

### 4.1 `generatePlan`

| 项 | 值 |
| --- | --- |
| 输入 | `{ hours: number }`（不变） |
| 成功返回 | `{ schedule: GeneratedSchedule, creditsRemaining: number }`（原为裸 `GeneratedSchedule`） |
| 副作用 | `credits - 1`；新增 1 条 `PlanResult` |

### 4.2 新增查询 `getCreditBalance`

返回 `{ credits: number }`，服务端从 `context.entities.User` 读当前用户。客户端在页面加载时取一次，生成成功后用响应里的 `creditsRemaining` 就地更新并 `invalidateQueries`。

### 4.3 错误码

| 场景 | 状态码 | 服务端 | 客户端文案 | 扣额 |
| --- | --- | --- | --- | --- |
| 未登录 | 401 | `HttpError(401)` | 跳转登录 | 不变 |
| 参数非法 | 400 | 现有 `ensureArgsSchemaOrThrowHttpError` | 「参数不合法，请刷新后重试」 | 不变 |
| 额度不足 | 402 | `HttpError(402)` | 「额度已用完，本次未发起生成」 | 不变 |
| 模型失败 | 502 | `HttpError(502)` | 「生成失败，本次未扣额度，可重试」 | 已退还 |
| 写库失败 | 500 | `HttpError(500)` | 「保存失败，本次已退还额度」 | 已退还 |

状态码即协议。若 A4 不成立（客户端拿不到 `statusCode`），降级为在 message 前置稳定前缀（如 `INSUFFICIENT_CREDITS:`）并由客户端解析——同一张表，只换传输方式。

### 4.4 结构化日志

全部走 `console.info(JSON.stringify({...}))`，与既有 `mock-ai.*` 风格一致，可用 `grep <callId>` 串起一次尝试。

| event | 触发 | 关键字段 |
| --- | --- | --- |
| `credits.begin` | 进入生成 | `callId, userId` |
| `credits.reserved` | 预扣成功 | `callId, userId, creditsRemaining` |
| `credits.reserve_failed` | 余额不足 | `callId, userId` |
| `credits.refunded` | 退还成功 | `callId, userId, reason` |
| `credits.refund_failed` | 退还失败 | `callId, userId, error` |
| `credits.committed` | 写入产物成功 | `callId, userId, creditsRemaining` |

`mockAi.ts` 需要接受外部传入的 `callId` 以完成串联。这是对 fixture 的唯一改动：**500ms 延迟与 `[fail]` 失败触发逻辑保持不变**。

### 4.5 额度逻辑的代码位置

新增 `src/demo-ai-app/credits.ts`，导出 `reserveCredit` / `refundCredit` / `commitPlan`。只依赖注入的客户端接口，不 `import` 任何 `wasp/*` 运行时符号——这样它既能被 Wasp 的 `prisma` 驱动，也能在测试里被真实 `PrismaClient` 驱动（§8.1）。

## 5. 客户端行为

| 余额 | 按钮 | 生成结果 | 用户看到 |
| --- | --- | --- | --- |
| `> 0` | 可用 | 成功 | 渲染日程 + 「已生成，剩余 N 次」，余额徽标更新 |
| `> 0` | 可用 | 402 | toast「额度已用完，本次未发起生成」，按钮转禁用 |
| `> 0` | 可用 | 502 | toast「生成失败，本次未扣额度，可重试」，余额不变 |
| `= 0` | 禁用 + 原因 | — | 「额度已用完」，按钮 `disabled` 且带说明文字 |

页面加载即显示余额徽标（`剩余 N / 3`）。生成中的防重复点击保留现有 `isPlanGenerating`，但它只是体验层——**服务端才是唯一权威**（§3.1）。

## 6. 实现步骤

每步一个提交，便于 review 与回溯。`docs` 步骤不改代码。

| # | 提交 | 内容 | 对应验收 |
| --- | --- | --- | --- |
| S1 | `docs: 提交 SPEC 初稿` | 本文件 | — |
| S2 | `feat: 额度预扣与退还` | 新增 `credits.ts`（条件 UPDATE + 退还 + commit） | AC-01/03/04/06 |
| S3 | `feat: 统一错误契约与额度日志` | 错误类型、`callId` 串联、`mockAi.ts` 接参 | AC-03/04/05 |
| S4 | `feat: 返回剩余额度并新增余额查询` | `generatePlan` 返回体、`getCreditBalance`、`demo-ai-app.wasp.ts` 注册 | AC-01/09 |
| S5 | `feat: 前端余额展示与失败文案` | 徽标、禁用态、文案表 | AC-01/09/10/11 |
| S6 | `test: 四场景与并发验收` | 测试、脚本、`package.json` scripts | AC-02/03/04/05/06/07/08/12 |
| S7 | `docs: 回填验证记录并按实现修订 spec` | `VERIFICATION.md`、本文 §11、`SUBMISSION.md` | 全部 |

## 7. 验收案例

前置条件除注明外，均为「已登录、`credits` 为指定值、已执行 `wasp db migrate-dev`」。

| ID | 前置条件 | 操作 | 可观察的预期结果 |
| --- | --- | --- | --- |
| AC-01 | `credits=3`，1 条普通任务 | 点「生成日程」 | 渲染日程；余额徽标 `2`；DB `credits=2`；`PlanResult` +1；日志 `started`/`succeeded` 各 1 条且 `callId` 相同 |
| AC-02 | `credits=3` | 连续生成 4 次 | 前 3 次成功，余额到 `0`；第 4 次 402 且无新 `mock-ai.started`；`PlanResult` 共 3 条 |
| AC-03 | `credits=0` | 点「生成日程」 | 402；`mock-ai.started` 计数为 `0`；`PlanResult` 不变；请求耗时 < 100ms（无 500ms 模拟延迟）；按钮转禁用 |
| AC-04 | `credits=2`，任务含 `[fail]` | 生成一次 | 502；余额仍 `2`；`PlanResult` 不变；日志 `started` 1 条、`failed` 1 条、无 `succeeded`；toast 含「未扣额度」 |
| AC-05 | 接 AC-04，删除 `[fail]` 任务 | 再生成一次 | 成功；余额 `1`；`PlanResult` +1 |
| AC-06 | `credits=3` | 并发 10 个请求（脚本） | `credits=0`（不为负）；`PlanResult=3`；`mock-ai.started=3`；7 个请求 402 |
| AC-07 | `credits=1` | 并发 5 个请求 | `credits=0`；`PlanResult=1`；`started=1`；4 个 402 |
| AC-08 | 未登录（无 cookie） | `curl` 直接打 action | 401；`mock-ai.started` 不变；`credits` 不变 |
| AC-09 | `credits=2` | 打开页面 | 页面加载即显示「剩余 2 / 3」，无需先点生成 |
| AC-10 | `credits=2` | 生成成功后观察余额 | 徽标即时变 `1`，无需刷新 |
| AC-11 | `credits=0` | 打开页面 | 按钮 `disabled`，旁边有「额度已用完」说明 |
| AC-12 | 任意场景执行完 | `SELECT min(credits), max(credits) FROM "User"` | `min >= 0` 且 `max <= 3`（I1、I2 未被破坏） |

## 8. 验证方式

每条 AC 的「实际结果」与证据落位见 [VERIFICATION.md](VERIFICATION.md)，此处只定方法，避免两处重复。

### 8.1 自动化路径与降级

| 优先级 | 形态 | 说明 |
| --- | --- | --- |
| 首选 | `tests/credits.test.ts`（vitest）直连测试库 | `credits.ts` 不依赖 Wasp 运行时，用真实 `PrismaClient` 打独立库 `taskplanner_test`，跑 AC-06/07/12 的并发断言 |
| 降级 1 | `scripts/verify-quota.mjs` 打 HTTP action | 登录拿 session cookie，并发 `fetch`。避开 Prisma 实例化问题（A7） |
| 降级 2 | `curl` 循环 + `psql` 直查 | 非自动化，在文档中标注 |

首选路径依赖 A7，环境跑通后按结论落定，并在 §11 记录。

### 8.2 命令

```sh
# 前置：迁移与启动
wasp db migrate-dev
wasp start

# 静态检查（基线是否本来就不绿，见 A6）
npx tsc --project tsconfig.src.json --noEmit

# 自动化验收
npm run verify          # 四场景 + 并发
```

具体脚本名与用法在 S6 落地后回填本节。

### 8.3 不做的验证

- 不做浏览器端 E2E（Playwright）：本轮时间预算内收益低于 HTTP 层脚本，且 Wasp dev server 启动成本高。
- 不做崩溃注入：TASK 已把崩溃补偿排除在范围外；§3.4 的窗口只做文字说明，不伪造证据。

## 9. 已知限制与后续

1. **崩溃窗口未补偿**（§3.4）。后续方案：加 `CreditLedger` 表记 `pending/committed/refunded`，或用对账任务按 `callId` 修正。本轮不做的理由：TASK 明确排除，且会引入第二张表与迁移，超出「完善额度处理」的最小闭环。
2. **refund 不在事务内与 commit 互斥**：正常路径不会双退，但没有账本可审计。同上。
3. **进度可能压缩的项**：若剩余时间不足，优先砍 AC-08（未登录）与降级 2 的手工步骤，保留 AC-03/04/06/07——这四条是本轮的核心命题。
4. **HTTP 层并发脚本**依赖 action 端点与 cookie 的实测结果（A4/A7），未跑通前不写进 VERIFICATION 当成已验证。

## 10. 决策记录

| ID | 决策 | 备选 | 理由 |
| --- | --- | --- | --- |
| D1 | 条件 UPDATE 预扣 | 见 §3.2 | 单行、单库、无新依赖，锁不跨模型调用 |
| D2 | reserve 在前、commit 在后 | 先调用再扣 | 只有先扣才能保证「不足不调用」与「不透支」同时成立 |
| D3 | 失败用退还而非"回调后退" | 事务回滚 | 回滚需要长事务，见 §3.3 |
| D4 | 502 表示模型失败 | 500 / 424 | 502 与现有 500 区分开，前者可重试、后者是写库问题，客户端提示不同 |
| D5 | 返回体带 `creditsRemaining` | 客户端另发查询 | 少一次往返，且余额与本次扣减严格对应 |
| D6 | 额度逻辑独立成 `credits.ts` | 写在 `operations.ts` 里 | 让并发测试能在 Wasp 运行时之外驱动真实 SQL（§8.1） |

## 11. 修订记录

| 版本 | 变更 | 依据 |
| --- | --- | --- |
| v0.1 | 初稿 | 静态阅读 `main@114aeb2`；A2/A3/A4/A6/A7 待验证 |

<!-- 后续修订在此追加，不删改上面的行。 -->
