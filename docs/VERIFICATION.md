# 验证与复现

验证分为流程单元测试、真实 PostgreSQL 测试、运行中应用的 HTTP 测试和页面检查。验收标准见 [SPEC.md](../SPEC.md)，实际完成情况将在本文件末尾逐项记录；脚本报错或断言失败返回非零退出码。

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

使用 `wasp db studio` 设置自己测试账号的额度后刷新页面。不要修改其他账号。

1. 设置 3 个额度，添加普通任务并生成：观察生成中禁用、成功提示、余额减一和本次日程。
2. 添加含 `[fail]` 的任务，再生成：提示明确失败且未扣费，余额不变，已有日程标识为“上次生成结果”。删除失败任务后重试应成功。
3. 设置 0 个额度：生成按钮禁用，页面解释原因；刷新额度不能凭空增加额度；“查看最近保存的日程”仍可使用且不扣费。
4. 同账号开两个标签页并设为 1 个额度：A 生成后，B 切回 / 刷新显示 0；即使 B 状态过期，服务端仍拒绝超额请求（自动化 HTTP 并发也覆盖服务端边界）。

## 5. 本次实际记录

2026-10-22，已执行单元测试 10 项及真实 PostgreSQL 测试 7 项，全部通过。HTTP、页面及最终编译检查待本轮实现收尾后记录；此处不把未执行检查标记为通过。
