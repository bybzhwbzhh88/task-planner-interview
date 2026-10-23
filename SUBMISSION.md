# 提交说明

- 姓名或称呼：夏天文
- 应聘方向：技术
- 打码手机号：136****4685

## 结果概览

原流程在模型调用后才检查登录态中的余额，零额度请求也会调用模型，并发请求可能透支。现改为数据库原子条件预扣，取得额度才调用模型，成功保存后保留扣减，明确失败单次退款。页面在请求结束后刷新真实余额，并提示操作结果及下一步。实现和测试已完成，未新增依赖、数据表或迁移。

## 交付入口

- [SPEC.md](SPEC.md)：范围、流程、实现步骤与验收案例。
- [quota.ts](src/demo-ai-app/quota.ts)：条件预扣、模型调用、保存和退款。
- [operations.ts](src/demo-ai-app/operations.ts)：接入生成操作和余额查询。
- [DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx) 与 [App.tsx](src/client/App.tsx)：生成反馈和余额展示。
- [quota.test.ts](tests/quota.test.ts)：全部自动化用例，配置 `TEST_DATABASE_URL` 后执行 `npm test`。

应用启动见 [README.md](README.md)，测试环境和完整执行命令见 [TEST_RESULTS.md](TEST_RESULTS.md)。

## 验证记录

编译和两项类型检查通过；79 项测试全部通过，包括 19 项流程测试、15 项真实数据库测试和 45 项分级并发测试。并发测试共发起 14940 个请求，核对实际模型日志、余额与保存数量。各场景预期与实际结果见 [TEST_RESULTS.md](TEST_RESULTS.md)。

## 待办与交接

扣减、保存或退款的提交结果不确定时，系统提示核查，不自动退款或重试；没有持久化额度流水，需人工确认。主动重新生成按新请求扣费。
