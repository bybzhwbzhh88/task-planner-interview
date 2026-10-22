# 任务规划实验室

一个用于产品与开发练习的本地项目。提供账号注册、待办任务、模拟日程生成和用户额度。模型接口完全在本地运行，无需 API Key 或第三方服务账号。

## 任务

题目要求见 [TASK.md](TASK.md)。本分支已完成额度处理改进，方案与验证结果见 [SPEC.md](SPEC.md) 和 [SUBMISSION.md](SUBMISSION.md)。

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

## 额度验收

先执行 `wasp compile` 生成 SDK，再使用独立 PostgreSQL 测试库。测试入口只接受名称以 `_test` 结尾的数据库，不会读取 `.env.server` 中的开发库地址。

首次使用时，在 PostgreSQL 管理员的 psql 会话中创建本地测试账号与数据库，并通过 `\password` 交互设置密码：

```text
CREATE ROLE quota_test_user LOGIN;
\password quota_test_user
CREATE DATABASE task_planner_quota_test OWNER quota_test_user;
```

在项目根目录设置测试连接串，将 `<password>` 替换为刚设置的密码；密码中的特殊字符需进行 URL 编码：

```sh
export TEST_DATABASE_URL='postgresql://quota_test_user:<password>@127.0.0.1:5432/task_planner_quota_test'
npm run test:quota
```

脚本先应用现有迁移，再运行真实数据库集成测试。测试只清理自己创建的用户及关联数据，可以重复执行，无需启动网页服务。每个案例打印模拟接口的 started/succeeded/failed 数量，以及用户最终余额、保存结果数。

仅运行并发案例：

```sh
npm run test:quota -- --testNamePattern='AC04|AC05'
```

测试覆盖成功、零额度、明确失败、同账号并发、失败后重试、存储失败回滚、账号隔离和未登录请求。前置条件与预期见 [SPEC.md](SPEC.md)，实际结果及页面截图见 [SUBMISSION.md](SUBMISSION.md)。

## 开源许可

第三方代码的版权声明与使用条件见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
