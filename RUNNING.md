# 运行与验证

项目用于局域网实践演示，采用开发模式；未配置公网 TLS、生产反向代理。应用：Node.js 24.14.1、Wasp 0.25.0；数据库：PostgreSQL 16。不要升级 Wasp 或编辑 `.wasp/` 生成文件。

## 普通 Linux 环境

按 README 安装 Wasp、准备 `.env.server` 和 `.env.client`。配置独立数据库的 `DATABASE_URL`，然后运行：

```bash
wasp install
wasp compile
wasp db migrate-dev
wasp start
```

首次迁移会创建认证及业务表；不要对已有业务库执行 reset。

## Docker 演示环境

仓库放在 Linux 文件系统。`Dockerfile.dev` 提供固定版本运行时。以下名称为本次约定；数据库不映射宿主机端口。

```bash
docker network create task-planner-net
docker volume create task-planner-pgdata
docker build -f Dockerfile.dev -t task-planner-dev:0.25.0 .
```

本地创建 `.env.postgres`（权限 600），填写 `POSTGRES_USER`、随机生成的 `POSTGRES_PASSWORD` 和 `POSTGRES_DB`。在 `.env.server` 中填写对应 `DATABASE_URL=postgresql://用户名:密码@task-planner-db:5432/数据库`，以及随机 `JWT_SECRET`。密码需要 URL 编码，使用随机十六进制字符串可避免特殊字符问题。

```bash
docker run -d --name task-planner-db --restart unless-stopped \
  --network task-planner-net --env-file "$PWD/.env.postgres" \
  -v task-planner-pgdata:/var/lib/postgresql/data postgres:16-bookworm

docker run --rm --network task-planner-net -v "$PWD:/workspace" \
  task-planner-dev:0.25.0 bash -lc 'wasp install && wasp compile'

docker run -d --name task-planner-app --restart unless-stopped \
  --network task-planner-net -p 3000:3000 -p 3001:3001 \
  -v "$PWD:/workspace" task-planner-dev:0.25.0
```

启动脚本使用 Wasp 生成的 `db-migrate-prod` 脚本应用已有迁移，再启动应用。局域网地址需要在 `.env.client` 配置 `REACT_APP_API_URL=http://服务器地址:3001`，在 `.env.server` 配置 `WASP_WEB_CLIENT_URL=http://服务器地址:3000`、`WASP_SERVER_URL=http://服务器地址:3001`。地址不能留为浏览器所在电脑的 localhost。

## 重复验证

基础检查：

```bash
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
```

创建独立测试数据库，名称必须以 `_test` 结尾。把连接串保存到 `.env.quota-test`，键为 `QUOTA_TEST_DATABASE_URL`。然后在安装了依赖的项目目录执行：

```bash
node --env-file=.env.quota-test scripts/test-quota.mjs
```

脚本应用 Wasp 生成目录下的迁移，运行真实数据库集成测试。A4/A5 各进行 20 轮、每轮 10 个并发请求；同时核对成功数、模型调用日志数、余额及结果条数。脚本仅清理本次生成的 UUID 用户和关联数据。

应用启动后，执行真实 HTTP 测试：

```bash
RUN_HTTP_SMOKE=1 node --env-file=.env.server scripts/http-smoke.mjs
```

HTTP 脚本在 `127.0.0.1:3001` 创建临时随机账号，验证注册登录、参数检查、成功、无额度、失败重试、并发和结果隔离，最后仅清理自身账号。Docker 环境需通过 `docker exec task-planner-app` 在容器内运行。该脚本连接的数据库必须与运行中的应用相同。

验证重启数据保留（准备数据、重启、断言并清理）：

```bash
docker exec task-planner-app node --env-file=.env.server scripts/persistence-smoke.mjs prepare
docker restart task-planner-app
docker exec task-planner-app node --env-file=.env.server scripts/persistence-smoke.mjs check
```

首次启动或重启可能需等待编译完成；查看日志中前后端启动成功后再打开页面。

## 日常管理与恢复

```bash
docker logs --tail 100 task-planner-app
docker logs --tail 100 task-planner-db
docker restart task-planner-app
docker stop task-planner-app
```

数据库由 `task-planner-pgdata` 卷保存，重启应用不会清空数据。升级前备份数据库并保留上一版源码；回退源码后重启应用。本次未修改数据库 schema，无需逆向迁移。不要用删除数据卷代替回滚。

`quota.refund-failed` 或 `quota.save-unconfirmed` 表示需要人工核查。按日志中的用户 ID 检查余额、历史结果及同时间请求；未确认结果前不要直接加额度。日志不含模型密钥或数据库密码。
