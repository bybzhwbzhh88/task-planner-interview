# 技术方向提交说明

> **问题判断与方案**：初始版本先调用模拟 AI、再使用可能过期的会话额度检查，存在额度不足仍调用模型、并发透支的风险。已改为 **数据库条件原子预占 → 生成 → 保存成功确认消费；失败返还**，增加余额展示和错误反馈。**当前完成状态**：源码已集成；Node 层 15 项自动化测试通过；Wasp 编译与 PostgreSQL/HTTP 集成验证未执行，见验证记录。

- **姓名或称呼**：`【提交人填写】`
- **应聘方向**：技术
- **打码手机号**：`【提交人填写前三位****后四位】`

> PR 标题：`技术｜【称呼】｜【前三位****后四位】`。仓库与 PR 公开，严禁输入完整手机号码。请在正式提交前填完上述两处占位符。

## 交付入口

- [SPEC.md](SPEC.md)：范围、假设、原子预占及返还流程、并发策略、分步实现、验收案例 A01–A09。
- [src/demo-ai-app/creditQuota.ts](src/demo-ai-app/creditQuota.ts)：可测试的额度预占/返还与错误分型。
- [src/demo-ai-app/operations.ts](src/demo-ai-app/operations.ts)：`generatePlan` 集成、登录/输入/空任务检查、错误码转换、余额查询。
- [src/demo-ai-app/DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx)：余额展示、成功及不同失败场景提示。
- [tests/creditQuota.test.mjs](tests/creditQuota.test.mjs) + [tests/mockAi.test.mjs](tests/mockAi.test.mjs)：独立业务逻辑、模拟模型测试与同进程并发模拟。
- [tests/quota.postgres.test.mjs](tests/quota.postgres.test.mjs)：真实 PostgreSQL 连接并发条件更新脚本。
- [docs/VALIDATION.md](docs/VALIDATION.md)：命令、验收案例、实际结果和未运行部分。

## 验证与结果

`npm run test:quota`：**已运行，15/15 通过**，详见 [实际输出](docs/test-results-quota.txt)。独立 `creditQuota.ts` 的 `tsc --noEmit --strict ...`：**已运行，通过**。`wasp compile`、完整两项 TypeScript 项目检查及 PostgreSQL 并发脚本：**未运行**（当前环境缺少 Node 24+/Wasp CLI/PostgreSQL/psql 与项目依赖）。A01–A08 的模块测试和真实模拟接口覆盖情况，以及 A09 未验证情况，见 [验收对照表](docs/VALIDATION.md)。

## 待办与交接

1. 在合规的 Node 24.14.1+ / Wasp 0.25.0 / PostgreSQL 环境按 [README](README.md) 安装并运行编译、两项 TypeScript 检查和实际网页交互验收。
2. 在独立测试数据库执行 `npm run test:quota:db`；验证 HTTP 入口下 10/50 个真实并发请求的日志和持久化结果。
3. 如出现返还失败，日志会记录 `plan.quota.failed`，应人工核对余额和 `PlanResult`；本题不处理崩溃后自动恢复。
4. 提交人填写称呼、**打码**手机号并建立 Fork PR。此前上传的仓库 ZIP 不含上游 `.git` 历史；请从上游 Fork/clone 开始依次应用交付补丁，保留 SPEC 在代码之前提交的顺序。
