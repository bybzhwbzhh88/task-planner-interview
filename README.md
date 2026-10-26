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

## 开源许可

第三方代码的版权声明与使用条件见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 额度处理改进的验收与交接

本项目按 [SPEC.md](SPEC.md) 先行设计：余额通过 `User.updateMany` 的 `credits > 0` 条件原子预占，模型或结果保存失败返还；无余额时不会调用模型。前端显示余额及成功、额度不足、失败反馈。

不启动 Wasp 即可执行独立业务逻辑与模拟接口测试：

```sh
npm run test:quota
```

真实 PostgreSQL 并发验证：`QUOTA_TEST_DATABASE_URL` 指向**已完成迁移的独立测试数据库**、本地安装 `psql` 后执行 `npm run test:quota:db`。运行结果和手工验收细节见 [docs/VALIDATION.md](docs/VALIDATION.md)。

应用编译与数据库迁移继续使用上文的 Wasp 命令；修改未引入新的表或迁移。项目交付说明见 [SUBMISSION.md](SUBMISSION.md)。

若从下载的 ZIP 而非 Git clone 开始开发，需在自己的 Fork 中按 [补丁应用说明](docs/APPLY_TO_FORK.md) 依次提交 SPEC、实现和验证记录；请勿用无上游历史的临时仓库直接创建 PR。
