# 验证记录与复现

> **结论**：已在受限环境中运行配额编排及真实模拟接口的 15 项 Node 测试，15/15 通过；独立配额模块静态类型检查通过。**Wasp 应用编译、HTTP 端到端及 PostgreSQL 并发脚本未运行**（执行环境为 Node 22、无 Wasp CLI、无 PostgreSQL/psql、且无法访问包注册表）。不得将内存并发测试误称为数据库集成验证。

## 运行环境与结果

- 日期：2026-10-23；Linux 容器；Node.js `v22.16.0`；npm `10.9.2`；全局 TypeScript `5.8.3`。
- 执行命令：`npm run test:quota`（`node --experimental-strip-types --test tests/creditQuota.test.mjs tests/mockAi.test.mjs`）。
- 实际结果：15 tests, 15 passed, 0 failed；完整运行输出见 [单元测试证据](./test-results-quota.txt)。
- 执行命令：`tsc --noEmit --strict --module esnext --target esnext --lib esnext,dom src/demo-ai-app/creditQuota.ts`。
- 实际结果：退出码 0，无报错（仅覆盖可独立类型检查的配额核心文件）。
- `wasp compile`、`npx tsc --project tsconfig.src.json --noEmit`、`npx tsc --project tsconfig.wasp.json --noEmit`：**未运行**；需 Node 24.14.1+、Wasp 0.25.0 及仓库依赖；不能声称整个应用已通过类型检查。

## 验收案例对照

| 案例 | 验证方式 | 可观察预期 | 实际记录 |
| --- | --- | --- | --- |
| A01 成功 | `creditQuota.test.mjs` | 保存 1 次，余额 -1 | 通过（内存模拟仓储） |
| A02 额度 0 | `creditQuota.test.mjs` | 不调用模型、余额不变 | 通过（内存模拟仓储） |
| A03 模型失败 | `creditQuota.test.mjs` + `mockAi.test.mjs` | 失败释放额度；`[fail]` 记录 started/failed | 通过（模块及真实本地模拟接口） |
| A04 保存失败 | `creditQuota.test.mjs` | 返还一次，返回保存失败 | 通过（故障注入） |
| A05 并发 10/余额 1 | `creditQuota.test.mjs` | 模型调用/成功数最多 1、非负 | 通过（内存并发；不是数据库证明） |
| A06 并发 50/余额 3 | `creditQuota.test.mjs` | 模型调用/成功数最多 3、非负 | 通过（内存并发；不是数据库证明） |
| A07 预占异常 | `creditQuota.test.mjs` | 不调用模型，识别额度检查异常 | 通过（故障注入） |
| A08 返还异常 | `creditQuota.test.mjs` | 明确余额待核对，保留原始错误 | 通过（故障注入） |
| A09 非法 hours/无任务 | 浏览器或 HTTP 检查 | HTTP 400，不调用模型，不扣费 | **未运行；已在 `operations.ts` 实现校验** |
| A05/A06 真实 PostgreSQL | `tests/quota.postgres.test.mjs` | 同行并发条件 UPDATE 只成功初始额度次数 | **脚本已提供，未运行** |
| A01–A03 Wasp 页面/HTTP | 见下方人工步骤 | 实际余额、模型日志、结果一致 | **未运行** |

## 如何复现自动化测试

项目根目录执行：

```sh
npm run test:quota
```

上述脚本只使用 Node 原生 test runner；Node 22 需 `--experimental-strip-types`，Node 24 兼容。测试的 `FakeCredits` 仅模拟原子条件更新的预期语义；即使测试通过，也不能证明数据库实现具备原子性。

真实 PostgreSQL 并发测试：**务必使用独立测试数据库**（已经执行仓库的 Wasp/Prisma migration，`User` 表存在）。本地需能执行 `psql` 命令。

```sh
export QUOTA_TEST_DATABASE_URL='postgresql://测试用户:密码@127.0.0.1:5432/专用测试数据库'
npm run test:quota:db
```

脚本仅插入临时随机 UUID 测试用户，并在测试后删除；10 和 50 个并发连接分别试验 `UPDATE ... WHERE credits > 0`。这是 **PostgreSQL 更新条件** 的验证，仍不等同于整个 Wasp HTTP 链路的端到端测试。缺少测试库或 `psql` 时应标记未运行，不要编造输出。

## Wasp/前端人工验收（需在能启动项目的机器运行）

先执行 `wasp install`、`wasp start db`、`wasp db migrate-dev` 和 `wasp start`，参见 [README](../README.md)。在页面注册测试用户并添加一条正常任务。使用 `wasp db studio` 观察 `User.credits` 和 `PlanResult`，服务器终端核对 `mock-ai.*` 日志。

1. **A01**：将测试用户额度设为 1，刷新，点一次生成；预期 1 条 `mock-ai.started` 和 `mock-ai.succeeded`、新日程入库、余额 0、页面成功提示。
2. **A02**：额度设为 0 后刷新，点击生成；预期“额度不足”，没有新增 `mock-ai.started`，没有新结果。
3. **A03**：额度设为 1，在任务里添加 `[fail]`，点击生成；预期日志为 started+failed，余额恢复 1，没有新结果，前端提示检查 `[fail]` 并重试。
4. **A09**：通过客户端或操作调用提交 `hours=0` 或 `hours=25`，以及清空任务后发起请求；预期 400、不调用模型、不扣费。
5. **A04/A08**：可在测试环境中以模拟 Prisma `PlanResult.create` 失败/`User.update` 失败的方式注入；预期分别返还或明确提示需人工核对（不得在真实用户环境断开生产数据库）。

## 已知边界

- 服务进程在扣减后、返还前崩溃可能遗留预占。题目明确不要求自动补偿；正式计费系统应增加持久化预占、状态和对账。
- 数据库写入结果未知（例如保存已提交但数据库响应超时）时，补偿可能与实际结果不一致；需要事务标识和对账机制才能严格处理，超出本任务范围。
- 前端余额查询是操作后的快照，并发时可能暂时过时；最终权限仍由服务端条件更新决定。
- 当前未连接 GitHub 账号，无法代替提交者完成远端 PR。
