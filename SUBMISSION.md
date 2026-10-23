# 提交说明

- 姓名或称呼：张颖
- 应聘方向：技术
- 打码手机号：135****5764

## 结果概览

**问题判断**：原实现的额度检查在模型调用**之后**，且依据请求鉴权时的 `context.user.credits` 快照做 check-then-act。三个具体后果：① 额度为 0 仍发起接口调用（`operations.ts:49` 先调模型、`:67` 才查额度）；② `decrement` 无 `> 0` 保护，并发请求可把额度扣成负数；③ 1 个额度可并发生成多份日程。前端不显示余额、模型失败透出英文原始报错，用户无从理解结果。

**方案**：预留-退还（reserve & refund）。**防透支的具体一步**是 `src/demo-ai-app/planGeneration.ts:67-68` 的单条原子预留 `UPDATE "User" SET credits = credits - 1 WHERE id = ? AND credits > 0`（Prisma `updateMany`）：判断与扣减在同一条语句内由 PostgreSQL 行锁串行执行，不存在"先读后写"窗口，不依赖任何快照。预留失败（受影响行数 0）立即返回，模型调用排在预留之后（`:38-43` 的顺序），因此额度不足时接口调用不会发生；预留之后的任何失败（模型抛错或落库失败）执行 `credits + 1` 退还（`:49`、`:82-88`）再报错。

**完成状态**：服务端、前端、两级自动化验证全部完成并通过（vitest 7/7、HTTP 端到端 16/16，各跑两次）；仅 AC-5 浏览器人工步骤因本环境无浏览器**未执行**，已明确标注并附步骤清单。设计全过程见 [SPEC.md](SPEC.md)（v1 初稿 `6ac0d43` → v1.1 修订），逐案例完整输出见 [VERIFICATION.md](VERIFICATION.md)。

## 交付物

| 类别 | 位置 | 内容 |
| --- | --- | --- |
| 设计文档 | `SPEC.md` | 范围与假设、成功/异常流程、并发思路、实现步骤、验收案例 AC-1..AC-6，含修订记录 |
| 核心实现 | `src/demo-ai-app/planGeneration.ts` | 预留-退还全流程：空任务防护、原子预留、模型调用、落库、失败退还；`credits.reserved` / `credits.refunded` 结构化日志。无 Wasp 运行时依赖，可直接被测试导入 |
| 操作层 | `src/demo-ai-app/operations.ts` | `generatePlan` 薄封装：结果映射 402/400/500 中文文案；新增 `getUserCredits` 实时余额查询；删除不可达分支与快照检查 |
| 前端 | `src/demo-ai-app/DemoAppPage.tsx` | 剩余额度常显（每次尝试后强制刷新，含失败退还场景）、额度不足/生成失败/成功的差异化提示、历史日程列表与查看 |
| 路由注册 | `src/demo-ai-app/demo-ai-app.wasp.ts` | 注册 `getUserCredits` 查询 |
| 测试 | `src/demo-ai-app/planGeneration.test.ts`、`src/demo-ai-app/test-env.setup.ts`、`vitest.config.ts` | AC-1/2/3/4/6 + E3 落库失败退还；并发用例断言终态与 `mock-ai.started` 次数（捕获日志） |
| 测试库脚本 | `scripts/test-db-setup.sh` | 幂等发现 Docker 开发库、重建一次性测试库 `taskplanner_test` 并应用迁移，与开发数据隔离 |
| HTTP 验证脚本 | `scripts/verify-http.mjs` | 真实链路端到端（注册→登录→Bearer→`POST /operations/*`），含 10 并发请求场景，每次随机新账号可重复 |
| 记录文档 | `VERIFICATION.md`、`README.md`、本文件 | 逐案例验证记录与证据；运行/测试说明 |

分支 `tech/credits-reserve-refund`，7 个提交：spec 初稿 → 实现 → 测试基建 → HTTP 脚本 → 文档与提交说明，Git 历史完整保留 spec 演进。

## 目标规则逐条完成情况

| 目标规则 | 关键实现（具体行为） | 如何验证（命令 + 断言） | 结果 |
| --- | --- | --- | --- |
| 1. 每成功生成一次，消耗 1 个额度 | 预留即扣减：`planGeneration.ts:67-70` 条件 `UPDATE` 减 1；成功路径保留该扣减并落库 `PlanResult`（`:43-47`）。落库失败视同生成失败，退还额度（假设 A3） | `npm test` AC-1：credits 3→2、`PlanResult` 恰 +1 且内容与返回一致；`verify-http.mjs`：首生成 200 后余额查询 3→2 | ✅ 两级验证通过 |
| 2. 额度不足时，不应发起模型调用 | **调用顺序**保证：预留（`:38`）失败即 `return insufficient_credits`（`:39`），`generateMockSchedule` 排在其后（`:43`）；预留失败时该用户行已被锁判断为 `credits = 0`，无任何模型调用路径 | `npm test` AC-2：断言 `mock-ai.started` **0 次**、`credits.reserved` 0 次；`verify-http.mjs`：额度 0 后请求 402、余额保持 0 | ✅ 两级验证通过 |
| 3. 模型明确失败时，不消耗额度 | 预留成功后进入 try 块（`:42-47`），模型抛错或落库失败都走 catch：`refundCredit` 加回 1（`:49`、`:82-88`）再返回 `provider_failed`；退还有 `credits.refunded` 日志，退还失败有 `credits.refund-failed` 日志（不做补偿，题目豁免） | `npm test` AC-3：credits 前后均 2、`mock-ai.failed` 与 `started` 同 `callId`、`credits.refunded` 1 次；E3 用例注入落库失败同样退还；`verify-http.mjs`：500 文案含「未消耗额度」、余额保持 3、删除 `[fail]` 任务后重试 200 | ✅ 两级验证通过 |
| 4. 同一账号并发，不能额度透支 | 见结果概览：单条 `UPDATE ... WHERE credits > 0` + 行锁（`:67-68`），无 check-then-act 窗口、不读快照；不变式 `credits ≥ 0` 恒成立；模型调用数 ≤ 初始额度（先预留后调用） | `npm test` AC-4：1 额度 × 10 并发恰 1 成功 + 9 个 402、终值 0、`mock-ai.started` 恰 1 次；3 额度 × 20 并发恰 3 成功；`verify-http.mjs`：剩 2 额度 10 并发恰 2×200 + 8×402、并发后余额恰 0 | ✅ 两级验证通过，各重复两次 |
| 5. 用户能理解结果并知道下一步 | 余额常显（`DemoAppPage.tsx:228-244`），**每次尝试结束（含失败/退还）都强制刷新余额与历史**（`:133-139` finally 中 `refetchCredits`/`refetchPlanResults`）；402 提示说明「额度已用完…可查看历史日程、联系管理员重置」（`:116-121`）；模型失败提示「模型接口返回错误，本次未消耗额度，请检查任务后重试」；历史日程可点开查看（`:271-300`） | HTTP 层实测 402/500 响应的 message 即上述文案来源（`operations.ts:48-58`）；UI 渲染为人工步骤 AC-5，**未在本环境执行**（见下表标注） | ⚠️ 服务端文案与状态码已验证；UI 人工步骤待执行 |

## 验证记录（对应验收案例）

自动化命令各连续执行 **2 次**，结果一致（证明可重复）。完整原样输出见 [VERIFICATION.md](VERIFICATION.md)。

| 案例 | 操作或命令 | 预期 | 实际 |
| --- | --- | --- | --- |
| 基础检查 | `wasp compile`；`npx tsc --project tsconfig.src.json --noEmit`；`npx tsc --project tsconfig.wasp.json --noEmit` | 全部通过 | ✅ 全部通过 |
| AC-1 成功消耗 | `npm test`（自动重建测试库） | credits 3→2、`PlanResult` +1、started/succeeded 各 1 次同 callId | ✅ 通过 |
| AC-2 额度不足不调用 | `npm test` AC-2 用例 | `mock-ai.started` 0 次、credits 保持 0、无结果行 | ✅ 通过 |
| AC-3 模型失败退还 | `npm test` AC-3 + E3 用例 | credits 前后不变、`credits.refunded` 1 次、无结果行 | ✅ 通过 |
| AC-4 并发不透支 | `npm test` 两个并发用例（1×10、3×20） | 恰 1/3 个成功、终值 0、`mock-ai.started` 恰 1/3 次 | ✅ 通过 |
| AC-4（HTTP 层） | `node scripts/verify-http.mjs http://localhost:3001`（需 `wasp start`） | 剩 2 额度 10 并发：恰 2×200 + 8×402，余额终值 0 | ✅ ALL PASSED（16 断言） |
| AC-5 用户理解（浏览器） | 人工步骤清单（[VERIFICATION.md](VERIFICATION.md) 末尾，5 步） | 余额展示、三类提示、历史日程均符合预期 | ⚠️ **未运行**（本环境无浏览器，明确标注；服务端同源文案已经 HTTP 层验证） |
| AC-6 空任务不扣费 | `npm test` AC-6 用例 | `no_tasks`、不预留、`started` 0 次 | ✅ 通过（另在 HTTP 首轮实测中观察到删除唯一任务后 400） |

## 待办与交接

- AC-5 浏览器人工步骤：按清单执行（约 10 分钟，`wasp start` 已在运行时直接操作即可）。
- 明确不做（题目豁免，见 [SPEC.md §2](SPEC.md)）：崩溃窗口额度丢失/退还不补偿；支付、订阅、跨账号防刷、Token 精确计价。已知限制：进程在模型调用期间崩溃会丢 1 个额度（预留已生效、退还未执行），不自动补偿。
- `package-lock.json` 工作区有一处 `wasp install` 产生的未提交改动，未纳入分支提交。
