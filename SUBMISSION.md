# 提交说明 - 姓名或称呼：小杜 - 应聘方向：技术 - 打码手机号：182\*\*\*\*3780

## 结果概览

问题判断：原 `generatePlan` 把额度检查放在模型调用**之后**，且用请求进入时加载的 `context.user.credits` 陈旧快照判断。后果有三：额度为 0 仍会发起模型调用（违反 TASK.md）；并发请求读同一旧余额、全部通过，造成透支；模型失败时用户只看到英文报错。

方案：改为「调用模型前原子预占 → 成功保留 → 失败回补」。防透支的关键是把检查下推进数据库：单条 `UPDATE "User" SET credits = credits - 1 WHERE id = ? AND credits >= 1`，由 PostgreSQL 行锁把同账号并发串行化，预占失败（count=0）直接 402、不触达模型。模型失败与保存失败各自回补 1 点，净变化为 0。前端新增常驻额度展示与 402/502/500 分状态提示。

当前状态：spec 初稿 → 实现 → 真实环境跑通 45 项断言（0 失败）→ 修订 spec（AC-8 预期写错，已更正并保留历史）。已知限制见 SPEC.md §7 与本文末。

## 交付入口

- 规格：[\`SPEC.md\`](SPEC.md) —— 需求理解、范围与假设、状态流转、并发思路、实现步骤、12 条验收案例。Git 历史保留初稿（`docs(spec): 提交 SPEC 初稿`）与后续修订。
- 主要改动：
  - [\`src/demo-ai-app/operations.ts\`](src/demo-ai-app/operations.ts)：`generatePlan` 三段式额度处理、`reserveCredit`/`releaseCredit`、新增 `getCreditBalance` query；删除不可达的 `null` 分支。
  - [\`src/demo-ai-app/demo-ai-app.wasp.ts\`](src/demo-ai-app/demo-ai-app.wasp.ts)：注册 `getCreditBalance`。
  - [\`src/demo-ai-app/DemoAppPage.tsx\`](src/demo-ai-app/DemoAppPage.tsx)：常驻「剩余额度」、零额度提示、按状态码分支的 toast、每次操作后 `refetch` 余额。
- 验证脚本：[\`scripts/verify-credits.sh\`](scripts/verify-credits.sh)（可重复执行，覆盖成功/额度不足/模型失败/并发/并发×失败/保存失败回补）。
- 运行说明（README 之外的补充）：
  1. 环境同 README；Windows 需在 WSL2 的 Linux 文件系统中操作。数据库可用 Docker，也可自备 PostgreSQL 后在 `.env.server` 配 `DATABASE_URL`。
  2. 起库并迁移：`wasp db migrate-dev`（新库）；启动：`wasp start`。服务端在 3001、客户端在 3000。
  3. 运行验证：`bash scripts/verify-credits.sh --base http://localhost:3001 --log <wasp start 的日志文件>`。脚本用 `psql` 设置额度条件并核对数据库状态，psql 路径可用 `PG_BIN` 覆盖；Docker 数据库请改为等价的 `docker exec` 或修改 `sql()` 函数。退出码 0 即全部断言通过。
  4. 鉴权说明：Wasp 0.25 的操作接口用 `Authorization: Bearer <login 返回的 sessionId>`，不是 cookie；脚本内已处理。

## 验证记录

对应 SPEC.md §6。以下均在本地真实应用（Node 24.16 / wasp 0.25.0 / PostgreSQL 16.15）实测，非推测。完整命令输出可在会话中复现：重跑第 3 步脚本即可。

| 案例 | 方式 | 预期 | 实际 | 结果 |
|------|------|------|------|------|
| AC-1 成功扣减 | e2e 脚本 | 200；credits 3→2；PlanResult +1；started +1 | 全部符合 | PASS |
| AC-2 连续用尽 | e2e 脚本 | 3 次 200；credits=0 | 符合 | PASS |
| AC-3 额度不足不调模型 | e2e 脚本 | 402；credits 保持 0；无新增 started | 402 正文为中文说明；started 增量 0 | PASS |
| AC-4 模型失败不扣 | e2e 脚本 | 502；credits 回补为 3；started +1、PlanResult 0 | 符合 | PASS |
| AC-5 失败后可恢复 | e2e 脚本 | 删 [fail] 后 200；3→2 | 符合 | PASS |
| AC-6 并发（额度1×5请求） | e2e 脚本 | 恰 1×200 + 4×402；credits=0 不为负；started 增量 1 | 200:1 402:4 0其他；增量 1 | PASS |
| AC-7 并发（额度3×5请求） | e2e 脚本 | 恰 3×200 + 2×402；credits=0；started 增量 3 | 200:3 402:2 0其他；增量 3 | PASS |
| AC-8 并发×失败（额度2×4请求） | e2e 脚本 | 恰 2×502 + 2×402；credits 回补为 2；started 增量 2 | 符合 | PASS（初稿预期"4×502"有误，已修订，理由见 SPEC §6） |
| AC-9 未登录 | e2e 脚本 | 401；无 started | 符合 | PASS |
| AC-10 入参非法 | e2e 脚本 | 400；credits 不变；无 started | 符合 | PASS |
| AC-11 额度展示与刷新 | 浏览器实测（Chromium 真实操作） | 初始显示 3；生成 1 次后无需刷新页面自动变 2；toast「日程已生成 / 本次已消耗 1 个额度。」 | 实测 3→2→1，toast 文案与 SPEC §4.3 一致 | PASS |
| AC-12 保存失败回补 | e2e 脚本 + 数据库触发器注入真实 INSERT 失败 | 500；credits 回补为 3；PlanResult 0 新增；移除注入后恢复正常 | 符合（500 正文含 PrismaClientUnknownRequestError 的 cause，回补后再次生成成功） | PASS |
| 静态检查 | `wasp compile`；`npx tsc --project tsconfig.src.json --noEmit`；`npx tsc --project tsconfig.wasp.json --noEmit` | 通过 | 三项均 exit 0 | PASS |
| 脚本汇总 | `verify-credits.sh` 整轮 | 全部断言通过 | **45 项通过，0 失败**（退出码 0） | PASS |

未运行 / 未验证项（如实标注）：

- 零额度场景的**前端 toast 文案**未在浏览器复查（接口层已 PASS；复查任务被中断）。402 文案由服务端统一给出，渲染路径与已验证的成功 toast 相同。
- 高并发压测、请求排队超时、数据库在回补中途不可用（L2 路径）、客户端断网：未测。
- SPEC 初稿计划的独立单元测试文件（I6）未单独交付：Wasp 操作依赖编译期生成的 SDK 类型，脱离 wasp 工具链的 mock 单测成本高，且端到端脚本已在真实 DB + 真实 HTTP 下覆盖同等断言。已在 SPEC 修订中说明该取舍。

## 待办与交接

- 已知限制（详见 SPEC.md §7）：L1 进程在预占后崩溃会丢 1 点额度（TASK.md 明确排除崩溃补偿）；L2 回补 SQL 自身失败只记日志；L4 无额度流水，无法审计每笔变动。若要解决 L1/L4，建议新增 `CreditLedger(id, userId, delta, reason, createdAt)` 流水表，预占与回补都落流水。
- 本次未改 `schema.prisma`、未加迁移，无数据迁移负担。
- 验证脚本依赖 psql 设置前置条件；接手者用 Docker 数据库时按「运行说明」第 3 步调整 `sql()`。
- 允许使用 AI：本次用 AI 辅助定位缺陷、编写实现与验证脚本，并做浏览器操作核对；全部断言以真实运行输出为准，关键决定（如 AC-8 预期修订）由实测结果驱动。
