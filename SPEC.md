# SPEC — 日程生成的额度处理

> **状态**：`v0.2`（已实现并验证）。`v0.1` 是动手前的初稿，保存在提交 `10dab39`；两版差异与原因见 §11。
> 验证结果与证据见 [VERIFICATION.md](VERIFICATION.md)，交付索引见 [SUBMISSION.md](SUBMISSION.md)。

## 0. 判断、方案、当前状态

**判断**：TASK 的五条规则，现有实现破坏了两条。原因不是少写了一个 `if`，而是**额度校验的位置错了、判断与扣减不是原子的**。

| 目标规则 | 改前现状 | 根因 |
| --- | --- | --- |
| 成功一次扣 1 | 满足 | `operations.ts:68` 在模型成功后扣减 |
| 额度不足不发起调用 | **不满足** | `operations.ts:49` 先调用模型，`:67` 才判余额 |
| 模型失败不扣额度 | 偶然满足 | `mockAi.ts:13` 抛异常早于扣减；但 `operations.ts:50` 的 `=== null` 判空是死代码，契约靠巧合 |
| 并发不透支 | **不满足** | `:67` 用进函数时的 `credits` 判断，`:68` 无条件 `decrement`；`credits=1` 时并发两请求 → `-1` |
| 用户知情 | **部分不满足** | 页头 `App.tsx:15` 显示了 `useAuth().user.credits`，但那是登录时的快照，生成后不刷新；`generatePlan` 也只返回 schedule，无法告知剩余次数 |

> `v0.1` 把最后一条写成"无余额显示"，是错的：余额一直在页头，问题在于它是**陈旧**的。这不是措辞问题——它改变了方案，见 §5 与 §11 的 v0.2 记录。

**方案**：把「够不够」的判断从应用层挪进 SQL 的 `WHERE`，改为 **reserve → commit / refund** 三段式。

1. `UPDATE "User" SET credits = credits - 1 WHERE id = ? AND credits > 0`；影响行数 `0` → 返回 `402`，**不调用模型**。
2. 预扣成功后才调用模型。
3. 成功 → 写 `PlanResult`，返回 `{ schedule, creditsRemaining }`；失败 → `credits + 1` 退还，返回 `502`「未扣额度」。

**当前状态**：已实现并验证完毕。代码提交见 §6，验收结果见 [VERIFICATION.md](VERIFICATION.md)。

## 1. 范围与假设

### 1.1 范围内

- 四条额度规则：成功扣 1、不足不调用、失败不扣、并发不透支。
- 用户可理解的反馈：余额实时可见、结果可区分、失败后知道能否重试。
- 上述行为的可重复验证（脚本 + 记录）。

### 1.2 范围外（明确不做）

| 不做 | 理由 |
| --- | --- |
| 支付、订阅、跨账号防刷、精确 Token 计价 | TASK「范围」已排除 |
| 服务崩溃后的自动补偿 | TASK「范围」已排除；残留窗口在 §3.4 说明，不放任不管 |
| 幂等键 / 请求重放去重 | TASK 允许不同请求代表不同生成任务 |
| 过滤已完成任务（`isDone`）、`hours` 上下界校验 | 与额度无关，改动会扩大 diff 且不在验收范围 |
| 依赖升级、目录重构、UI 视觉改版 | `AGENTS.md` 要求避免无关升级 |

### 1.3 假设与验证结论

| ID | 假设 | 结论 |
| --- | --- | --- |
| A1 | 单实例、单库，Postgres 行锁足以互斥 | 按题面接受 |
| A2 | `context.user.credits` 是每请求从 DB 读，而非会话快照 | **未直接验证**，但方案不依赖它：`getCreditBalance` 与 `commitPlan` 都直接读库 |
| A3 | Prisma `{ decrement: 1 }` 生成原子 `SET credits = credits - 1` | **行为已验证**：AC-06/07 下 10 并发只成功 3 次、余额从不为负（未逐条核对生成的 SQL 文本） |
| A4 | 客户端能拿到 action 抛出的 `statusCode` | **已验证**：AC-14 中 402 分支正确命中专用文案（`DemoAppPage` 的 `err.statusCode === 402`） |
| A5 | `mock-ai.started` 在每次真实调用前必定打印 | 已确认（`mockAi.ts` 首行） |
| A6 | 基线 `tsc --noEmit` 可能本来就不通过 | **推翻**：`strict` 下对象类型与 `null` 比较不报错，探针 `probe === null` 编译通过（exit 0）。`operations.ts:50` 仍是死代码，但不是类型错误 |
| A7 | 能在 Wasp 运行时之外实例化 Prisma 客户端打测试库 | **未采用**：单测改走假存储，真实并发走 HTTP 脚本（§8.1），不依赖该能力 |

A6 与"用户知情"两条的错误判断都留在 §11 里，因为它们各自改变了实施路径。

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
| `creditsRemaining` | 写库之后读回的余额，随成功响应返回 |

### 2.3 成功流程

1. 校验登录（401）与参数（400）。
2. 读取该用户的 `Task`（行为不变）。
3. 生成 `callId`，打 `credits.begin`。
4. **reserve**：条件 `UPDATE`。`count === 1` → 打 `credits.reserved`；`count === 0` → 走 2.4。
5. 调用 `generateMockSchedule`，失败 → 走 2.5。
6. **commit**：`PlanResult.create`，随后 `findUnique` 读回余额。两步**不**放在同一事务里，理由见 §3.4。
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
4. 客户端：「生成失败，本次未扣额度，可以直接重试」。
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
| reserve 成功后进程崩溃 | 少 1 额度，无 `PlanResult` | TASK 已排除补偿；登记为已知限制（§9） |
| commit 写库失败 | 已预扣但无产物 | **catch 中退还**，抛 500 |
| refund 本身失败 | 用户少 1 额度 | 打 `credits.refund_failed` 便于人工定位；不会破坏 I1 |
| 重复 refund | 余额可能 +2 | 代码路径保证每次 reserve 至多一次 refund；I2 作为断言兜底 |

彻底解决前两格需要一张账本表（`CreditLedger`：`pending / committed / refunded`）。它不在本轮范围，理由见 §9，方案留在文档里供接手者取舍。

## 4. 接口契约

### 4.1 `generatePlan`

| 项 | 值 |
| --- | --- |
| 输入 | `{ hours: number }`（不变） |
| 成功返回 | `{ schedule: GeneratedSchedule, creditsRemaining: number }`（原为裸 `GeneratedSchedule`） |
| 副作用 | `credits - 1`；新增 1 条 `PlanResult` |

### 4.2 `getCreditBalance`

返回 `{ credits: number }`，服务端直接读库（不用 `context.user.credits`）。

客户端只有这一处余额来源：页头 `App.tsx` 订阅该查询并渲染 `剩余额度： N`。`DemoAppPage` 复用同一个查询缓存判断按钮可用性，生成成功/失败后 `refetch`，页头与按钮状态因此同源，不会出现"页头 3、按钮已禁用"这种自相矛盾。

### 4.3 错误码

| 场景 | 状态码 | 服务端 | 客户端文案 | 扣额 |
| --- | --- | --- | --- | --- |
| 未登录 | 401 | `HttpError(401)` | 跳转登录 | 不变 |
| 参数非法 | 400 | 现有 `ensureArgsSchemaOrThrowHttpError` | 「参数不合法，请刷新后重试」 | 不变 |
| 额度不足 | 402 | `HttpError(402)` | 「额度已用完，本次未发起生成。」 | 不变 |
| 模型失败 | 502 | `HttpError(502)` | 「模型返回失败，本次未扣额度，可以直接重试。」 | 已退还 |
| 写库失败 | 500 | `HttpError(500)` | 「生成结果未能保存，本次额度已退还，请重试。」 | 已退还 |

状态码即协议，客户端按 `statusCode` 分支（A4 已验证）。message 另带英文说明，便于日志检索。

### 4.4 结构化日志

全部走 `console.info(JSON.stringify({...}))`，与既有 `mock-ai.*` 风格一致，可用 `grep <callId>` 串起一次尝试。

| event | 触发 | 关键字段 |
| --- | --- | --- |
| `credits.begin` | 进入生成 | `callId, userId` |
| `credits.reserved` | 预扣成功 | `callId, userId` |
| `credits.reserve_failed` | 余额不足 | `callId, userId, reason` |
| `credits.refunded` | 退还成功 | `callId, userId, reason` |
| `credits.refund_failed` | 退还失败 | `callId, userId, reason` |
| `credits.committed` | 写入产物成功 | `callId, userId, creditsRemaining` |

`mockAi.ts` 接受外部传入的 `callId` 以完成串联。这是对 fixture 的唯一改动：**500ms 延迟与 `[fail]` 失败触发逻辑保持不变**。

### 4.5 额度逻辑的代码位置

`src/demo-ai-app/credits.ts` 导出 `reserveCredit` / `refundCredit` / `commitPlan`，只依赖注入的 `CreditStore` 接口，不 `import` 任何 `wasp/*` 运行时符号。调用方在 `operations.ts` 里用 `context.entities` 拼出这个接口，因此额度逻辑可以被假存储直接驱动测试。

## 5. 客户端行为

| 余额 | 按钮 | 结果 | 用户看到 |
| --- | --- | --- | --- |
| `> 0` | 可用 | 成功 | 渲染日程 + toast「本次已生成日程，剩余 N 次额度。」，页头余额同步 |
| `> 0` | 可用 | 402 | toast「额度已用完，本次未发起生成。」，页头余额刷新为 0，按钮转禁用 |
| `> 0` | 可用 | 502 / 500 | toast 说明未扣额度，余额不变，可重试 |
| `= 0` | 禁用 + 原因 | — | 按钮下方「额度已用完，暂时无法生成新的日程。」 |

余额只在页头出现一次。生成中的防重复点击保留现有 `isPlanGenerating`，但它只是体验层——**服务端才是唯一权威**（§3.1）。

## 6. 实施步骤与实际提交

| # | 提交 | 内容 | 对应验收 |
| --- | --- | --- | --- |
| S1 | `docs: 提交 SPEC 初稿` (`10dab39`) | 本文件初稿，代码零改动 | — |
| S2 | `feat: 额度改为先预扣后调用，失败退还` (`60e46dd`) | `credits.ts`、`generatePlan` 改造、`callId` 串联、`getCreditBalance` | AC-01/03/04/06/07/08 |
| S3 | `feat: 页头余额改为实时查询…` (`27720c7`) | `App.tsx` 余额数据源、禁用态与文案 | AC-09/10/11/14 |
| S4 | `test: 四场景与并发可重复验收` (`1393344`) | 单测、验收脚本、npm scripts | AC-02/05/12/13 |
| S5 | `docs: 回填验证记录并按实现修订 SPEC` | `VERIFICATION.md`、本文件 v0.2、`SUBMISSION.md`、README | — |

初稿规划里 S2/S3 是分开的两个提交（额度逻辑、错误契约与日志）。实现时发现两者落在同一个文件、无法划出可独立审查的边界，于是合并为 S2，把日志与错误码一起交付。

## 7. 验收案例

前置条件除注明外，均为「已登录、`credits` 为指定值、已执行 `wasp db migrate-dev`」。逐条实测结果见 [VERIFICATION.md](VERIFICATION.md)。

| ID | 前置条件 | 操作 | 可观察的预期结果 |
| --- | --- | --- | --- |
| AC-01 | `credits=3`，1 条普通任务 | 生成一次 | 渲染日程；页头余额 `2`；`PlanResult` +1；`mock-ai.started` +1 且与 `credits.committed` 同 `callId` |
| AC-02 | `credits=3` | 连续生成 4 次 | 前 3 次成功，余额到 `0`；第 4 次 402；`PlanResult` 共 3 条；`mock-ai.started` 只增 3 |
| AC-03 | `credits=0` | 再生成一次 | 402；`mock-ai.started` 计数不变；`PlanResult` 不变；耗时 < 100ms（无 500ms 延迟） |
| AC-04 | `credits=3`，任务含 `[fail]` | 生成一次 | 502；余额仍 `3`；`PlanResult` 不变；`started` +1、`failed` +1、`succeeded` 不变 |
| AC-05 | 接 AC-04，删除 `[fail]` 任务 | 再生成一次 | 成功；余额 `2`；`PlanResult` +1 |
| AC-06 | `credits=3` | 并发 10 个请求 | 余额 `0`（不为负）；`PlanResult` 3 条；`mock-ai.started` 3 条；3 个 200、7 个 402 |
| AC-07 | `credits=1` | 并发 5 个请求 | 余额 `0`；`PlanResult` +1；`started` +1；1 个 200、4 个 402 |
| AC-08 | 未登录（无 token） | 直接打 action | 401；`mock-ai.started` 不变 |
| AC-09 | 新账号 | 打开页面 | 页头即显示「剩余额度： 3」，无需先点生成 |
| AC-10 | 页头显示 3 | 生成成功后观察 | 页头即时变 2，无需刷新 |
| AC-11 | 余额 0 | 观察页面 | 生成按钮 `disabled`，下方出现「额度已用完」说明 |
| AC-12 | 任意场景执行完 | 查全库 | `min(credits) >= 0` 且 `max(credits) <= 3`（I1、I2 未被破坏） |
| AC-13 | `credits=3` | `hours` 传字符串 | 400；余额不变 |
| AC-14 | 页头显示 3、库里改成 0 | 点击生成 | 402 分支命中专用 toast「额度已用完，本次未发起生成。」，页头刷新为 0 |

AC-13、AC-14 是 `v0.2` 新增的：前者覆盖参数边界，后者是 A4（客户端能否拿到 `statusCode`）的实测手段。

## 8. 验证方式

每条 AC 的「实际结果」与证据落位见 [VERIFICATION.md](VERIFICATION.md)，此处只定方法，避免两处重复。

### 8.1 两层验证

| 层 | 手段 | 覆盖 |
| --- | --- | --- |
| 逻辑层 | `tests/credits.test.ts`（vitest，假存储） | 预扣/退还/落库分支；10 并发只成功 3 次的调用方式断言 |
| 接口层 | `scripts/verify-quota.mjs`（真实 HTTP + 真实 Postgres） | AC-01~AC-08、AC-13；并发与"是否发起调用"的最终证据 |
| 界面层 | 手工用 Playwright 驱动真实浏览器（不入仓库依赖） | AC-09/10/11/14，截图存 `docs/verification/` |

逻辑层的假存储把 `updateMany` 当作原子操作，所以它证明的是**调用方式**（单条原子语句、没有读-改-写窗口），不是数据库的真实并发；后者必须由接口层给出。

### 8.2 命令

```sh
# 前置：迁移与启动（终端一）
wasp db migrate-dev
wasp start                      # 若要把日志留在文件里：wasp start > /tmp/wasp-dev.log 2>&1

# 静态检查
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit

# 逻辑层
npm run verify:unit

# 接口层（默认打 http://127.0.0.1:3001，日志读 /tmp/wasp-dev.log）
npm run verify:quota
npm run verify:quota -- --base-url http://127.0.0.1:3001 --log /tmp/wasp-dev.log

# 全库不变式
psql "$DATABASE_URL" -c 'SELECT min(credits), max(credits) FROM "User";'
```

注意：Wasp dev server 的 API 在 `3001`，`3000` 是 Vite 客户端；接口脚本默认打 `3001`。

### 8.3 不做的验证

- 不做浏览器端 E2E 纳入 CI（Playwright 未进依赖）：本轮用一次性脚本跑通并留截图，见 §8.1。
- 不做崩溃注入：TASK 已把崩溃补偿排除在范围外；§3.4 的窗口只做文字说明，不伪造证据。

## 9. 已知限制与后续

1. **崩溃窗口未补偿**（§3.4）。后续方案：加 `CreditLedger` 表记 `pending/committed/refunded`，或用对账任务按 `callId` 修正。不做的理由：TASK 明确排除，且会引入第二张表与迁移，超出「完善额度处理」的最小闭环。
2. **refund 不在事务内与 commit 互斥**：正常路径不会双退，但没有账本可审计。同上。
3. **未做故障注入验证**：`commitPlan` 写库失败与 `refundCredit` 失败两条分支有代码与单测覆盖，但没有在真实数据库上制造故障，VERIFICATION 中标注为"仅单测覆盖"。
4. **测试脚本会在开发库留下测试账号**（每次运行 6~7 个）。不影响断言，清库用 `wasp db reset`。

## 10. 决策记录

| ID | 决策 | 备选 | 理由 |
| --- | --- | --- | --- |
| D1 | 条件 UPDATE 预扣 | 见 §3.2 | 单行、单库、无新依赖，锁不跨模型调用 |
| D2 | reserve 在前、commit 在后 | 先调用再扣 | 只有先扣才能保证「不足不调用」与「不透支」同时成立 |
| D3 | 失败用退还而非"回调后退" | 事务回滚 | 回滚需要长事务，见 §3.3 |
| D4 | 502 表示模型失败 | 500 / 424 | 与写库失败的 500 区分开，前者可重试、后者需人工看，客户端提示不同 |
| D5 | 返回体带 `creditsRemaining` | 客户端另发查询 | 少一次往返，且余额与本次扣减严格对应 |
| D6 | 额度逻辑独立成 `credits.ts` | 写在 `operations.ts` 里 | 让额度分支能被假存储单测（§8.1） |
| D7 | 余额只在页头显示一处 | 页面里再加一份 | 两处余额必然出现不一致（快照 vs 实时），单一来源更省心 |

## 11. 修订记录

| 版本 | 变更 | 依据 |
| --- | --- | --- |
| v0.1 | 初稿 | 对 `main@114aeb2` 的静态阅读；A2/A3/A4/A6/A7 待验证 |
| v0.2 | ①「用户知情」从"无余额显示"改为"页头余额是陈旧快照"，方案随之改为订阅 `getCreditBalance` + refetch（D7）；②A6 推翻：`strict` 下对象与 `null` 比较不报错；③A4 由 AC-14 验证通过；④`credits.reserved` 去掉 `creditsRemaining`（改为 commit 时记录）；⑤新增 AC-13/AC-14；⑥S2/S3 合并为一次提交 | 实现与实测；见 VERIFICATION.md |
