# 任务规划实验室

一个用于产品与开发练习的本地项目。提供账号注册、待办任务、模拟日程生成和用户额度。模型接口完全在本地运行，无需 API Key 或第三方服务账号。

## 任务

请阅读 [TASK.md](TASK.md)。项目中的额度处理是待改进的初始版本。

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
| `src/demo-ai-app/operations.ts` | 服务端操作与 HTTP 错误映射 |
| `src/demo-ai-app/quota.ts` | 额度事务核心、`readCredits` |
| `src/demo-ai-app/mockAi.ts` | 本地模拟接口 |
| `src/auth/auth.wasp.ts` | 登录配置 |
| `tests/quota.integration.test.ts` | 真实 PostgreSQL 额度集成测试 |
| `VERIFICATION.md` | 验证记录与复现步骤 |

## 基础检查

```sh
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
```

运行检查前需要完成依赖安装。首次启动前需要执行数据库迁移。

## 额度集成测试

额度处理的核心逻辑在 `src/demo-ai-app/quota.ts`。集成测试连接真实 PostgreSQL，覆盖成功、额度不足、模型失败、并发、回滚和账号隔离，不使用内存 mock 替代数据库。

先准备一个独立的空测试库（不要指向开发库），然后：

```sh
# 1. 安装依赖并生成 Prisma Client（首次或 schema 变化后）
wasp install
wasp compile

# 2. 只对测试库执行迁移；连接串按本地 PostgreSQL 调整
export TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/task_planner_test"
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy --schema schema.prisma

# 3. 运行集成测试（A1–A11、A13）
npm run test:quota
```

`TEST_DATABASE_URL` 未设置时测试会直接失败，不会回退到 `DATABASE_URL`。测试只创建并清理自己的账号。A4/A5 是真实并发用例，建议重复执行 3 次；A12 按 `VERIFICATION.md` 手动验收。

也可以运行 `bash scripts/verify.sh`：依次编译、检查类型、迁移测试库、执行完整测试，再额外重复 A4/A5/A6 三轮。运行前按上面的步骤设置 `TEST_DATABASE_URL`，并确保测试库独立于开发库。

应用启动后，运行 `npm run test:http` 检查生成和额度查询接口的未登录状态码。默认请求 `http://localhost:3001`，可用 `TEST_SERVER_URL` 指定测试后端地址。

## 开源许可

第三方代码的版权声明与使用条件见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
