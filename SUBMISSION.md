# 提交说明

- 姓名或称呼：肖文超
- 应聘方向：技术
- 打码手机号：138****8178

## 结果概览

原流程在调用模型之后使用请求中的旧余额判断额度，因此无额度也会调用模型，并发时可能透支。改为数据库条件更新预占 1 次，生成并保存成功后保留扣减，生成或保存失败则原子返还。

本地实现已完成。15 个服务端集成测试、9 项前端组件交互检查、完整 Wasp 编译及两项 TypeScript 检查均通过。Docker 恢复后已在隔离 Linux 容器中补齐编译与数据库验证；完整应用的真实浏览器手动验收尚未执行。未创建 PR、未向远端推送。

## 交付入口

- [SPEC.md](SPEC.md)：范围、流程、并发保护、任务拆解与验收条件。实现前初稿单独保留在提交 `8184a36`。
- [服务端额度处理](src/demo-ai-app/operations.ts)：`credits > 0` 与扣减在一条数据库更新中完成；无额度返回 402，不调用模型；失败返还成功返回 502，返还失败返回 503 并提示核查。
- [页面交互](src/demo-ai-app/DemoAppPage.tsx)：生成状态、额度刷新、失败后下一步和历史日程标识。
- [真实数据库测试](tests/quota.integration.test.ts)、[测试配置](vitest.quota.config.ts)：直接执行真实操作函数、Prisma 与本地模型，只有框架装配和个别故障被替代。
- [运行与测试命令](README.md#额度验证)；[PR 标题和正文草稿](PR_DRAFT.md)。

## 验证记录

验证日期：2026-10-25（Asia/Shanghai）。首次环境：Windows、Node.js 24.14.1、Prisma Client 5.19.1、PostgreSQL 17.10、Vitest 4.1.11（在项目声明的 `^4.1.9` 范围内）。最终环境：Docker Linux / musl、Node.js 24.14.1、Wasp 0.25.0、Prisma Client 5.19.1、PostgreSQL 18.6、Vitest 4.1.11。没有修改仓库锁文件或升级项目依赖声明。

先对独立空测试库执行 `prisma migrate deploy --schema schema.prisma`。设置 `TEST_DATABASE_URL` 后执行 `npm run test:quota -- --reporter=verbose`，Windows 与最终 Linux 环境均为 **1 个测试文件、15 项全部通过，退出码 0**。原始输出见 [首次测试](verification/quota-tests.txt) 与 [最终 Linux 迁移及测试](verification/linux-quota-tests.txt)。最终测试使用 Wasp 实际生成的 Prisma 客户端。

| 验收项 | 预期 | 实际结果 |
| --- | --- | --- |
| A1 成功 | 3→2；保存 1 份；调用 1 次 | 通过；并验证请求快照为 0 时仍以真实数据库余额准入 |
| A2 额度不足 | 余额 0；402；无模型调用 | 通过；即使请求快照为 3，仍 0 调用、0 结果 |
| A3 模型失败与重试 | 失败后返还；去掉 `[fail]` 可成功 | 通过；首次 1→1、0 结果，重试后 1→0、1 结果 |
| A4 最后一次并发 | 10 请求，1 成功、9 次 402 | 通过；余额 0、结果 1、模型调用 1 |
| A5 多次额度并发 | 10 请求，3 成功、7 次 402 | 通过；余额 0、结果 3、模型调用 3 |
| A6 保存失败 | 失败返还、无结果 | 通过；一次性注入保存异常，余额 1、结果 0 |
| A7 返还失败 | 503、提示待核查 | 通过；一次性注入返还异常，不谎报额度已退回 |
| A8 输入与登录校验 | 401/400、0 调用、无扣减 | 通过；未登录、空待办、0/-1/25/NaN/Infinity 共 7 项 |
| A10 混合成败并发 | 2 次额度，一成一败后余额 1 | 通过；结果 1、模型调用 2，返还未覆盖成功扣减 |
| A9 页面交互 | 提示与额度刷新准确，保留旧结果 | 9 项 React/ReactDOM/jsdom 组件检查通过；完整 Wasp 应用浏览器验收尚未运行 |

前端辅助验证直接转译并挂载真实页面与 UI 组件，只替代 Wasp auth/transport。覆盖生成按钮禁用/恢复、成功后额度刷新、402/502/503/400/401、网络错误、旧结果保留、刷新失败与恢复、空任务禁用，见 [frontend-components.txt](verification/frontend-components.txt)。此辅助脚本在临时工具目录运行，未加入项目依赖；不能将组件检查视为生成 SDK 或真实登录链路通过。

以下检查在最终 Linux 容器中全部通过，串行命令退出码为 0，见 [wasp-build.txt](verification/wasp-build.txt)：

```sh
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
```

最初在原生 Windows 上因缺少生成的 SDK，类型检查未通过；之后 Docker 恢复，使用缓存 Alpine 容器、临时 Node 24.14.1 musl 工具链和 Wasp 0.25.0 完成正式生成与编译。临时容器补齐 OpenSSL 后，最终日志确认数据库迁移为最新且 SDK 构建成功。没有手写 SDK 或降低类型严格度绕过检查。

## 待办与交接

- 交接者可按 [README.md](README.md) 在 WSL2 / Linux 启动应用。A9 已做组件交互检查，尚未覆盖真实浏览器的登录、Cookie 与 HTTP 传输整条链路，可在正式提交前做一次手动走查。
- 预占额度到结果落库之间若进程崩溃，可能留下未返还的额度；题目明确不要求崩溃补偿。数据库提交结果不确定时也不自动重试或核账；若未来接入真实供应商，可用持久化请求账本补偿。
- 同账号其他请求生成期间可用额度可能临时为 0；402 提示刷新，不能据此推断永久用完。其他页面的页头可能暂时过期，提供手动刷新，服务端始终以数据库准入。
- 使用了 AI 辅助分析、实现、审查和测试；测试范围与未验证项已在上文分别列明。
- 当前准备本地分支 `fix/quota-handling` 和提交材料。按需要完成真实浏览器手动走查后，再 Fork、推送分支并根据 [PR_DRAFT.md](PR_DRAFT.md) 创建 PR。
