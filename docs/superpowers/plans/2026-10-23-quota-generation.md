# 日程生成额度处理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 完成数据库原子预占、可靠结果反馈和可重复并发验证。

**Architecture:** 可测试编排通过存储接口调用 Prisma 适配器及现有 mock；Wasp 入口做身份和错误映射，页面通过账号隔离查询展示额度及最近结果。

**Tech Stack:** React、TypeScript、Wasp 0.25.0、Prisma 5.19.1、PostgreSQL、现有 Vitest。

**Spec:** [SPEC.md](../../../SPEC.md)，初稿 `f518957`，代码基线 `114aeb2`。

## Global Constraints

- 不升级依赖，不调用外部模型，不新增表或迁移。
- 成功为有效模型结果且确认保存；条件预占成功后才调用模型，明确失败最多返还一次。
- 写入结果未知时不盲目重试或返还；模型调用期间不持有事务。
- 数据以登录账号隔离；测试仅使用显式专用本地测试库，不复制主工作区私有配置。
- 本地提交已获授权；不推送、公开 PR 或编造身份信息。

## Review Focus

- 预占响应丢失：不误报未扣费且不调用模型（Task 1）。
- 保存已提交但响应丢失：核对本请求记录，防止错误返还（Task 1）。
- 返还抛错：最多一次，不被外层 catch 再次返还（Task 1）。
- 保存后余额查询失败：保留成功，未知余额不显示为 0（Tasks 1、3）。
- 切换账号和网络中断：不展示前账号结果，不自动重发生成（Task 3）。

---

### Task 1: 生成编排与错误协议

**Files:** Create `src/demo-ai-app/generation.ts`, `planGeneration.ts`, `tests/unit/planGeneration.test.ts`, `vitest.config.ts`; Modify `package.json` scripts。

**Interfaces:** Produces `generateForUser(userId: string, args: unknown, deps: GenerationDeps): Promise<GenerationOutcome>`。`PlanStore` 提供 listTasks/reserve/save/find/refund/credits。`StoredPlan={id,createdAt,schedule}`；`GenerationOutcome` 为 succeeded（plan、availableCredits: number|null）或 failed（code、requestId）。`GenerationError` 表示未执行的输入/空任务/无额度；`SaveRejectedError` 标记明确未提交。Consumes 现有 schema、mock provider，注入 ID 和日志。

- [x] 写 reserve=false 时 provider=0、成功少 1、模型失败恢复额度、非法参数与空任务不预占测试；运行 `npm run test:unit`，观察缺失编排红灯。
- [x] 实现上述接口，最小通过；添加保存拒绝、已提交后报错、核对为空/失败、预占提交后报错、返还前/后抛错、余额读取失败、无效模型输出测试，逐组先红后绿。
- [x] `npm run test:unit` 全通过；提交 Task 1。

### Task 2: Prisma、Wasp 入口及真实数据库并发

**Files:** Create `src/demo-ai-app/planStore.ts`, `tests/integration/generation.test.ts`, `concurrency.test.ts`, `tests/unit/operations.test.ts`, `scripts/test-db.mjs`; Modify `operations.ts`, `demo-ai-app.wasp.ts`, `mockAi.ts`, `package.json`。

**Interfaces:** Consumes Task 1；produces `createPlanStore(client): PlanStore`、`getCredits({viewerId}): {availableCredits}`、`getLatestPlan({viewerId}): StoredPlan|null`。viewerId 必须与登录账号一致。准备脚本校验 `QUOTA_TEST_DATABASE_URL` 为本地且库名以 `_quota_test` 结尾，应用既有迁移，不能重置应用库。

- [x] 写入口身份与越权查询、测试库保护测试；先运行红灯，再实现适配器、入口和查询。
- [x] 写 A01–A06 数据库测试：实际编排、适配器和 mock，每请求独立连接，以屏障确保重叠；断言调用日志、成功数、结果数及余额。A06 在模型完成前阻止返还，等待其他请求拒绝。
- [x] 执行 `npm run test:db:prepare`、`npm run test:integration`、`npm run test:concurrency`，预期 A04=1/9，A05 每轮=3/7，A06 失败后可重试。
- [x] 执行单元测试和 `wasp compile`；预期全通过；提交 Task 2。

### Task 3: 页面额度、结果恢复及操作反馈

**Files:** Modify `src/demo-ai-app/DemoAppPage.tsx`, `src/client/App.tsx`; Create `generationFeedback.ts`, `tests/unit/generationFeedback.test.ts`, `scripts/browser-check.mjs`。

**Interfaces:** Consumes Task 2 的 generatePlan/getCredits/getLatestPlan 和 useAuth；produces `generationFeedback(outcome|error): {title,message,tone}`；账号 key 重建本地状态，查询刷新并恢复最近日程。

- [x] 写成功消费 1、模型/保存已返还、未知不能宣称未扣费、401 下一步及网络中断测试；先红后绿。
- [x] 接入服务端额度和最近结果查询；页头共用事实来源，未知余额不显示 0；时长 1–24，生成中禁用，0 额度解释原因，提供刷新核对/重新登录。
- [x] 独立应用库运行浏览器：注册、任务、成功、刷新恢复、模型失败、0 额度、生成中禁用、账号隔离、非法时长；保留证据。
- [x] 单元测试、Wasp compile、两个 tsc --noEmit 均通过；提交 Task 3。

### Task 4: 实际验证、交接及最终评审

**Files:** Modify `README.md`, `SPEC.md`, `SUBMISSION.md`; Create `docs/verification.md`。

**Interfaces:** Consumes Tasks 1–3 证据及 A01–A16，产出可复现命令与实际结果。

- [x] 运行 `npm test` 全套、Wasp compile、两个 tsc；记录预期、实际及未执行项，区分单元、数据库和浏览器证据。
- [x] 写测试库准备、并发命令、未知状态人工核对，身份留待本人填写；更新 spec 最终状态及修订。
- [x] 对 `114aeb2..HEAD` 做独立整分支评审；重要问题一轮 RED→GREEN 修复，再跑全套。
- [x] 提交交接及证据，检查无私有配置和生成目录；保留 worktree，不合并/推送。

## 执行说明

用户已授权“编写实施计划并完成实现和验证”，本次采用 native 方式连续执行，不增加计划审批；末尾保留一次独立整分支评审。状态记入本计划专属忽略目录 ledger，实际证据写入验证文档。
