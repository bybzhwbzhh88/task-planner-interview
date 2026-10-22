# 提交说明

- 姓名或称呼：李晓逸
- 应聘方向：技术
- 打码手机号：`156****8220`

## 结果概览

原实现先调用模型，再检查额度，并发时可能透支。现在先在数据库事务内条件扣减，取得额度后才调用模型；日程保存成功后提交，模型或保存失败则回滚。页面统一从服务端读取余额，补充刷新、禁用原因和失败提示。

Wasp 编译、两项类型检查、13 个数据库测试和 2 个 HTTP 测试已通过，并发场景额外复测三轮通过。页面主要流程已验证，真实窗口焦点切换仍待手动复核。

## 交付入口

- 设计与验收：[SPEC.md](SPEC.md)
- 额度事务核心：[src/demo-ai-app/quota.ts](src/demo-ai-app/quota.ts)
- 服务端操作与错误映射：[src/demo-ai-app/operations.ts](src/demo-ai-app/operations.ts)
- Wasp 声明：[src/demo-ai-app/demo-ai-app.wasp.ts](src/demo-ai-app/demo-ai-app.wasp.ts)
- 页面余额与反馈：[src/client/App.tsx](src/client/App.tsx)、[src/demo-ai-app/DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx)
- 集成测试：[tests/quota.integration.test.ts](tests/quota.integration.test.ts)
- 运行命令：[README.md](README.md) 的“额度集成测试”一节
- 验证记录：[VERIFICATION.md](VERIFICATION.md)

## 验证记录

见 [VERIFICATION.md](VERIFICATION.md)，按 A1–A13 记录命令、结果及未完成项。运行步骤见 [README.md](README.md) 的“额度集成测试”。

## 待办与交接

- PR 标题：`技术｜李晓逸｜156****8220`。
- 不做跨请求幂等；响应丢失时可能已扣费，再次生成可能再扣一次。
- 模型调用期间持有数据库连接和用户行锁。更换长耗时远程模型前，应重新设计预占、确认与释放流程。
- 页面余额可能短暂滞后，最终以数据库为准。
