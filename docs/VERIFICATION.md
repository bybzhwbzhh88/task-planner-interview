# 验证与复现

已完成流程单元测试、真实 PostgreSQL 测试、运行中应用的 HTTP 测试和页面检查。验收标准见 [SPEC.md](../SPEC.md)，本文件末尾记录实际结果；脚本报错或断言失败返回非零退出码。

## 1. 准备

按 [README.md](../README.md) 安装 Node 24.14.1+、Wasp 0.25.0，配置本地数据库并完成依赖安装、`wasp compile`、`wasp db migrate-dev`。以下命令都在 Linux 项目根目录运行；Windows 使用 WSL2 的 Linux 文件系统。

数据库测试使用**另建的空测试库**，名称必须以 `_test` 结尾。使用有建库权限的 PostgreSQL 用户创建，例如：

```sh
createdb -h localhost -U YOUR_USER task_planner_test
export QUOTA_TEST_DATABASE_URL='postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/task_planner_test'
DATABASE_URL="$QUOTA_TEST_DATABASE_URL" npx prisma migrate deploy --schema .wasp/out/db/schema.prisma
```

不要把真实凭据写入提交文件。测试仅删除本轮新建账号及其结果，不使用全表清空或数据库重置。

## 2. 单元与数据库测试

```sh
npm run test:quota
npm run test:quota:integration
```

- 单元测试使用生产编排函数，覆盖零额度、成功、模型失败恢复、无效模型结果、明确保存失败、保存 / 归还确认丢失，以及预占结果不确定。
- 数据库测试使用生产 `createQuotaStore`、真实 PostgreSQL 和本地模拟模型；1、3 个额度各做 10 轮，每轮同时发 10 个请求。屏障保证模型完成前，十次准入都已竞争完成。
- 每轮断言成功数、402 数、实际 `mock-ai.started` 数、数据库余额与结果数；采样余额不得为负。
- 故障注入包含真实外键拒绝、INSERT 已提交但确认丢失、退款已提交但确认丢失。注入只存在于测试依赖，不给运行中的应用添加测试后门。

## 3. 真实 HTTP 并发验证

终端一运行应用并保留日志：

```sh
wasp start 2>&1 | tee /tmp/task-planner.log
```

终端二设置与**运行中应用相同**的本地数据库连接（可以是本地开发库），明确启用测试并执行：

```sh
export DATABASE_URL='postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/task_planner_dev'
export QUOTA_ALLOW_HTTP_TESTS=1
npm run test:quota:http -- --log-file /tmp/task-planner.log
```

脚本通过真实注册、登录、创建任务和生成接口验证 AC01～AC07；1、3 个额度各重复 10 轮并发。可用 `--rounds 1` 调试，正式记录采用默认 10 轮。

模型次数从运行日志中的 `mock-ai.started` 统计，因此运行期间不要在其他页面或进程发起生成；不要重启服务或截断日志。响应状态、错误 code、余额、保存数量均由断言核对。结果写入被 Git 忽略的 `test-results/quota-http.json`，不保存密码或会话令牌。脚本仅支持 localhost / loopback，完成或失败后按本轮账号 ID 清理数据。

## 4. 页面检查

新增可重复的无头 Chromium 验证，使用真实应用、登录、模拟模型与 PostgreSQL。Playwright 单独安装到工具目录，不修改项目依赖或锁文件。先按第 3 节运行应用并设置同一个 `DATABASE_URL` 与 `QUOTA_ALLOW_HTTP_TESTS=1`，再执行：

```sh
export QUOTA_BROWSER_TOOLS="$HOME/.cache/task-planner-browser-tools"
npm install --prefix "$QUOTA_BROWSER_TOOLS" --no-audit --no-fund playwright@1.62.1
"$QUOTA_BROWSER_TOOLS/node_modules/.bin/playwright" install --with-deps chromium
export QUOTA_PLAYWRIGHT_MODULE="file://$QUOTA_BROWSER_TOOLS/node_modules/playwright/index.mjs"
npm run test:quota:browser -- --log-file /tmp/task-planner.log
```

Linux 浏览器依赖安装可能需要 sudo。脚本在 `/` 和 `/demo-app` 各执行 8 个场景：成功、持续认证 503 与恢复、明确模型失败保留旧结果、零额度读取保存结果、缓存身份遇到 401 / 403、首次认证 503 与恢复、未登录页面和接口保护。401 会清除 Wasp 会话，测试实际重新登录；同时检查不会因旧缓存从登录页跳回任务页。

503 / 401 / 403 仅由 Playwright 拦截浏览器 `/auth/me` 响应注入；生成与保存使用真实服务。脚本断言页面状态、生成请求数、服务器模型日志次数、数据库余额与保存数量，并只清理自己创建的账号。运行期间不要在其他客户端生成日程或重启服务。报告及截图位于被忽略的 `test-results/`，断言失败返回非零退出码。

以下人工步骤保留，用于快速演示和检查多标签页行为：

使用 `wasp db studio` 设置自己测试账号的额度后刷新页面。不要修改其他账号。

1. 设置 3 个额度，添加普通任务并生成：观察生成中禁用、成功提示、余额减一和本次日程。
2. 添加含 `[fail]` 的任务，再生成：提示明确失败且未扣费，余额不变，已有日程标识为“上次生成结果”。删除失败任务后重试应成功。
3. 设置 0 个额度：生成按钮禁用，页面解释原因；刷新额度不能凭空增加额度；“查看最近保存的日程”仍可使用且不扣费。
4. 同账号开两个标签页并设为 1 个额度：A 生成后，B 切回 / 刷新显示 0；即使 B 状态过期，服务端仍拒绝超额请求（自动化 HTTP 并发也覆盖服务端边界）。

## 5. 本次实际记录

环境：2026-10-22，Ubuntu 24.04 / WSL2，Node 24.14.1，Wasp 0.25.0，Prisma 5.19.1，PostgreSQL 16.15。下述命令和页面检查均已实际执行。

| 命令 | 实际结果 |
| --- | --- |
| `npm run test:quota` | 10 项通过 |
| `npm run test:quota:integration` | 7 项通过，包含 1 / 3 个额度各 10 轮、每轮 10 个并发请求 |
| `npm run test:quota:http -- --log-file <运行日志>` | 25 个场景通过；其中 20 轮并发共 200 个请求 |
| `npm run test:quota:browser -- --log-file <运行日志>` | 16 个场景通过，两个页面入口各 8 个；Playwright 1.62.1 / Chromium 151 |
| `wasp compile` | 退出码 0 |
| `npx tsc --project tsconfig.src.json --noEmit` | 退出码 0 |
| `npx tsc --project tsconfig.wasp.json --noEmit` | 退出码 0 |

| 验收项 | 实际操作与结果 | 证据 |
| --- | --- | --- |
| AC01 | 初始 3，生成 1 次：200、模型 1、结果 +1、余额 2 | [HTTP 原始记录](quota-http-results.json) |
| AC02 | 初始 0，绕过按钮直接请求：402、模型 0、结果 0、余额 0 | HTTP 记录 AC02 |
| AC03 | 初始 1，含 `[fail]`：502 / MODEL_FAILED、模型 1、结果 0、余额 1 | HTTP 记录 AC03；[页面另以 3 个额度复验](screenshots/model-failure.jpg) |
| AC04 | 初始 1，10 个并发：每轮成功 1、402 共 9、模型 1、结果 +1、余额 0 | HTTP 与数据库测试各 10 轮 |
| AC05 | 初始 3，10 个并发：每轮成功 3、402 共 7、模型 3、结果 +3、余额 0 | HTTP 与数据库测试各 10 轮 |
| AC06 | 删除 `[fail]` 后再生成：200、模型 1、结果 +1、余额 0 | HTTP 记录 AC06 |
| AC07 | 无登录 401；无任务、0、25、字符串和 null 时长均 400；模型 0、余额不变 | HTTP 记录 AC07 |
| AC08 | B 页显示旧余额 1，A 生成后 B 仍尝试生成：收到不足提示，更新为 0 并禁用按钮 | [B 页截图](screenshots/no-credit.jpg)；服务端 quota.rejected / 402 日志 |
| AC09 | 生成中禁用；成功 / 失败 / 不足提示准确；失败后旧结果标为“上次生成结果”；零额度仍可读取已保存结果 | [成功截图](screenshots/success.jpg)、失败 / 不足截图；实际页面操作 |
| AC10 | 注入真实数据库外键拒绝：SAVE_FAILED、余额恢复、结果 0 | 数据库测试 + 单元测试 |
| AC11 | 注入退款未确认（含已提交的情况）：RESULT_UNCERTAIN，只尝试归还一次 | 数据库测试 + 单元测试 |
| AC12 | 注入保存确认丢失：不退款、不自动重试；已提交时保持一条结果及正确扣费，日志结果 ID 可关联 | 数据库测试 + 单元测试 |
| AC13 | 两个入口均在成功生成后持续注入认证 503；日程与成功提示保留、额度未知、生成禁用；恢复后仍为生成 1 / 模型 1 / 保存 1 / 余额 2 | [浏览器结果](quota-browser-results.json)、[故障状态截图](screenshots/auth-refresh-failure.png) |
| AC14 | 两个入口均验证 401 / 403 遮住私有内容，401 后实际重新登录；首次认证 503 可重试；未登录页跳转登录且服务端生成返回 401 | 浏览器结果中的身份失效、首次认证及未登录场景 |

修复前先在旧实现 `e000c47` 运行新增回归，确认 AC13 失败：余额 2、保存 1、模型 1，但日程和成功提示均不可见。已保留[失败基线](quota-browser-baseline.json)和[修复前截图](screenshots/auth-refresh-before.png)。修复使用源代码中的共享认证守卫，两个入口均适用；未修改 `.wasp/` 生成文件或服务端身份校验。R3 spec 提交 `b957d39` 先于实现 `bc942ac`，完整浏览器通过记录对应代码 `3f6341c`。

浏览器故障是测试中的认证响应拦截，未实际关闭认证服务或断开网络。它验证页面在指定响应下的行为，不能替代数据库提交不确定性的测试。

边界：AC10～AC12 通过测试依赖注入验证，未实际切断 PostgreSQL 网络或杀死服务进程；未做多服务部署、真实模型 API 或生产负载测试。当前本地模拟接口的异常是明确失败；接入真实外部模型时，不能直接把超时当作明确失败。数据库不可用、提交结果不确定和进程崩溃后的自动补偿不在本次实现内。
