# 原始项目运行与环境验收记录

2026-10-21（上海时区）：**原项目已运行，真实浏览器流程、数据库初始化、停止与重启及三项基础检查均通过。** 本轮没有修改应用业务源码、数据模型、迁移或原始锁文件；额度缺陷保持原样。环境阶段结束时 `SPEC.md` 尚为未提交草稿。本文记录环境阶段的原始基线；随后独立保留了设计提交，并完成额度功能。当前实现与验收见 [VERIFICATION](VERIFICATION.md)，不改写本记录的原始观察。

## 1. 唯一正式目录与 Git（环境阶段结束时）

- Linux 正式源码：`/home/ying/实习小作业/task-planner-interview`。
- Windows 访问：`\\wsl.localhost\Ubuntu\home\ying\实习小作业\task-planner-interview`。
- D 盘入口：`D:\YYY\找实习\实习小作业\正式项目（Ubuntu）.lnk`。
- 迁移时逐文件核对了 53 个文件的 SHA256，随后移除旧解压源码；先前用于只读审阅的临时克隆也已确认干净后清理。D 盘保留原 ZIP 作为下载归档，不作为开发副本。
- Git 分支：`chore/original-baseline`；基线提交：`114aeb28f6368e96c08a25627ac094b8d102fd1b`。
- 已恢复上游历史，远端 `upstream` 指向原题目仓库；尚未连接个人 Fork、创建 PR 或新增提交。
- `git diff --exit-code` 返回 0；未跟踪项只有 SPEC 草稿及文档。

## 2. 实际工具与服务

| 项目 | 实际值 |
| --- | --- |
| 平台 | Ubuntu / WSL2，源码位于 Linux 文件系统 |
| Node / npm | 24.14.1 / 11.11.0；Node 官方归档 SHA256 校验通过 |
| Wasp CLI | 0.25.0 |
| PostgreSQL | 16.15（Ubuntu 包） |
| Prisma Client / TypeScript | 5.19.1 / 6.0.3 |
| Docker 引擎 | 28.5.1，可从 Ubuntu 访问 |
| 浏览器验收 | Windows Microsoft Edge 155.0.4283.62，Playwright 1.64.1 |
| 前端 | `http://localhost:3000` |
| API | `http://localhost:3001`；`/auth/me` 可作连接检查 |
| 数据库 | `127.0.0.1:55432`，独立数据库 `task_planner` |

Node/npm 实际路径都在 `/home/ying/实习小作业/.tools/node-v24.14.1-linux-x64/bin`；Wasp 在 `.tools/npm/bin`。新 Ubuntu 终端执行 `source /home/ying/实习小作业/env.sh` 加载工具，不使用 Windows npm。

数据库数据位于 `/home/ying/实习小作业/.environment/pgdata`，日志、PID 与本地数据库密码也在 `.environment` 下。`.env.server` 已配置连接，受 Git 忽略且权限为 600。软件安装自动创建的默认 `16/main` 集群已停止，本项目使用 55432 上自己的实例。

## 3. 启动、停止、再次启动

以下命令可直接在 **Windows PowerShell** 执行，脚本均已实际验证：

```powershell
# 启动数据库和应用，等待前后端就绪；也用于再次启动。
wsl -d Ubuntu -- bash /home/ying/实习小作业/start.sh

# 查看前端、API 与数据库状态。
wsl -d Ubuntu -- bash /home/ying/实习小作业/status.sh

# 停止本项目应用进程组与数据库，保留数据。
wsl -d Ubuntu -- bash /home/ying/实习小作业/stop.sh
```

脚本自动加载 Linux 工具路径；应用后台运行并写入 `.environment/logs/app.log`。日常启动无需重复迁移或安装依赖，也不要额外开第二个 `wasp start`。

需要前台开发时，先停止脚本管理的服务，然后在 Ubuntu 执行：

```sh
source /home/ying/实习小作业/env.sh
/usr/lib/postgresql/16/bin/pg_ctl -D /home/ying/实习小作业/.environment/pgdata -l /home/ying/实习小作业/.environment/logs/postgres.log -w start
cd /home/ying/实习小作业/task-planner-interview
BROWSER=none wasp start
```

前台应用用 Ctrl+C 停止；`stop.sh` 管理的是由 `start.sh` 启动的后台应用，不能代替另一个终端内手工启动应用的 Ctrl+C。数据库可用 `pg_ctl -D ... -m fast -w stop` 停止。

本次停止时前端/API 均变为不可达，项目 PostgreSQL 停止；再次启动后均恢复正常，原账号和数据仍在。交接时应用保持运行。

## 4. 已执行检查及真实结果

| 检查 | 实际结果 |
| --- | --- |
| Linux Node/npm 路径 | 均来自 Linux `.tools` |
| 依赖安装 | `wasp install` 成功；首次生成自动更新部分间接依赖，随后恢复原锁文件并 `npm ci` 成功 |
| 初始化迁移 | `wasp db migrate-dev` 成功应用已有 `20261015081629_init`；无新增迁移 |
| 浏览器访问 | Windows Edge 访问 `/signup`，HTTP 200，表单正常 |
| 注册 | 成功进入 `/demo-app`，初始额度 3 |
| 退出后重新登录 | 真实表单登录成功 |
| 添加任务 | 成功，刷新/重启后仍保留 |
| 正常生成 | HTTP 200，展示三个步骤，余额 3 → 2，数据库新增结果 1 |
| `[fail]` 模型失败 | HTTP 500，响应为 HTML；显示通用英文错误，余额保持 2，未新增结果 |
| 失败后恢复 | 删除失败任务后成功生成，余额 2 → 1 |
| 停止与再次启动 | 服务完全停止后成功重启；账号、任务、额度持久化 |
| `wasp compile` | 退出码 0 |
| `npx tsc --project tsconfig.src.json --noEmit` | 退出码 0，无诊断输出 |
| `npx tsc --project tsconfig.wasp.json --noEmit` | 退出码 0，无诊断输出 |
| Git 一致性 | `git diff --exit-code` 返回 0，包括原始锁文件 |

三项检查在开发服务停止期间单独执行，数据库保持运行。浏览器脚本最初假定错误响应为 JSON；发现实际为 HTML 后修正验收工具，再完整运行通过，未因此修改应用。

测试主账号最终额度 0、任务 1 条、成功结果 3 条；另一个初次探测账号保留额度 2、结果 1 条。均为本轮本地测试数据。体验时可自行注册新账号；并发功能尚未验收。

本机证据位于被 Git 忽略的 `test-results/baseline/`，不代表已随 PR 提交：

- [浏览器报告](../test-results/baseline/baseline-browser-report.json)、[重启报告](../test-results/baseline/restart-browser-report.json)。
- [成功截图](../test-results/baseline/generation-success.png)、[失败截图](../test-results/baseline/generation-failure.png)、[重启后恢复截图](../test-results/baseline/restart-and-recovery.png)。
- [检查退出码](../test-results/baseline/check-results.txt)、[编译日志](../test-results/baseline/compile.log)、[源码类型检查](../test-results/baseline/typescript-src.log)、[Wasp 类型检查](../test-results/baseline/typescript-wasp.log)。
- [首次服务日志](../test-results/baseline/app-first-start.log)、[重启服务日志](../test-results/baseline/app.log)、[数据库最终状态](../test-results/baseline/database-final.txt)。

Windows 浏览器验收工具在 D 盘工作区 `.environment/browser/`，未加入应用依赖。重新完整验证先运行 `verify-baseline.cjs` 创建新的账号，再运行重启恢复和零额度脚本；后两项依赖前一步保存的测试账号及余额状态。

## 5. 原始缺陷与 SPEC 修订依据

已实际复现：**余额 0 时按钮仍可点击，服务端新增 1 次模型调用后才返回 402**，余额不变、没有新增结果。见[缺陷报告](../test-results/baseline/zero-credit-baseline-report.json)和[截图](../test-results/baseline/zero-credit-baseline-defect.png)。本轮未修复。

其他观察：模型失败时通用英文错误不能说明未扣费；上一份日程继续标为“本次日程”；成功后现有 `useAuth()` 页头会自动刷新；页面刷新后日程消失但数据库结果保留。并发透支属于待验证的源码风险，本轮未运行并发验收。

环境阶段提出的修订依据如下，现已反映在 [定稿 SPEC](../SPEC.md) 中；其中运行未覆盖的检查仍待功能阶段验证：

1. 环境和基线已经完成；本机实际采用 PostgreSQL 16.15 / 55432，不依赖 Docker 镜像下载。更新正式目录、状态和验证前提。
2. 重新评估是否必须新增 `getCredits`。先核对 Wasp 0.25 现有认证查询失效机制，补足失败和多标签页验证，避免重复实现已有刷新能力。
3. 区分原始 500/HTML 与未来业务错误契约；未来的 502 是拟实施行为，不能写成当前行为，也不能假定所有错误均为 JSON。
4. 已观察到一个 Node 业务服务进程，旁边还有 Wasp、Vite、nodemon 开发进程；队列前提应准确写成“单个业务服务进程”。
5. 已观察到 `/auth/username/signup`、`/auth/username/login`、`/operations/create-task`、`/operations/generate-plan`；未来脚本仍需按实际 Wasp 认证及序列化协议实现。
6. 并发、失败释放、事务回滚、跨账号隔离、多标签页一致性仍是下一轮功能验收工作，本轮环境验证不能替代。

## 6. 已处理问题与剩余事项

- Docker Hub 超时，Google 镜像缓存连接超时，Amazon ECR Public 限流；采用仓库支持的自备 PostgreSQL 后，运行阻塞解除。Docker 引擎正常，镜像网络问题未修复。
- Ubuntu 原有 Docker APT 镜像源索引不一致；官方 Ubuntu 源更新成功，PostgreSQL 从官方源安装。未修改全局镜像或代理配置。
- npm 报告上游弃用项与审计提示；按原锁文件安装，没有自动升级或执行 `audit fix --force`，当前运行不受阻。
- **没有阻止原项目运行或要求检查通过的未解决事项。** 环境阶段后已定稿 SPEC 并单独保留设计版本；个人 Fork、应聘身份信息与 PR 尚未处理。
