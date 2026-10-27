# 验证记录

> 对应 [SPEC.md](SPEC.md) §6 的验收案例。只记录实际执行过的检查；未运行的项单独列出，不写成通过。

## 环境

- Windows，Node.js `v24.21.0`（原生 TypeScript 类型擦除）。
- 本机没有 WSL、Docker、PostgreSQL 或 Wasp CLI，因此没有启动完整应用。
- 额度核心不依赖 Wasp/Prisma：测试用内存仓储代替数据库，模型使用仓库内真实的 `mockAi.ts`。

## 1. 自动化测试

命令：

```sh
npm run test:quota
```

实际输出（2026-10-27）：

```text
> test:quota
> node --test --test-isolation=none tests/generate-plan.test.ts

✔ AC-01 成功：预占 1 个额度、保存结果并返回剩余额度 (0.903ms)
✔ AC-02 额度不足：不调用模型、不保存、不改变余额 (0.342ms)
✔ AC-03 模型明确失败：退回额度并映射为 ModelRejectedError (0.2873ms)
✔ AC-04 并发争抢最后 1 个额度：只成功 1 个、只调用 1 次模型 (0.3044ms)
✔ AC-05 结果保存失败：退回额度，不留下结果 (0.1866ms)
✔ 退款失败会单独暴露，避免静默吞掉用户损失 (0.2049ms)
✔ mockAi 成功时 started/succeeded 成对，callId 一致 (513.2769ms)
✔ mockAi 明确失败时抛出 MOCK_AI_REJECTED，日志为 started/failed (513.6699ms)
✔ 真实 mockAi + 5 并发：只有 1 次 mock-ai.started (517.1367ms)
✔ 模型返回空结果：退款并失败，不保存空日程 (0.8795ms)
✔ 5 并发、3 个额度：恰好 3 个成功，2 个额度不足 (1.0257ms)
✔ 读取任务失败：退回额度，不调用模型 (0.4759ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1597.8552
```

判定：12/12 通过，退出码 0。

说明：

- `--test-isolation=none` 是因为当前 Windows 文件沙箱禁止测试 runner 再 spawn 子进程；在普通环境去掉该参数也可运行。
- “真实 mockAi + 5 并发”用例直接调用 [`src/demo-ai-app/mockAi.ts`](src/demo-ai-app/mockAi.ts)，捕获并断言 `mock-ai.started` / `succeeded` 日志各 1 条，同时断言额度 0、结果 1 条。
- 内存仓储的 `reserveCredit` 在读写之间没有 await，模拟生产端单条条件 `UPDATE` 的原子性；它不能替代真实 PostgreSQL 锁行为，见 §4。

## 2. 类型检查

命令：

```sh
# 当前环境把 TypeScript 装在工作区上层；正常项目在 wasp install 后可直接 npm run typecheck:quota
..\node_modules\.bin\tsc.cmd --project tsconfig.verify.json
```

实际结果：无输出，退出码 0。覆盖 `generate-plan.ts`、`mockAi.ts`、`schedule.ts`、`tests/generate-plan.test.ts`。

未运行：`tsc --project tsconfig.src.json` 和 `tsconfig.wasp.json`，因为项目未执行 `wasp install`，`wasp/*` 生成类型不存在。CI/本地完整环境应补跑。

## 3. 验收案例对应

| 验收案例 | 验证方式 | 结果 |
| --- | --- | --- |
| AC-01 成功扣 1 | 单测 `AC-01`；真实 mock 成功日志用例 | 通过 |
| AC-02 额度不足不调模型 | 单测 `AC-02`：模型调用计数 0、余额 0、无结果；页面禁用未跑 | 服务端通过；页面未运行 |
| AC-03 模型失败不扣费 | 单测 `AC-03`；真实 mock 失败日志用例 | 通过 |
| AC-04 并发不透支 | 单测 `AC-04`；真实 mock 5 并发用例 | 通过（编排/交错层） |
| AC-05 保存失败退款 | 单测 `AC-05` | 通过 |
| AC-06 未登录 401 | 未运行；`generatePlan` 入口保留 401 分支 | 未验证 |
| AC-07 双击保护 | 未运行；`generatingRef` + 按钮禁用静态检查 | 未验证 |
| AC-08 重试边界 | 文档说明；无幂等实现 | 已知限制 |

## 4. 未运行项与原因

| 项目 | 原因 | 建议补测 |
| --- | --- | --- |
| `wasp compile`、完整 `tsc` | 本机无 Wasp CLI/生成目录 | 在 README 环境执行 |
| 真实 PostgreSQL 并发 | 本机无 Postgres/Docker/WSL | 建 1 额度账号，并发 5 个请求，核对 `User.credits=0`、`PlanResult` 只有 1 条、`mock-ai.started` 只有 1 条 |
| 页面 AC-01/02/03/07 | 应用未启动 | 启动后按 SPEC §6 手工走查，检查余额、按钮、结果条 |
| 真实 HTTP 401 | 应用未启动 | 退出登录后直接调用 action |
| 崩溃窗口补偿 | 明确不在范围 | 需要预占流水 + 对账任务 |

## 5. 复现完整环境

```sh
cp .env.server.example .env.server
cp .env.client.example .env.client
wasp install

# 终端一
wasp start db

# 终端二
wasp db migrate-dev
wasp start
```

然后：

1. 注册账号，确认生成区显示“剩余额度：3”。
2. 添加普通任务，生成一次，确认余额 2、结果条显示扣 1。
3. 在 `wasp db studio` 把该账号 `credits` 改为 0，刷新页面，确认按钮停用并提示补充额度；直接触发服务端请求应得 402，日志无 `mock-ai.started`。
4. 把额度改回 2，添加含 `[fail]` 的任务，生成，确认 502、余额仍 2、日志为 `started` + `failed`。
5. 把额度改为 1，删除 `[fail]` 任务，用并发工具同时发 5 个生成请求，确认只成功 1 个、余额 0、`PlanResult` 只多 1 条、`mock-ai.started` 只出现 1 次。
