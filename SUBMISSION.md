# 技术方向提交｜小罗｜152****7749

## 结果概览

原流程先调用模拟模型、后检查旧余额，零额度仍会调用模型，同账号并发也可能透支。现在先用数据库条件更新预扣 1 个额度，成功保存日程后保留扣减；模型或明确的写入失败时补回。页面显示服务端余额，并区分本次成功、明确失败与状态待核对。**代码、单测及隔离 PostgreSQL 验证完成；Wasp 编译和页面手测尚未完成。**

## 交付入口

| 内容 | 入口 |
| --- | --- |
| 需求理解、流程、并发方案、拆解、验收 | [SPEC.md](SPEC.md)；Git 历史中的首个提交保留代码修改前的初稿 |
| 服务端额度操作 | [quota.ts](src/demo-ai-app/quota.ts)、[operations.ts](src/demo-ai-app/operations.ts) |
| 额度查询与页面 | [demo-ai-app.wasp.ts](src/demo-ai-app/demo-ai-app.wasp.ts)、[DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx) |
| 可重复验证 | [quota.test.mjs](tests/quota.test.mjs)、[quota.db.mjs](tests/quota.db.mjs) |

## 验证记录（2026-10-22）

本机 Node.js 24.21。先运行 `node --test tests/quota.test.mjs`：**6/6 通过**，涵盖预扣、无额度、明确失败补回、并发、补回失败及预扣状态未知。随后在本机新建仅供本次验证的 PostgreSQL 16 数据库 `task_planner_quota_test`，按仓库的 `schema.prisma` 用 Prisma 5.19.1 生成客户端并执行 `prisma db push`，运行 `node tests/quota.db.mjs`。脚本只创建自己的用户、任务和结果，断言后清理；不会写入现有应用数据库。

| 案例 | 预期 | 实测证据与结果 |
| --- | --- | --- |
| V1 成功 | 1 个模型调用、1 条结果、额度 1→0 | `started/succeeded` 各 1；`{credits:0,results:1}`；通过 |
| V2 无额度 | 模型调用 0 次、结果 0、额度 0 | `started` 增量 0；`{credits:0,results:0}`；通过 |
| V3 模型失败 | 1 次明确失败、无结果、额度补回 | `started/failed` 各 1；`{credits:1,results:0}`；通过 |
| V4 失败后重试 | 生成 1 条结果、额度 1→0 | 修改任务后再次生成；`{credits:0,results:1}`；通过 |
| V4a 保存失败 | 无结果、额度补回 | 用无效结果内容触发 Prisma 写入错误；`{credits:1,results:0}`；通过 |
| V5 最后额度并发 | 两次请求仅一次进入模型、余额不为负 | 1 次 `started`、1 个成功、1 个额度不足；`{credits:0,results:1}`；通过 |
| V6 失败并发 | 占用期间第二次不进入模型；失败补回 | 1 次 `started`、1 个额度不足；`{credits:1,results:0}`；通过 |
| V7 客户端超时 | 不自动重试，可刷新核对 | 页面逻辑已实现；未在浏览器中手测 |

上述数据库测试执行时每次 `mock-ai.started` 与对应的 `succeeded/failed` 共用同一 `callId`；V2 没有 `started`。单测还对结果保存失败、预扣异常和补回异常做了断言。`node --check tests/quota.db.mjs`、`git diff --check` 通过。

### 接手者重跑

1. 快速逻辑验证：在仓库根目录执行 `node --test tests/quota.test.mjs`，需要 Node.js 24.14.1+。
2. 数据库验证：建立**独立空库**，库名须包含 `task_planner_quota_test`；设置 `QUOTA_TEST_DATABASE_URL` 指向它。安装 Prisma CLI 与 `@prisma/client` **5.19.1**，按 `schema.prisma` 执行 `prisma generate`、`prisma db push`。在仓库根目录运行 `node tests/quota.db.mjs`。若 Prisma 客户端装在仓库外，另设 `QUOTA_PRISMA_MODULE` 为其 `node_modules/@prisma/client` 绝对路径。脚本拒绝运行在名称不含该标记的数据库上。
3. 应用验证：按 [README.md](README.md) 的 Linux/WSL 环境安装 Wasp 0.25.0 与依赖，在独立开发库运行 `wasp compile`、`npx tsc --project tsconfig.src.json --noEmit`、`npx tsc --project tsconfig.wasp.json --noEmit`，再运行 `wasp start`。到 `/demo-app` 用两个同账号会话复查 V1、V2、V3、V5、V7 的页面表现。

## 待办与边界

- 本机是 Windows，未安装 WSL 发行版和 Wasp 0.25.0；`wasp compile`、两项 TypeScript 检查、端到端页面及 V7 尚未运行，接手者应优先完成第 3 步。数据库脚本验证的是与服务端操作相同的额度适配与模拟接口，不能替代 Wasp 操作层编译或浏览器验证。
- 进程在预扣后崩溃、数据库在写入结果后失联、预扣或补回状态不明时，自动补偿无法保证。服务端记录 `quota.state.unknown`，页面提示刷新核对余额和最近结果，不自动重试；需人工核对 `User.credits`、`PlanResult` 与日志。范围遵循 [TASK.md](TASK.md) 的单服务、单数据库及无需崩溃后自动补偿约束。
