# 技术｜王浩然｜185****1965

原实现先调用模型，再根据登录上下文的旧余额扣额；无额度请求仍调用模型，并发请求可透支。现改为数据库条件更新原子预占，生成或明确保存失败后归还，并补充余额刷新、错误下一步与历史结果。实现完成，Wasp 编译、两份 TypeScript 检查及 12 项 PostgreSQL 集成测试通过，浏览器成功、失败恢复和双标签页竞争已验证。

- 姓名或称呼：王浩然
- 应聘方向：技术（Agent 开发实习）
- 打码手机号：185****1965

## 交付入口

| 内容 | 入口 |
| --- | --- |
| 范围、并发方案、实现拆解、验收案例 | [SPEC.md](SPEC.md)；初稿提交 `d830ed4` 仅包含 spec，随后才修改代码 |
| 服务端原子预占、补偿与余额查询 | [operations.ts](src/demo-ai-app/operations.ts) |
| 前端状态、余额刷新与历史结果 | [DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx)、[App.tsx](src/client/App.tsx) |
| 可重复验收 | [verify.sh](scripts/verify.sh)、[集成测试](tests/quota.integration.test.ts) |
| 环境与运行命令 | [RUNBOOK.md](docs/RUNBOOK.md) |
| 实际验证、截图、限制 | [VERIFICATION.md](docs/VERIFICATION.md) |

完成 README 的依赖安装并提供独立测试库后，在项目根目录运行：

```sh
export TEST_DATABASE_URL='postgresql://planner:planner_local_test@localhost:55432/planner_test'
bash scripts/verify.sh
```

## 待办与交接

- 服务崩溃后的预占恢复不在本题范围。补偿失败或保存状态不明会返回 503 并记录日志，需人工核查；不能盲目退款，操作指引见运行说明。
- 测试直接调用服务端操作，另有真实页面操作记录；未覆盖供应商真实网络故障、崩溃自动恢复、压力容量或自动化浏览器回归。
- 使用 AI 辅助需求分析、初稿、代码、测试、运行与交接整理；验证记录来自实际命令和浏览器操作。未接入真实模型、支付或订阅。
