# 验证记录

## 结论与状态

实现和静态差异检查已完成；本机尚未运行 Wasp 编译、应用级验收或 PostgreSQL 并发脚本。原因是当前环境没有 Wasp CLI，Node 为 `v24.11.1`，低于仓库要求的 `>=24.14.1`，且未配置本地 PostgreSQL。以下命令可在满足 README 环境的机器上重复执行。

## 运行前准备

在 WSL2 的 Linux 文件系统中按 [README.md](README.md) 安装 Node `>=24.14.1`、Wasp `0.25.0` 和 PostgreSQL，之后：

```sh
cp .env.server.example .env.server
cp .env.client.example .env.client
wasp install
wasp start db
# 新终端
wasp db migrate-dev
wasp start
```

应用启动后注册测试账号，添加一条普通任务；需要失败案例时再添加描述含 `[fail]` 的任务。可用 `wasp db studio` 找到该账号的 `User.id` 并设置 `credits`。

## 验收记录

| 案例 | 操作/命令 | 预期 | 实际结果 |
| --- | --- | --- | --- |
| AC-1 成功扣费 | 设置 `credits=3`，提交普通任务并点击生成。 | 页面显示日程和“已消耗 1”；额度为 2；有 `started/succeeded` 同 callId。 | 未运行：本机缺 Wasp、合格 Node 和数据库。 |
| AC-2 额度不足 | 设置 `credits=0`，点击生成，观察服务端日志。 | 提示额度不足；没有新的 `mock-ai.started`；额度仍为 0。 | 未运行：同上。 |
| AC-3 模型失败 | 设置 `credits=1`，添加含 `[fail]` 的任务后生成。 | 提示额度已退回；有 `started/failed` 同 callId；额度仍为 1。 | 未运行：同上。 |
| AC-4 并发不透支 | PowerShell：`$env:DATABASE_URL='postgresql://...'; .\scripts\verify-quota-concurrency.ps1 -UserId '<User.id>'`。 | 默认 5 次并行预留中 3 次成功，最终额度 0，输出 `PASS`。 | 未运行：本机未配置 PostgreSQL/psql。 |

该并发脚本执行与应用相同的 PostgreSQL 条件更新：`credits = credits - 1 WHERE credits > 0`。它先将指定测试用户重置为 3 额度，因此只应对测试账号运行；该变更是可控且可再次运行的。

## 静态检查

| 命令 | 结果 |
| --- | --- |
| `git diff --check` | 已通过。 |
| `wasp compile` | 未运行：未安装 Wasp CLI。 |
| `npm ci --ignore-scripts` | 已完成；因 Node `v24.11.1` 低于要求，npm 给出 engine warning。 |
| `node_modules/.bin/tsc --project tsconfig.src.json --noEmit` | 已尝试，未通过：缺少 `wasp/*` 模块（需 `wasp install` 生成 SDK）；未发现独立于该前置条件的错误。 |
| `node_modules/.bin/tsc --project tsconfig.wasp.json --noEmit` | 已尝试，未通过：同样缺少 Wasp SDK/`@wasp.sh/spec`。 |
| PowerShell AST 解析 `scripts/verify-quota-concurrency.ps1` | 已通过。 |

## 交接

- 额度预留成功后若进程崩溃，可能留下预留额度；自动补偿不在题目范围内。要覆盖此情形，后续应新增持久化的请求/扣费状态和恢复任务。
- `SUBMISSION.md` 的姓名与打码手机号保留占位符，提交公开 PR 前由候选人填写；不要写入完整手机号。
