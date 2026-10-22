# 提交说明

- 姓名或称呼：小郝
- 应聘方向：技术
- 打码手机号：151****8023

## 结果概览

原 `generatePlan` 先调模型后查额度，且额度读的是登录快照，额度不足时仍会发起模型调用，并发下同一额度可被多个请求同时使用（透支）。本次改为“原子预留 + 失败退还”：用一条原子条件更新（`UPDATE ... SET credits = credits - 1 WHERE credits > 0`）在调用模型前预留额度，扣不动直接 402 且不发起调用；模型明确失败时原子退还。前端补充剩余额度展示、额度为 0 禁用按钮、失败清除旧日程与分场景提示。AC1–AC5 全部验证通过，当前状态：已完成，无阻塞问题。

## 交付入口

- 方案与设计：[SPEC.md](SPEC.md)（范围与假设、成功/异常流程、并发思路、实现步骤、验收案例；初稿与修订均在 Git 历史中）
- 主要改动：
  - `src/demo-ai-app/operations.ts` — `generatePlan` 重写为“查任务 → 原子预留 → 调用 → 成功存档 / 失败退还”（commit `feat: atomic credit reservation with refund on provider failure`）
  - `src/demo-ai-app/DemoAppPage.tsx` — 剩余额度展示与刷新、额度为 0 禁用按钮、失败清旧结果、402/502 分场景提示
- 验证脚本：[scripts/verify-credits.mjs](scripts/verify-credits.mjs)（纯 HTTP、零依赖，覆盖 AC1–AC4，可重复执行）

运行方式（详见 README.md）：

```sh
wasp db migrate-dev        # 首次
wasp start 2>&1 | tee server.log   # 终端一：启动应用（tee 日志供脚本断言）
node scripts/verify-credits.mjs --server-log server.log   # 终端二：运行验证
```

## 验证记录

环境：WSL2 Ubuntu 24.04、Node.js 24.14.1、Wasp 0.25.0、本地 PostgreSQL 16。验证脚本每个场景注册全新账号（初始额度 3），断言接口状态码、数据库余额（经 `/auth/me` 读取）、`PlanResult` 数量及服务端日志中 `mock-ai.*` 事件次数与 `callId` 一致性。2026-10-22 实跑结果：22 条断言全部通过，退出码 0。

| 验收案例 | 操作 / 命令 | 预期结果 | 实际结果 |
| --- | --- | --- | --- |
| AC1 成功消耗 | 新账号 + 1 条任务，调 `generatePlan` | 200；额度 3→2；`started`/`succeeded` 各 1 次同 `callId`；新增 1 条 `PlanResult` | ✅ 与预期一致 |
| AC2 额度不足 | 连调 3 次耗尽额度后调第 4 次 | 第 4 次 402；额度保持 0；无新增 `mock-ai.started` | ✅ 与预期一致 |
| AC3 模型失败 | 任务含 `[fail]`，调 `generatePlan` | 502；额度不变（3）；`started`/`failed` 各 1 次同 `callId`；无新增 `PlanResult` | ✅ 与预期一致 |
| AC4 并发不透支 | 同会话并发 10 个 `generatePlan` | 恰好 3 个 200、7 个 402；额度终值 0 不为负；`started` 恰好 3 次；新增 3 条 `PlanResult` | ✅ 状态分布 `{"200":3,"402":7}`，其余与预期一致 |
| AC5 基础检查 | `wasp compile`；`npx tsc --project tsconfig.src.json --noEmit`；`npx tsc --project tsconfig.wasp.json --noEmit` | 三条命令均通过 | ✅ 全部通过 |

**前端行为验证**（2026-10-22 实跑）：[scripts/verify-ui.mjs](scripts/verify-ui.mjs) 用 Playwright 无头浏览器完成真实页面走查——注册新账号后页面显示“剩余额度：3”，添加任务并生成日程后显示“剩余额度：2”且日程正常渲染。证据截图：[生成前](docs/assets/ui-before-generate.png)、[生成后](docs/assets/ui-after-generate.png)。该脚本需单独安装 Playwright（`npm i playwright && npx playwright install chromium`），非项目依赖。

## 待办与交接

- **已知限制（按 TASK.md 范围接受）**：进程在“已扣额度、模型调用中”崩溃会损失 1 点额度，未实现崩溃补偿；若未来需要，可在 `User`/`PlanResult` 间加调用记录表做对账。
- **退还失败兜底**：若退还时数据库故障，仅记录错误日志（`Failed to refund credit`），额度会少退 1 点；DB 故障本身已超出本练习范围。
- 验证脚本依赖运行中的应用与数据库；`--server-log` 不传时只做接口与余额断言，不断言日志。
- 开发环境备注：Windows 上 Wasp CLI 需 WSL2；本次在 WSL 内用本地 PostgreSQL（非 Docker），`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/taskplanner`。
