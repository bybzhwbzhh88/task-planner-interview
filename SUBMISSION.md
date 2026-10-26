# 提交说明

- 姓名或称呼：小石
- 应聘方向：技术
- 打码手机号：158\*\*\*\*6921

## 结果概览

基线 `generatePlan` 的额度判断发生在模型调用之后、依据请求快照、扣减无 `credits >= 1` 约束，导致额度为 0 仍发起调用、并发可透支成负数。方案是**一条带条件的原子 UPDATE 作为唯一额度闸门**（`updateMany` + `credits: { gte: 1 }`），占位成功才调用模型，模型失败则退还 1 个额度；额度逻辑抽成不依赖 Wasp 运行时的模块。数据库层验证已真实运行（PostgreSQL 16 + Prisma 直连）：6/6 场景、28 条断言通过，并用复刻的基线逻辑反向复现了透支（并发后 `credits = -9`）。Wasp CLI 无 Windows 发行版，`wasp compile` 与页面端到端未在本机运行，已明确标注。

## 交付入口

- 设计与拆解：[SPEC.md](SPEC.md)（先于代码提交初稿 `bdd43f8`，Git 历史保留后续修订）
- 主要改动：
  - `src/demo-ai-app/credits.ts`（新增）——`reserveCredit` / `refundCredit` / `readCredits`，存储以最小接口注入
  - `src/demo-ai-app/planGeneration.ts`（新增）——占位 → 调用 → 成功留存 / 失败退还 主流程与错误类型
  - `src/demo-ai-app/operations.ts`——`generatePlan` 变薄，402 / 502 / 401 错误码映射，新增 `getCredits` query
  - `src/demo-ai-app/demo-ai-app.wasp.ts`——注册 `getCredits`
  - `src/demo-ai-app/DemoAppPage.tsx`——剩余额度展示、额度为 0 禁用生成、402 / 502 分别提示
- 验证脚本：`scripts/verify-quota.mjs`，运行方式：

```bash
mkdir quota-tools && cd quota-tools && npm init -y
npm install @prisma/client@5.19.1 prisma@5.19.1 esbuild
export DATABASE_URL="postgresql://postgres@localhost:5433/quota_verify"
npx prisma db push --schema ../task-planner-interview/schema.prisma
PRISMA_CLIENT_DIR=$(pwd) node ../task-planner-interview/scripts/verify-quota.mjs
```

## 验证记录

逐项记录（命令、预期、实际、日志证据）见 [VERIFICATION.md](VERIFICATION.md)。摘要：

| 验收案例 | 结果 |
| --- | --- |
| A0 基线对照（复刻旧逻辑） | PASS——旧逻辑额度为 0 仍调用模型；1 额度并发 10 次后 `credits = -9` |
| A1 成功生成 | PASS——扣 1、落库 1 条、模型调用 1 次 |
| A2 额度不足 | PASS——模型调用 0 次、额度不变、不落库 |
| A3 模型失败 | PASS——先占位后退还，额度净变化 0 |
| A4 并发不透支（1 额度 / 10 并发） | PASS——1 成功 9 拒绝，`credits = 0` 不为负 |
| A5 并发多额度（3 额度 / 10 并发） | PASS——3 成功 7 拒绝，模型调用恰 3 次 |

未运行项（已标注）：`wasp compile`、两个 `tsc --noEmit`、页面端到端；原因与补齐方式见 `VERIFICATION.md` 末表。

## 待办与交接

- **补齐真机验证**：在 Linux/macOS 上执行 `wasp install` → `wasp db migrate-dev` → `wasp start`，按 `SPEC.md` 第 6 节走一遍 A1–A3 的页面路径；再跑 `wasp compile` 与两个 `tsc --noEmit`。`operations.ts` / `DemoAppPage.tsx` 的完整类型检查依赖 Wasp 生成物，本次只做了独立类型检查（新模块）与 esbuild 语法检查。
- **已知限制**（详见 `SPEC.md` 第 8 节）：进程在占位后崩溃会丢失 1 个额度（题目明确不要求崩溃补偿，未引入 Ledger 表）；退还语句自身失败时记录 `credits.refund_failed` 需人工核对；页面额度不做实时推送，多标签页需刷新。
- **接手提示**：额度逻辑全部在 `credits.ts` / `planGeneration.ts`，二者不 import Wasp 运行时，可直接被脚本或测试复用；改错误码文案只需动 `operations.ts` 顶部的两个常量。
