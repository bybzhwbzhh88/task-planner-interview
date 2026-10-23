# 提交说明

- 姓名或称呼：小雷
- 应聘方向：技术
- 打码手机号：176****7460

## 结果概览

原流程在调用模型后才以请求开始时的额度快照扣减，额度为零仍会调用模型，并发时可能透支。现改为 PostgreSQL 条件更新原子预留额度：预留失败不调用模型，模型或保存失败归还额度，成功保存结果后确认扣费。实现和文档已完成；本机环境缺少 Wasp、合格 Node 和 PostgreSQL，实际应用验证待在符合 README 的环境中执行。

## 交付入口

技术方向：[SPEC.md](SPEC.md) 说明需求、流程、并发方案、实现拆解与验收案例；主要改动在 [operations.ts](src/demo-ai-app/operations.ts)、[DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx) 和 [demo-ai-app.wasp.ts](src/demo-ai-app/demo-ai-app.wasp.ts)；运行、验证和脚本说明见 [VERIFICATION.md](VERIFICATION.md)。

## 验证记录

逐项验收记录、已执行的静态检查和未运行原因见 [VERIFICATION.md](VERIFICATION.md)。

## 待办与交接

PR 标题为 `技术｜小雷｜176****7460`。进程崩溃后的额度自动补偿不在本轮范围内；其余交接信息见 [VERIFICATION.md](VERIFICATION.md)。
