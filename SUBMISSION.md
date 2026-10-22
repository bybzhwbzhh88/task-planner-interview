# 提交说明

- 姓名或称呼：李思泰
- 应聘方向：技术（AI 应用开发实习生）
- 打码手机号：152****1862

## 结果概览

初始版把额度当成"调用成功后的附带扣减"：模型先调用、余额取自登录态快照、判断与扣减分两步，并发时两个请求都能通过检查，余额被扣成负数。

改成**先预占、后结算**：用单条 `UPDATE ... WHERE credits >= 1` 同时完成判断与扣减，预占成功才调用模型；模型或落库失败退回预占额度；每笔变动写一条账本便于对账；接口返回剩余额度，页面按 402 / 502 给出不同且可行动的提示。

8 条验收案例里，AC-1 ~ AC-5（额度扣减、额度不足、模型失败、10 并发、顺序耗尽）已在真实 PostgreSQL 上自动化通过；AC-6 / AC-7 的页面表现、AC-8 的未登录分支没有执行，原因和范围写在验证记录里，不混进通过项。

## 交付入口

| 内容 | 位置 |
|---|---|
| 需求理解、范围与假设、并发思路、实现拆解、验收案例 | [SPEC.md](SPEC.md) |
| 额度域（预占 / 退回，不依赖 Wasp） | [src/demo-ai-app/quota.ts](src/demo-ai-app/quota.ts) |
| 流程编排（预占 → 模型 → 落库 → 失败退回） | [src/demo-ai-app/planFlow.ts](src/demo-ai-app/planFlow.ts) |
| Wasp 接线、402/502 映射、`getCreditStatus` | [src/demo-ai-app/operations.ts](src/demo-ai-app/operations.ts) |
| 页面：余额展示、低额度禁用、分场景提示 | [src/demo-ai-app/DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx) |
| 数据模型与迁移 | [schema.prisma](schema.prisma)、[migrations/20261022041429_add_credit_ledger](migrations/20261022041429_add_credit_ledger/migration.sql) |
| 单测（无需数据库） | [tests/quota.test.ts](tests/quota.test.ts) |
| 真实 PG 并发测试 | [tests/planFlow.pg.test.ts](tests/planFlow.pg.test.ts) |
| 验证记录 | [VERIFICATION.md](VERIFICATION.md) |

运行命令：

```bash
wasp install
npm test                                                        # 单元测试，无需数据库
wasp start db && wasp db migrate-dev
TEST_DATABASE_URL='postgresql://...' npm run test:pg            # 真实库并发测试
```

## 验证记录

完整记录与命令见 [VERIFICATION.md](VERIFICATION.md)。摘要：

| 案例 | 结果 |
|---|---|
| AC-1 成功扣 1 | 通过（余额 3→2、账本净 -1、落库 1 条） |
| AC-2 额度不足 | 通过（模型调用 0 次、无写入） |
| AC-3 模型失败 | 通过（余额不变、账本 -1/+1 净 0） |
| AC-4 并发 10 次 / 余额 3 | 通过（3 成功、7 拒绝、余额 0） |
| AC-5 顺序耗尽 | 通过（模型只调用 1 次） |
| AC-6 / AC-7 页面表现 | **未执行**（本机无法运行 Wasp，见记录第一节） |

对照实验：同一并发用例下，初始版 10 次全部成功、余额 -7；本方案 3 次成功、余额 0。

## 待办与交接

1. **先跑 `wasp compile` + 整仓 `tsc`**：本机 Wasp CLI 只支持 linux/macOS、WSL 被禁用，这两项没跑过，`getCreditStatus` 的类型依赖 `wasp compile` 生成。
2. **手工过一遍页面**（AC-6/AC-7）：余额条、按钮禁用态、两种 toast 文案都未在浏览器确认。
3. **迁移路径**：迁移 SQL 按「Wasp 注入 Auth 模型」手工收敛过（Prisma 自动生成时会 `DROP TABLE "Auth"/"AuthIdentity"/"Session"`）。请在 Wasp 下执行 `wasp db migrate-dev` 确认无 drift。
4. 已知限制（有意不做）：崩溃后额度不自动补偿、无幂等键、`hours` 未加范围校验、账本暂无对账页面、余额不轮询。详见 `SPEC.md` 第九节。
5. 变更未升级任何依赖；新增的只有 `tests/`、`vitest.config.ts` 与 `package.json` 里的 3 个 test 脚本，`vitest` 本来就在 devDependencies 里。
