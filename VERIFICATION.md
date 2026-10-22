# 额度处理验证记录

> 日期：2026-10-22  
> 状态：核心规则与界面反馈均已验证通过；PR [#10](https://github.com/bybzhwbzhh88/task-planner-interview/pull/10) 已创建。

## 结论

额度在模型调用前通过 PostgreSQL 条件更新原子预占。模型或保存失败会归还预占额度；并发请求只由成功预占额度的请求进入模型调用。实际请求中未出现负额度或额度不足时调用模型的情况。

## 环境

| 项目 | 配置 |
| --- | --- |
| 系统 | WSL2 Ubuntu |
| Node.js / npm | 24.14.1 / 11.11.0 |
| Wasp | 0.25.0 |
| PostgreSQL | 16.15，容器 `task-planner-postgres` |
| 开发数据库 | `taskplanner` |
| 验证数据库 | `taskplanner_verify` |
| 临时 API | `http://127.0.0.1:3101` |

验证前已运行 `wasp compile`、`npx tsc --project tsconfig.src.json --noEmit` 和 `npx tsc --project tsconfig.wasp.json --noEmit`。

## 自动化结果

| 检查 | 命令 | 实际结果 |
| --- | --- | --- |
| 额度编排单元测试 | `npm run test:quota` | 1 个测试文件、5 个测试全部通过 |
| 真实接口与并发 | `npm run verify:quota` | Q1-Q5 全部输出 `PASS`，脚本以成功状态退出 |
| Wasp 编译 | `wasp compile` | 成功 |
| TypeScript 源码 | `npx tsc --project tsconfig.src.json --noEmit` | 成功，无输出 |
| TypeScript Wasp 配置 | `npx tsc --project tsconfig.wasp.json --noEmit` | 成功，无输出 |

`npm run verify:quota` 会重置 `taskplanner_verify` 中的测试数据、应用迁移、启动临时 API，并捕获服务端日志。

## 验收对照

| ID | 操作 | 实际可观察结果 | 状态 |
| --- | --- | --- | --- |
| Q1 成功 | 新账号额度 3，创建任务后生成一次 | HTTP `200`，返回余额 2；数据库余额 2；`PlanResult` 1 条；新增 `mock-ai.started` 1 条 | 通过 |
| Q2 额度不足 | 额度设为 0 后生成 | HTTP `402`；余额仍为 0；无 `PlanResult`；无新增 `mock-ai.started` | 通过 |
| Q3 模型失败 | 额度 2，任务包含 `[fail]` | HTTP `502`；余额恢复为 2；无 `PlanResult`；有 1 条 started 和 1 条 failed 日志 | 通过 |
| Q4 并发 1 额度 | 额度 1，同时发送 4 个请求 | 状态码为 `200, 402, 402, 402`；余额 0；`PlanResult` 1 条；started 1 条 | 通过 |
| Q5 并发 3 额度 | 额度 3，同时发送 5 个请求 | 状态码为 `200, 200, 200, 402, 402`；余额 0；`PlanResult` 3 条；started 3 条 | 通过 |
| Q6 前端反馈 | 在 Chrome 检查额度 0、成功和模型失败 | 额度 0 时按钮禁用并说明不扣额度；成功时页头从 1 变为 0 且显示扣费提示；`[fail]` 时提示失败且页头保持 2 | 通过 |
| Q7 保存失败 | 单元测试注入结果保存失败 | 错误类型为 `persistence-failed`；归还调用 1 次；额度恢复到请求前数值 | 通过 |

## 关键证据

- Q4 并发输出：`Q4 concurrency with one credit: PASS`，只有 1 个 `mock-ai.started`，其余请求在约 60 ms 内返回 `402`。
- Q5 并发输出：`Q5 concurrency with three credits: PASS`，只有 3 个 `mock-ai.started`，最终额度为 0。
- Q3 服务端日志包含相同 `callId` 的 started/failed 事件，随后输出 `credit.refunded`，余额为 2。
- 单元测试覆盖 `insufficient-credits`、`provider-failed`、`persistence-failed` 和 `refund-failed`。

## 未验证与范围外

- Pull Request [#10](https://github.com/bybzhwbzhh88/task-planner-interview/pull/10) 已创建，当前等待维护者评审。
- 未实现支付、订阅、跨账号防刷、幂等键或服务崩溃后的自动额度恢复。
- 本次没有浏览器级并发压测；并发行为通过真实 HTTP 接口和独立 PostgreSQL 数据库验证。
