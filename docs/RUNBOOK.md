# 运行与验证

额度改动无需新增迁移或外部模型账号。应用运行沿用 [README](../README.md#环境)；自动验收使用独立 PostgreSQL 库，执行真实服务端函数、原有 mock 和真实 SQL。当前结果见 [验证记录](VERIFICATION.md)。

## 一次性准备

Linux/macOS 或 WSL2 Linux 文件系统内，准备 Node >=24.14.1、Wasp **0.25.0**、PostgreSQL。安装配置仍按 README 的 `wasp install` 和 env 示例执行。

可新建一个只用于验收的数据库，例如本机 Docker：

```sh
docker run -d --name planner-quota-test \
  -e POSTGRES_USER=planner -e POSTGRES_PASSWORD=planner_local_test \
  -e POSTGRES_DB=planner_test -p 127.0.0.1:55432:5432 postgres:17
docker exec planner-quota-test pg_isready -U planner -d planner_test
```

这些是本地一次性测试凭据。等待数据库显示 accepting connections 后，在项目根目录运行：

```sh
export TEST_DATABASE_URL='postgresql://planner:planner_local_test@localhost:55432/planner_test'
bash scripts/verify.sh
```

脚本依次编译 Wasp、使用生成 schema 应用已有迁移、运行两个 TypeScript 检查、执行 12 项集成测试。任意命令失败会非零退出。数据库已准备好后可重复执行 `npm run test:quota`，或只运行并发用例：

```sh
DATABASE_URL="$TEST_DATABASE_URL" npm run test:quota -- -t 'A4|A5|A6'
```

测试要求数据库名以 `_test` 结尾，创建随机账号后只清理自己创建的数据，不清库。请使用独立数据库；中途强杀进程可能留下测试账号。A1–A8 不替换数据库或模型，A9–A11 仅注入指定数据库异常。测试直接调用 Wasp 操作函数，**不代替 HTTP 鉴权和浏览器验收**。

## 结果判读

`mock-ai.started` 每条代表一次模型调用；测试打印 `{"case":"A4",...}` 等摘要，断言余额、结果数和调用数一致。异常案例打印错误堆栈是预期证据，以最终测试退出码和断言结果判断是否通过。Vitest 将 NODE_ENV 设为 development 是为了兼容 Wasp 0.25 的环境校验，不会连接默认业务库。

## 人工页面验收

1. 注册账号，确认初始可用额度 3；添加普通任务，生成后顶部和生成区域显示 2，历史中有新日程；刷新页面仍可查看。
2. 添加含 `[fail]` 的任务，生成后额度恢复、错误提示包含下一步；删除该任务后可以再次成功。
3. 消耗剩余额度或用 `wasp db studio` 设置为 0，刷新；生成按钮禁用，保留刷新和查看历史入口。API 拦截由 A2/A4 验证。
4. 两标签页同账号并发生成，切回时核对余额。自动化数据库竞争由 A4/A5 复现；标签页焦点刷新需单独观察。

## 故障交接

- `quota.refund_failed`：先核对账号余额、日程记录和日志，确认补偿是否已生效；不要盲目重复加额。
- `quota.save_uncertain`：核对是否已有该时段日程；记录确实未写入且没有并发业务变动时才人工修正余额。
- 预占后进程崩溃的恢复、完整请求账本和自动对账不在本题范围。若上线真实供应商，应补充请求标识、持久化预占状态和对账流程。
- 不要提交 `.env*` 实际配置、数据库文件、`node_modules` 或 `.wasp` 生成目录。
