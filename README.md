# 任务规划实验室

一个用于产品与开发练习的本地项目。提供账号注册、待办任务、模拟日程生成和用户额度。模型接口完全在本地运行，无需 API Key 或第三方服务账号。

## 任务

需求见 [TASK.md](TASK.md)。本分支已实现数据库原子额度预占、明确失败返还和页面反馈；设计与边界见 [SPEC.md](SPEC.md)，实际结果见 [验证记录](docs/verification.md)。

## 环境

- Node.js 24.14.1 或更新的兼容版本。
- Wasp 0.25.0。
- PostgreSQL；可通过 Docker 启动本地开发数据库。
- Windows 使用 WSL2，并将项目放在 Linux 文件系统中。

安装对应版本的命令行工具：

```sh
npm install -g @wasp.sh/wasp-cli@0.25.0
```

在项目根目录准备本地配置，并安装依赖：

```sh
cp .env.server.example .env.server
cp .env.client.example .env.client
wasp install
```

终端一启动开发数据库，保持运行：

```sh
wasp start db
```

终端二初始化数据库，再启动应用：

```sh
wasp db migrate-dev
wasp start
```

打开终端打印的页面地址，默认是 `http://localhost:3000`。注册用户名和密码后即可使用，每个新账号初始额度为 3。

如果已有本地 PostgreSQL，可在 `.env.server` 中配置 `DATABASE_URL`，使用独立的空数据库，再执行迁移与启动。

## 模拟接口

- 普通任务约 500 毫秒后返回模拟日程。
- 添加一条包含 `[fail]` 的任务，可以让模拟接口明确返回失败；删除该任务后恢复成功场景。
- 服务端记录 `mock-ai.started`、`mock-ai.succeeded` 和 `mock-ai.failed` 日志；同一次调用使用相同的 `callId`。
- 运行 `wasp db studio` 可以查看数据，将测试账号的 `User.credits` 设置为 0、1 或 3。手动修改数据后刷新页面。

## 代码入口

| 路径 | 内容 |
| --- | --- |
| `main.wasp.ts` | 应用与路由配置 |
| `schema.prisma` | 用户、任务和生成结果 |
| `src/demo-ai-app/DemoAppPage.tsx` | 任务输入和日程展示 |
| `src/demo-ai-app/operations.ts` | 服务端操作 |
| `src/demo-ai-app/mockAi.ts` | 本地模拟接口 |
| `src/auth/auth.wasp.ts` | 登录配置 |

## 基础检查

```sh
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
```

运行检查前需要完成依赖安装。首次启动前需要执行数据库迁移。

## 额度测试

先运行 `wasp compile`，生成 Prisma client 和操作类型。单元测试为 `npm run test:unit`，不需要数据库。真实数据库测试必须显式使用独立的本地测试库。脚本同时比较环境变量和项目根 `.env.server` 中的 `DATABASE_URL`，拒绝误用任一应用地址及非测试库名；只读取应用配置做隔离校验，不把它作为测试目标或导出其他变量。

```sh
docker run --rm -d --name task-planner-quota-test \
  -e POSTGRES_USER=quota -e POSTGRES_PASSWORD=quota_local_only \
  -e POSTGRES_DB=generation_quota_test -p 127.0.0.1:55439:5432 postgres:16
export QUOTA_TEST_DATABASE_URL='postgresql://quota:quota_local_only@127.0.0.1:55439/generation_quota_test'
# 等待容器就绪：docker exec task-planner-quota-test pg_isready -U quota
npm run test:db:prepare
npm run test:integration
npm run test:concurrency
npm test
# 完成后只清理本测试容器：docker rm -f -v task-planner-quota-test
```

并发脚本让 10 个独立连接同时进入实际生成流程，覆盖初始额度1、初始额度3（重复三轮）、在途失败返还及主动重试，输出成功数、拒绝数、模型调用数、结果数和余额。测试按本轮账号清理数据，不重置数据库。浏览器脚本和逐项命令见 [验证记录](docs/verification.md)。

生成期间额度被预占；只有结果确认保存才消费。模型或保存明确失败会返还，数据库写入结果未知时会提供请求编号并要求先刷新核对，详见 SPEC 的异常流程。不提供支付或自动补偿。

## 开源许可

第三方代码的版权声明与使用条件见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
