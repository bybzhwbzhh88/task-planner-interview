# 提交说明

- 姓名或称呼：韩梦婷
- 应聘方向：产品实习生（产品）
- 打码手机号：157****8317

## 结果概览

原流程在模型调用后才检查旧额度，导致零额度调用、并发透支，以及失败后扣费结果不清楚。本方案采用“调用前原子预占、失败后返还”，并为成功、额度不足、可补偿失败和返还未知分别设计反馈与下一步。产品方案、流程、原型、研发拆解和验收案例已经完成，并附带可运行实现及自动化验证。

## 交付入口

- [产品方案](PRODUCT_SPEC.md)：需求判断、目标规则、用户流程、低保真原型、交互文案、任务拆解和产品验收案例。
- [技术规格](SPEC.md)：方案实现、并发处理、技术验收案例和实际验证记录。
- [额度编排](src/demo-ai-app/creditReservation.ts)：原子预占所需查询，以及失败返还流程。
- [服务端操作](src/demo-ai-app/operations.ts)：参数校验、额度错误映射、模型调用和结果保存。
- [客户端反馈](src/demo-ai-app/DemoAppPage.tsx)：成功、额度不足和生成失败提示；零额度禁用按钮。
- [核心测试](src/demo-ai-app/creditReservation.test.ts)：成功、失败补偿和五路并发。
- [PostgreSQL 并发测试](src/demo-ai-app/creditReservation.integration.test.ts)：真实 Prisma 条件更新验证。

运行核心测试：`npm run test:quota`。配置迁移后的 `DATABASE_URL` 后运行数据库测试：`npm run test:quota:db`。完整本地启动与框架检查沿用 [README.md](README.md)。

## 验证记录

执行 `pnpm dlx vitest@4.1.9 --config vitest.quota.config.mjs run`，预期核心测试全部通过、未配置数据库时集成用例跳过；实际结果为 8 个通过、1 个跳过。

- AC-1 成功：通过；保存一次，额度从 3 变为 2。
- AC-2 额度不足：通过；模型和保存均未调用，额度保持 0。
- AC-3 模型失败：通过；错误返回且额度恢复为 1。
- AC-4 五路并发：通过；仅 1 个成功，模型和保存各调用一次，额度为 0。
- AC-5 输入保护：代码已实现；完整 Wasp Action 集成验证未运行。

当前 Windows 环境为 Node.js 20.20.2，无 WSL2、Docker 和 PostgreSQL。Wasp 0.25.0 安装程序返回 `Wasp is not supported on this platform`，因此 `wasp compile`、两个项目 TypeScript 检查和 PostgreSQL 集成用例均明确标记为未运行。复验命令和数据库用例行为记录在 [SPEC.md](SPEC.md#未运行框架和数据库检查)。

## 待办与交接

- 需在 README 指定的 WSL2、Node.js 24.14.1、Wasp 0.25.0 和 PostgreSQL 环境运行未完成检查。
- 预占后进程崩溃的自动补偿不在题目范围；当前实现会对正常模型或保存失败立即返还额度，并单独报告返还失败。
