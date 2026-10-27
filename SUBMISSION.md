# 提交说明

- 姓名或称呼：小徐
- 应聘方向：产品
- 打码手机号：157 + `****` + 9256

## 结果概览

当前额度处理可能造成余额不足仍调用模型、模型失败仍扣额，以及并发透支。产品方案明确成功保存后扣 1 次、调用前余额不足不发起、明确失败不扣，并定义页面反馈和下一步。除产品方案外，也附带了实现演示；完整交付状态和未验证项见下文。

## 交付入口

产品方案入口：[`PRODUCT.md`](PRODUCT.md)。详细交付拆分为[需求与规则](docs/PRODUCT_REQUIREMENTS.md)、[流程与交互](docs/PRODUCT_FLOW.md)、[开发任务](docs/DEVELOPMENT_TASKS.md)和[12 条验收案例](docs/ACCEPTANCE_CASES.md)。

补充实现：[`SPEC.md`](SPEC.md) 记录技术方案；额度处理位于 [`operations.ts`](src/demo-ai-app/operations.ts)，失败提示位于 [`DemoAppPage.tsx`](src/demo-ai-app/DemoAppPage.tsx)。实现是方案演示，不代表生产级额度账本或崩溃恢复能力。

## 验证记录

| 案例 | 操作/命令 | 预期 | 实际 |
| --- | --- | --- | --- |
| 产品验收 A1/A8 | 按 [`docs/ACCEPTANCE_CASES.md`](docs/ACCEPTANCE_CASES.md) 成功生成并刷新，核对余额与日程 | 日程持久化；余额净减 1 且刷新后保持一致 | 未运行：当前环境不能启动 Wasp/数据库 |
| 产品验收 A2/A3 | 余额设为 0 后从页面及服务端请求生成 | 余额不变、无模型调用、页面提示额度不足 | 未运行：当前环境不能启动 Wasp/数据库 |
| 产品验收 A4/A11 | 余额 1，任务包含 `[fail]`，失败后修正重试 | 首次失败净扣 0；成功重试后净扣 1 | 未运行：当前环境不能启动 Wasp/数据库 |
| 产品验收 A5/A6 | `npm run verify:credits`（3 额度/5 并发）及应用并发验收 | 不透支；普通成功任务最多 3 个进入模型 | 未运行：缺少生成的 `@prisma/client`；当前环境无可用 Wasp/WSL 和 PostgreSQL。 |
| 静态检查 | `node --check scripts/verify-credit-concurrency.mjs`；`git diff --check`；TypeScript transpile syntax check | 无语法/空白错误 | 通过；Wasp 编译及完整 TypeScript 检查因 Windows 无 Wasp、未生成 Wasp 模块而未能运行。 |

## 待办与交接

并发脚本需连接迁移完成的 PostgreSQL；脚本结束时会删除临时用户，它验证预留数据库语义，不启动模型。崩溃后额度预留的自动补偿、支付和跨请求幂等不在本次范围内。产品验收案例与技术实现验收并非同一层，完整场景见 [`docs/ACCEPTANCE_CASES.md`](docs/ACCEPTANCE_CASES.md)。
