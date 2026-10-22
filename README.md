# 任务规划实验室

一个用于产品与开发练习的本地项目。提供账号注册、待办任务、模拟日程生成和用户额度。模型接口完全在本地运行，无需 API Key 或第三方服务账号。

## 任务

请阅读 [TASK.md](TASK.md)。额度处理的设计与验收见 [SPEC.md](SPEC.md)，提交概览见 [SUBMISSION.md](SUBMISSION.md)。

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

## 额度验证

完成 `wasp install` 和 `wasp compile` 后：

```sh
npm test
```

真实数据库验收需使用专用 PostgreSQL 数据库，库名必须以 `_test` 结尾。以下连接仅为本地测试示例：

```sh
# 如已有 PostgreSQL，建立独立的 task_planner_test 库后直接配置连接即可。
docker run --rm --name task-planner-quota-test \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=task_planner_test \
  -p 127.0.0.1:55432:5432 postgres:17

# 在另一终端运行；可重复执行，无需重置数据库。
export TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/task_planner_test?connection_limit=12'
npm run test:integration
```

脚本先应用已有迁移，再直接调用与应用相同的操作与事务函数。使用真实 PostgreSQL 和原有模拟模型；仅替换 Wasp 运行时导出，不覆盖 HTTP 认证中间件。每轮创建独立账号，只清理本轮账号及其任务、结果；不重置或清空整库。任何断言失败会以非零状态退出。输出逐项包含余额、结果数及模型调用计数。

Windows PowerShell 设置连接用 `$env:TEST_DATABASE_URL = '连接串'`。项目完整运行仍按上文使用 WSL2。测试场景和已执行结果见 [验证记录](docs/verification.md)，CI 使用同样的编译、类型和数据库验收命令。

## 开源许可

第三方代码的版权声明与使用条件见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
