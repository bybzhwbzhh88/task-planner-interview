# 自助运行与复验

先检出 PR 的 `chore/original-baseline` 分支。复验无需作者的配置文件、数据库密码、外部脚本或浏览器安装路径。

## 1. 快速复验

前提：Linux／Ubuntu WSL 的 Linux 文件系统，Node >=24.14.1，Wasp 0.25.0，以及可用 Docker 引擎或本机 PostgreSQL 服务端工具。首次安装 Wasp 后，在仓库根目录运行：

```sh
npm install -g @wasp.sh/wasp-cli@0.25.0
npm run verify
```

脚本自动安装项目依赖，创建独立 PostgreSQL、编译 Wasp、执行两项 TypeScript 检查、应用现有迁移、运行原有17项数据库验收，最后停止本轮数据库。不会读取开发库连接，也不会覆盖本地 .env 文件。已装本机 PostgreSQL 时使用临时集群；否则使用官方 postgres:16 容器。Docker模式使用容器内的SQL客户端。

本轮数据库使用随机端口，库名以 _quota_test 结尾。测试只清理自身fixture；自动创建的容器/集群在结束或失败时清理。下载依赖、镜像耗时取决于网络；不要把已有缓存时的运行时间当作首次安装时间。

成功显示 `[verify] PASS` 并退出0；任一步失败非零退出。统一报告为 `test-results/quota/verify-summary.json`，各步骤日志及数据库报告在同目录。故障注入会产生预期错误日志，应以断言与退出码判断。

## 2. 包含真实HTTP与浏览器的完整复验

在**没有业务DATABASE_URL配置的干净检出**中执行：

```sh
npm run verify:all
```

它包含第1节全部检查，再自动启动连接同一隔离测试库的应用，依次执行真实HTTP35场景与浏览器15步，结束后停止本轮应用和数据库。要求3000/3001空闲，端口被占用时直接停止复验，不杀掉已有应用。检测到 .env.server 中已有业务DATABASE_URL也会拒绝启动，避免改动或误连开发环境。

Playwright已固定为项目开发依赖。脚本自动下载Chromium；本地精简Linux若缺少浏览器系统库，按Playwright提示执行一次：

```sh
npx playwright install --with-deps chromium
```

GitHub CI自动安装这些系统库，不需要个人配置或仓库Secret。首次执行需要联网。浏览器验证保留原有断言；只把作者本机Edge/外挂模块路径改为可选覆盖。

## 3. 自动复验与报告

[GitHub Actions工作流](../.github/workflows/verify.yml)在push、PR和手动触发时运行 `npm run verify:all`，使用Node24.14.1、Wasp0.25.0、自动隔离Docker PostgreSQL和Chromium。运行记录见[Actions](https://github.com/Theodora-Y/task-planner-interview/actions/workflows/verify.yml)。

CI归档统一摘要、数据库/HTTP/浏览器报告、截图及检查日志；不归档数据库配置、数据目录或应用服务日志。当前实际通过状态、对应提交和耗时统一见[验证记录](VERIFICATION.md)，不把“已写工作流”当成“CI已通过”。

| 入口 | 用途 |
| --- | --- |
| `npm run verify` | 安装、编译、类型检查、迁移、17项真实数据库验收 |
| `npm test` | 相同隔离准备与17项数据库验收，省略类型检查 |
| `npm run verify:all` | 全部基础检查＋35项真实HTTP＋15步Chromium浏览器 |
| `npm run check:types` | 已生成SDK后的两项TypeScript检查 |

完整复验输出：`test-results/quota/vitest.json`、`service-observations.json`、`http.json`、`browser/report.json`。HTTP与浏览器顺序执行，正式场景统计排除准备数据调用，核对响应、余额/预占、结果增量和模型callId。

## 4. 日常运行应用

日常开发按[README](../README.md)配置自己的PostgreSQL和本地环境；与一次性复验数据库分开管理：

```sh
wasp db migrate-dev
npm run start:logged
```

默认前端 http://localhost:3000、API http://localhost:3001。Ctrl+C停止应用，再次执行start:logged启动；数据库按自己的启动方式管理。生成日志固定写入仓库内 `test-results/quota/server.log`，不依赖作者目录。

对**已经运行的本地应用**单独验证时：

```sh
npm run verify:http
npm run verify:browser
```

HTTP核对使用 .env.server 中与API相同的数据库；这两个入口不会代替你启动应用。浏览器默认读取相同server.log，Linux使用仓库Chromium；SERVER_LOG、FRONTEND_URL、API_URL、BROWSER_CHANNEL只用于非默认环境。建议接手者优先使用第2节自动隔离方式。

## 5. 范围与数据保护

原有[额度规则与AC01～AC24](../SPEC.md)、[实际验证](VERIFICATION.md)不变；模拟模型延迟、失败触发及日志未变。新增迁移保留历史数据，负余额时拒绝迁移。原有[prepare-test-db](../scripts/prepare-test-db.mjs)仍可用于手工维护专用测试库，不是快速复验的前置步骤。

进程崩溃、数据库持续不可用可能遗留预占；自动崩溃补偿不在范围内。未知结果不要自动重试或直接加余额，人工核查前须确认没有在途请求。历史机器环境与原始启动记录保留于[BASELINE_RUN](BASELINE_RUN.md)，接手者不需要运行其中的本机便捷脚本。
