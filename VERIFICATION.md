# 验证记录

对应 `SPEC.md` 第八节的验收案例。每条写明：怎么跑、预期、实际。**未执行的检查在第七节单独列出，不混在通过项里。**

## 一、本机环境与偏差

| 项 | 实际情况 |
|---|---|
| 系统 / Node | Windows 11 / Node v24.14.0（`engines` 要求 >=24.14.1，仅版本号差一个 patch，npm 给 warning 不阻塞） |
| Wasp CLI 0.25.0 | **装不上**：`@wasp.sh/wasp-cli` 的 `os` 白名单只有 `linux,darwin`，`npm i` 报 `EBADPLATFORM` |
| WSL2 | 本机安全策略禁用，`wsl.exe` 无法启动 |
| Docker / psql | 未安装 |
| 实际使用的数据库 | `embedded-postgres@17.10.0-beta.17`（npm 包，纯本地进程，端口 55432），用 `prisma migrate deploy` / `migrate reset` 建表 |

因此：凡需要 Wasp 进程（`wasp compile`、`wasp start`、浏览器操作）的检查**没有执行**；凡只需要「PostgreSQL + Prisma + 业务代码」的检查**都真实执行了**。两者在数据库事务与并发语义上没有差别——测试打的是同一个 PostgreSQL、同一个 Prisma Client、同一份额度代码。

为此，额度逻辑被放在 `src/demo-ai-app/quota.ts` 与 `src/demo-ai-app/planFlow.ts`，不 import 任何 Wasp 运行时，`operations.ts` 只做一次接线。这不是为了测试而拆，是为了让规则能被独立验证。

## 二、复现方式

```bash
# 0) 依赖（首次）
wasp install

# 1) 单元测试：流程顺序与分支，不需要数据库
npm test                      # = vitest run tests/quota.test.ts

# 2) 真实 PostgreSQL 并发测试
wasp start db                 # 或自备 PostgreSQL
wasp db migrate-dev           # 建表（含 CreditLedgerEntry）
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/planner_test' npm run test:pg

# 3) 全量
TEST_DATABASE_URL='postgresql://...' npm run test:all
```

`tests/planFlow.pg.test.ts` 未设置 `TEST_DATABASE_URL` 时整组跳过，所以 `npm test` 在无数据库环境下也能跑。测试自己创建并清理数据（按 `userId` 精确删除）。

## 三、逐条结果

| 案例 | 命令 / 操作 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| AC-1 成功扣 1 | `tests/planFlow.pg.test.ts` → `AC-1 …` | 余额 3→2、`PlanResult` +1、账本净 `-1`、provider 调用 1 次 | 全部吻合 | 通过 |
| AC-2 额度不足不调用模型 | 同上 → `AC-2 …` | 抛 `QuotaExhaustedError`、provider 调用 **0**、账本为空、无 `PlanResult` | 全部吻合 | 通过 |
| AC-3 模型失败不扣额度 | 同上 → `AC-3 …` | 抛 `PlanGenerationFailedError`、余额仍 2、账本 `-1`/`+1` 净 0、无 `PlanResult` | 全部吻合 | 通过 |
| AC-4 并发不透支 | 同上 → `AC-4 …`（10 并发 / 余额 3） | 3 成功、7 拒绝、provider 3 次、余额 0、账本净 `-3` | 3 成功 / 7 拒绝 / provider 3 次 / 余额 0 / 账本净 -3 | 通过 |
| AC-5 顺序耗尽 | 同上 → `AC-5 …`（余额 1，连发 3 次） | 第 1 次成功，后两次拒绝，provider 只调用 1 次 | 吻合 | 通过 |
| AC-6 余额展示 / 禁用 | 浏览器操作 | 顶部显示"剩余额度 N 次"，N=0 时按钮禁用并说明原因 | — | **未执行**（无 Wasp 运行时，无法打开页面） |
| AC-7 失败后余额仍在 | 浏览器操作 | 失败提示"额度已退回"，余额不变，删除 `[fail]` 后可再生成 | 服务端逻辑由 AC-3 覆盖；提示文案与交互未在浏览器验证 | **部分** |
| AC-8 未登录 401 | 调用 `generatePlan` | 401，且无写操作 | 代码路径 `if (!context.user) throw HttpError(401)`，在预占之前 | **未执行测试**（依赖 Wasp 鉴权上下文） |
| 额外：流程分支单测 | `npm test` | 7 条全绿 | `7 passed` | 通过 |

单测（`tests/quota.test.ts`，假存储）覆盖：成功扣减、额度不足时模型 0 调用、模型抛错退回、落库失败退回、provider 返回 null、连续递减、10 并发下只成功 3 次。它的作用是把**顺序与分支**钉死；**并发语义只能靠真实数据库证明**，见 AC-4。

## 四、关键输出

```
$ TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:55432/planner_test?schema=public' npx vitest run tests/planFlow.pg.test.ts

 ✓ tests/planFlow.pg.test.ts (6 tests) 679ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

```
$ npm test

 ✓ tests/quota.test.ts (7 tests) 6ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

```
$ TEST_DATABASE_URL=... npx vitest run          # 连跑 3 次，结果一致
 Test Files  2 passed (2)
      Tests  13 passed (13)
```

## 五、对照实验：初始版在同一并发场景下会透支

为确认 AC-4 真的能抓到问题，用**初始版逻辑**（会话快照判断 + 无条件 `decrement` + 先调用模型）跑了同一个用例：

```js
// 一次性脚本，未提交；核心逻辑与初始版 operations.ts 一致
const snapshot = await prisma.user.findUniqueOrThrow({ where: { id: userId } }); // = context.user.credits
await sleep(50);                                                                 // = 模拟模型调用
const tx = [prisma.planResult.create({ data: { userId, content: "{}" } })];
if (snapshot.credits > 0) tx.push(prisma.user.update({ where: { id: userId }, data: { credits: { decrement: 1 } } }));
else throw new Error("User is out of credits");
await prisma.$transaction(tx);
```

| 实现 | 10 并发（初始余额 3） | 模型调用 | 最终余额 |
|---|---|---|---|
| 初始版 | 10 次全部成功 | 10 | **-7** |
| 本方案 | 3 次成功 / 7 次拒绝 | 3 | 0 |

## 六、类型检查

| 检查 | 结果 |
|---|---|
| `npx tsc --ignoreConfig --noEmit --strict --target esnext --module esnext --moduleResolution bundler --lib esnext,dom --skipLibCheck src/demo-ai-app/quota.ts src/demo-ai-app/planFlow.ts` | exit 0（严格模式通过） |
| `npx tsc --project tsconfig.src.json --noEmit`（整仓） | **未执行**：`wasp/entities`、`wasp/server/operations` 等类型由 `wasp compile` 生成，本机无法执行 Wasp CLI |

## 七、未执行的检查（明确列出）

1. `wasp compile`、`wasp start`：Wasp CLI 不支持 Windows 原生，WSL 被禁用。
2. 整仓 `tsc`：依赖上一条生成的类型。
3. 浏览器端 AC-6 / AC-7：没有可运行的页面。
4. 迁移在「Wasp 注入 Auth 模型后的完整 schema」下由 `wasp db migrate-dev` 实际执行：本机用 `prisma migrate reset` 验证了迁移 SQL 本身可干净重放，但没跑过 Wasp 那条路径。迁移已手工去掉 Prisma 误生成的 `DROP TABLE "Auth"/"AuthIdentity"/"Session"`（原因写在迁移文件头）。
5. `mock-ai.started` 日志条数没有在真实服务端日志里数过；用 provider 调用次数（测试内计数）等价断言。
