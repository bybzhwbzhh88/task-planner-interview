# 验证与运行记录

已完成核心逻辑及页面改动，内存事务适配器测试 6/6 通过。数据库锁行为、Wasp 生成类型与页面交互仍需在完整环境验收，不能将核心测试视为数据库并发证明。

## 已执行（2026-10-26）

环境：Windows PowerShell，Node v22.23.1（低于应用要求，只用于运行无依赖核心测试）。

命令：`npm run test:quota`（等价于 `node --experimental-strip-types --test tests/quota.test.mjs`）。

| 案例 | 预期 | 实际 |
| --- | --- | --- |
| A1 | 3 额度生成 1 次，调用 1 次，剩 2，保存 1 | 通过 |
| A2 | 0 额度，无调用，402，无结果 | 通过 |
| A3 | [fail] 返回 502，余额 1，修正后成功剩 0 | 通过，使用真实 mockAi |
| A4 | 1 额度、10 请求，仅 1 成功/调用，9 个 402 | 通过，仅内存适配器 |
| A5 | 3 额度、10 请求，仅 3 成功/调用，7 个 402 | 通过，仅内存适配器 |
| A6 | 保存异常后余额回滚，无结果 | 通过，仅内存适配器 |

测试使用生产的 runGeneration 与 mockAi；内存适配器串行模拟事务和回滚，并不测试 PostgreSQL 行锁或 Prisma 映射。

## 尚未执行

- A1–A6 PostgreSQL 集成脚本：本机没有可连接 PostgreSQL，Docker daemon 未启动。
- A7 登录、时长、无任务的 Wasp 操作验收：未启动应用。
- A8 浏览器验收：未启动应用。
- README 的 `wasp compile` 和两项 tsc 检查：本机无 Wasp/WSL，依赖未安装；离线取得 TypeScript 失败（ENOTCACHED）。

## 接手后复现

先按 [README](README.md) 使用 WSL2、Node >=24.14.1、Wasp 0.25.0 安装并启动应用。无需新增数据迁移。

核心测试无需安装依赖：

```sh
npm run test:quota
```

真实数据库测试只对独立测试数据库运行，不使用生产数据库。该脚本创建临时用户，最后清理自己的用户和结果。请先建空 PostgreSQL 测试数据库，安装依赖、生成 Prisma client 并应用原有迁移：

```sh
wasp install
export TEST_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/planner_test'
DATABASE_URL="$TEST_DATABASE_URL" npx prisma generate --schema schema.prisma
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy --schema schema.prisma
npm run test:quota:postgres
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
```

集成测试通过才可确认 A4/A5 的真实数据库行为；每个子测试会输出 calls、success、remaining，并验证每个失败请求的状态以及结果行数。

页面人工检查：注册账号，添加任务，确认显示 3 额度；生成后应显示 2 和保存历史。添加 [fail] 再生成，余额仍为 2，提示移除标记再试。数据库设为 0 并刷新：生成按钮禁用；直接请求仍应 402，服务端不新增 mock-ai.started。无任务、未登录、非法 hours 均不应调用模型。网络异常后刷新余额和历史，先确认结果再重试。

## Git 历史与 PR

ZIP 不包含上游 Git 历史。本地仓库先保存原始 ZIP 基线，再单独提交 SPEC 初稿，最后提交实现。它不是上游 clone，不能直接把这个独立根历史推送到上游 PR。

拿到可用网络和自己的 Fork 后，克隆 Fork，建立分支，将本地第二个提交（spec）和第三个提交（实现）按顺序 cherry-pick 到该分支；不要 cherry-pick ZIP 基线提交。填写 SUBMISSION 中称呼与打码手机号，再向原仓库创建 PR。这样仍保留先 spec、后代码的顺序。尚未代用户创建 Fork 或 PR。
