# 提交说明

- 姓名或称呼：刘俊岩
- 应聘方向：AI产品实习生
- 打码手机号：137****1381

## 结果概览

额度处理已从“先调用模型、后检查旧余额”改为“模型调用前原子预占、失败归还”。同一账号并发请求不会透支；模型失败不扣额度；额度不足不会触发 `mock-ai.started`；前端会展示扣费结果、失败原因和可用额度。

## 交付入口

- Pull Request：[#10](https://github.com/bybzhwbzhh88/task-planner-interview/pull/10)
- 方案与验收：[SPEC.md](SPEC.md)
- 额度编排：[quotaGeneration.ts](src/demo-ai-app/quotaGeneration.ts)
- 服务端操作：[operations.ts](src/demo-ai-app/operations.ts)
- 前端反馈：[DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx)
- 单元测试：[quotaGeneration.test.ts](tests/quotaGeneration.test.ts)
- 并发验证脚本：[verify-quota.mjs](scripts/verify-quota.mjs)
- 运行说明：[README.md](README.md#额度处理验证)

## 验证记录

Q1-Q7 的操作、预期结果和实际结果见 [VERIFICATION.md](VERIFICATION.md)。`npm run test:quota` 和 `npm run verify:quota` 均已通过。

## 待办与交接

- 服务崩溃后的额度自动恢复不在本次范围；预占后进程异常退出需要人工核查。
