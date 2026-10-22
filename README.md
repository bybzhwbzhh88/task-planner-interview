# 任务规划实验室

一个用于产品与开发练习的本地项目。提供账号注册、待办任务、模拟日程生成和用户额度。模型接口完全在本地运行，无需 API Key 或第三方服务账号。

## 任务

原题见 [TASK.md](TASK.md)。本分支已完成额度处理和审查补强：先原子预占再调用模型，成功确认、失败释放；本地验证完成，已提交 [PR #3](https://github.com/bybzhwbzhh88/task-planner-interview/pull/3)，等待仓库方评审。

- [最终SPEC](SPEC.md)：规则、方案取舍与AC01～AC24。
- [运行与重复验证](docs/QUOTA_RUN.md)、[实际验证记录](docs/VERIFICATION.md)。
- [提交说明](SUBMISSION.md)、[可复制的PR正文](docs/PR_BODY.md)。


## 快速复验

检出本PR分支后，在Linux／Ubuntu WSL中准备Node >=24.14.1、Wasp0.25.0，以及Docker或本机PostgreSQL服务端工具，然后执行：

```sh
npm run verify
```

自动安装依赖、建立隔离数据库、编译、执行两项类型检查和全部17项数据库验收，不需要个人 .env、数据库连接串或本机路径。完整真实HTTP与浏览器验证使用干净检出中的 `npm run verify:all`。

[完整CI实际通过：17项数据库／35场景HTTP／15步浏览器](https://github.com/Theodora-Y/task-planner-interview/actions/runs/39793738843)。本轮CI耗时170秒，不作为首次下载时间承诺。

[完整说明与失败定位](docs/QUOTA_RUN.md) · [自动复验Actions](https://github.com/Theodora-Y/task-planner-interview/actions/workflows/verify.yml) · [实际结果](docs/VERIFICATION.md)

## 环境

- Node.js 24.14.1 或更新的兼容版本。
- Wasp 0.25.0。
- PostgreSQL；可通过 Docker 启动本地开发数据库。
- Windows 使用 WSL2，并将项目放在 Linux 文件系统中。

安装对应版本的命令行工具：

```sh
npm install -g @wasp.sh/wasp-cli@0.25.0
```

首次在项目根目录准备本地配置并安装依赖；已有本地配置不要覆盖：

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
- 运行 `wasp db studio` 可以查看数据，将测试账号的 `User.credits` 设置为 0、1 或 3。仅在无在途生成/预占时准备测试余额，修改后刷新页面；不要在请求执行中直接改额。

## 代码入口

| 路径 | 内容 |
| --- | --- |
| `main.wasp.ts` | 应用与路由配置 |
| `schema.prisma` | 用户、任务、生成结果和额度请求状态 |
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
