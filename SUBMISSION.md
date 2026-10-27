# 提交说明

- 姓名或称呼：宋若晗
- 应聘方向：技术
- 打码手机号：173****3226

## 结果概览

初始实现先调模型再扣额度，内存判断无法防并发，额度 0 时仍会发起模型调用。改为“调用前原子预占、失败退回”：用 `credits > 0` 条件下的单条数据库更新占额度，模型明确失败或结果保存失败时退回；页面显示余额、结果和下一步。

核心逻辑、并发测试和文档已完成；本机没有 WSL/Docker/Postgres/Wasp，完整应用未启动，页面与真实数据库并发未实测，已在验证记录中标明。

## 交付入口

- 设计与拆解：[`SPEC.md`](SPEC.md)
- Spec 调整记录：[`docs/SPEC_CHANGELOG.md`](docs/SPEC_CHANGELOG.md)
- 主要改动：
  - [`src/demo-ai-app/generate-plan.ts`](src/demo-ai-app/generate-plan.ts)（预占/退款编排）
  - [`src/demo-ai-app/operations.ts`](src/demo-ai-app/operations.ts)（Prisma 原子更新、402/502 映射、余额查询）
  - [`src/demo-ai-app/DemoAppPage.tsx`](src/demo-ai-app/DemoAppPage.tsx)（余额、状态、禁用与下一步）
  - [`src/demo-ai-app/mockAi.ts`](src/demo-ai-app/mockAi.ts)（明确失败错误码）
- 验证脚本：[`tests/generate-plan.test.ts`](tests/generate-plan.test.ts)
- 运行命令：

  ```sh
  npm run test:quota
  npm run typecheck:quota
  ```

  完整应用运行方式见 [`README.md`](README.md)。

## 验证记录

详见 [`VERIFICATION.md`](VERIFICATION.md)。摘要：

- 12 个用例全部通过，覆盖成功、额度不足、模型失败、保存失败、退款失败、空结果、任务读取失败、5 并发和真实 `mockAi` 日志；其中 5 并发只出现 1 次 `mock-ai.started`，3 个额度时恰好 3 个成功。
- 核心与测试的类型检查通过（`tsconfig.verify.json`）。
- 未运行：`wasp compile`、完整 `tsc`、页面走查、真实 HTTP 401、真实 Postgres 并发；原因和补测步骤见验证记录 §4–§5。

## 待办与交接

- 预占成功后进程崩溃会少 1 个额度，按题目范围未做自动补偿；后续可加预占流水和超时对账。
- 退款失败会返回 `CREDIT_REFUND_FAILED` 并记录日志，需要人工核对余额。
- 没有幂等键，网络重试可能重复扣费；当前按“不同请求是不同任务”处理。
- 并发正确性依赖数据库的条件更新；内存测试验证了请求交错和退款路径，但未验证真实 PostgreSQL 锁行为，需在完整环境补一次并发实测。
- PR 标题：`技术｜宋若晗｜173****3226`。
