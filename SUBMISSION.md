# 提交说明

- 姓名或称呼：郑女士
- 应聘方向：技术｜Agent 应用开发
- 打码手机号：132****3133
- 通知时间：2026-10-21 17:38，北京时间（UTC+8）
- 提交截止：2026-10-23 17:38，北京时间（收到通知后48小时）
- PR 标题：`技术｜郑女士｜132****3133`
- 当前交付：实现、验证、审查补强完成；个人Fork和分支已推送，已提交 [PR #3](https://github.com/bybzhwbzhh88/task-planner-interview/pull/3)，等待仓库方评审

## 结果概览

原项目余额为 0 时仍调用模型，并发准入使用认证余额快照。现在在模型调用前用 PostgreSQL 条件更新预占额度，按请求记录确认消费或释放。模型失败不消费，结果保存和消费状态在同一事务确认，重复释放及提交应答丢失不会盲目退款。

前端显示可用额度、同步刷新，区分明确失败与结果不明，零额度禁用生成并说明下一步。保留本地模拟模型和原有任务语义。

## 交付入口

- [SPEC](SPEC.md)：规则、方案取舍、流程、边界、实现拆解与 AC01～AC24。
- [quotaService](src/demo-ai-app/quotaService.ts)、[planService](src/demo-ai-app/planService.ts)：原子预占、确认、释放与异常编排。
- [迁移](migrations/20261021133000_quota_reservation/migration.sql)、[页面](src/demo-ai-app/DemoAppPage.tsx)。
- [PR正文草稿](docs/PR_BODY.md)：可复制的说明与验证结论。
- [运行和重复验证](docs/QUOTA_RUN.md)：npm run verify自动隔离数据库；npm run verify:all执行完整HTTP/浏览器；[CI工作流](.github/workflows/verify.yml)使用同一入口。
- [逐项实际验收](docs/VERIFICATION.md)、[脱敏结果摘要](docs/verification/summary.json)。
- [数据库测试](tests/quota.integration.test.ts)、[HTTP 脚本](scripts/verify-quota.mjs)、[浏览器脚本](scripts/verify-browser.cjs)。

## 验证记录

AC01～AC24 的命令组、前置操作、预期、实际与证据逐项列在 VERIFICATION，避免在此重复。最终结果：真实 PostgreSQL 17/17 测试通过；HTTP 35 场景通过，包含两种余额各10轮五请求并发；浏览器补测后15步通过、0页面异常；编译及两项 TypeScript 检查退出0。

审查补强已完成：修复生成成功后认证刷新失败导致页面卸载的问题；未登录保护已回归。该审查阶段重跑数据库、浏览器及三项编译/类型检查，未重跑HTTP；2026-10-22最新自助CI已重新执行全部17/35/15，见VERIFICATION第8节。

环境原始基线单独保留在 [BASELINE_RUN](docs/BASELINE_RUN.md)。测试报告没有把设计预期当作通过记录；历史本机日志和截图受Git忽略；本轮完整报告和截图可从CI附件下载，仓库保留脱敏快照与可执行入口。

## 待办与交接

本地 Git 设计提交为 `99cecc9994a24fbd78549f54dd2f9166a6bf2cfd`，实现提交为 `da266a9146fc173213840f87328c36dafdc47f1c`，验证提交 `c1f2976`、审查修复 `2b46f01` 接续其后，未重写上游历史。

服务崩溃或数据库长期不可用可能留下暂占额度，自动崩溃补偿在题目范围外；未知状态不得自动重试或无条件返还。未做真实网络断电测试和多副本 HTTP 部署；对应替代验证及边界见 VERIFICATION。

身份及通知时间已由应聘者确认，公开提交仅使用上方称呼与打码手机号。个人Fork及分支推送已完成，作业已向原仓库提交 [PR #3](https://github.com/bybzhwbzhh88/task-planner-interview/pull/3)，标题为 `技术｜郑女士｜132****3133`。

## PR目标核对

- 目标仓库：`bybzhwbzhh88/task-planner-interview`，目标分支 `main`。本轮只读核对远端HEAD和main均为 `114aeb28f6368e96c08a25627ac094b8d102fd1b`。
- 来源：[Theodora-Y/task-planner-interview](https://github.com/Theodora-Y/task-planner-interview)，分支 `chore/original-baseline` 已推送；origin指向个人Fork，upstream保留原仓库。
- 最后功能提交：`2b46f01f487be8931d468cbc2b88d1233fcad9c6`；之后仅做文档收尾，不改变被验证源码。
- 本地先保留SPEC：`99cecc9`（2026-10-21 21:06:37+08:00，仅三份文档）是 `da266a9`（21:45:24+08:00，功能实现）的直接父提交。初稿未覆盖。
- 设计、实现、验证及文档提交已随分支完整推送至个人Fork，未压缩或重写历史；本地分支跟踪origin同名分支。
- PR：[技术｜郑女士｜132****3133](https://github.com/bybzhwbzhh88/task-planner-interview/pull/3)，来源为Theodora-Y的上述分支，目标为上游main；当前等待仓库方评审。
- 交接规格修订：`21bad24` 仅重写SPEC并修正验收章节引用，保留AC01～AC24及功能实现前的设计提交。

自助复验已补齐：[完整CI通过](https://github.com/Theodora-Y/task-planner-interview/actions/runs/39793738843)，S17/H35/B15及三项编译/类型检查均通过，170秒；干净源码检出核心57秒、完整136秒通过。统一入口npm run verify／verify:all，不依赖作者路径或个人配置。额度逻辑、模型和原验收断言未改。
