# 验证记录

对应 `ACCEPTANCE.md` 的案例编号。运行环境与方式见下。状态说明：✅ 已运行通过；⏳ 未运行（原因标注）。

## 运行方式

```bash
npm install --workspaces=false   # 安装根依赖（跳过 .wasp workspace）
npx prisma generate              # 生成 Prisma Client
node scripts/verify-credits.mjs  # 四场景服务级验证（自动起临时 PostgreSQL）
```

脚本对真实 PostgreSQL 执行，验证 `credits.ts` 的 SQL 语义（预扣/退回/查询）。退出码非 0 表示存在失败项，可重复执行。仓库 engines 要求 Node >= 24.14.1，请用 Node 24 运行。未设置 `DATABASE_URL` 时脚本自动启动内嵌 PostgreSQL（中文 Windows 需强制 C locale，脚本已处理）。

## 结果

运行时间：2026-10-21，Node v24.20.0，embedded-postgres（PostgreSQL 临时实例，端口 55432）。

```text
PASS  AC1 成功路径：预扣 1 次成功、余额 3→2、PlanResult 可写入 — count=1, credits=2
PASS  AC2 额度不足：预扣失败、余额保持 0 不为负 — count=0, credits=0
PASS  AC3/AC5 失败退回：两轮预扣+退回后余额仍为 3 — credits=3
PASS  AC4 并发：3 个并发预扣只有 1 个成功、余额 1→0 不为负 — success=1, credits=0
4/4 通过，全部通过
```

| 案例 | 场景 | 验证层级 | 状态 | 实际结果 |
|------|------|---------|------|---------|
| AC1 | 成功生成消耗额度 | 服务级（脚本） | ✅ 通过 | 预扣 count=1，余额 3→2，PlanResult 写入成功 |
| AC2 | 额度不足不发起调用 | 服务级（脚本） | ✅ 通过 | 预扣 count=0（调用方据此返回 402，不发起调用），余额保持 0 |
| AC3/AC5 | 模型失败退回、余额一致 | 服务级（脚本） | ✅ 通过 | 两轮预扣+退回后余额仍为 3 |
| AC4 | 并发不透支 | 服务级（脚本） | ✅ 通过 | 3 个并发预扣仅 1 个成功，余额 1→0，不为负 |
| AC1–AC6 | 全流程含 UI 提示 | UI 级（Wasp 应用） | ⏳ 未运行 | 见下方说明 |

说明：脚本对「预扣 → （模拟调用结果）→ 退回/保存」的服务端逻辑与 SQL 语义做了真实数据库验证；`mock-ai.started` 日志断言（AC2/AC4 中"未发起调用"）在服务级由「预扣失败即返回」的逻辑保证，完整的 HTTP/UI 断言待 UI 级验证。

## UI 级验证未运行的原因

本题要求 Windows 下通过 WSL2 运行 Wasp + Docker 化 PostgreSQL。当前执行环境沙箱禁止启动 `wsl.exe` 且无 Docker，无法在提交前完整拉起应用。已采取的替代措施：

1. `scripts/verify-credits.mjs` 对真实 PostgreSQL 覆盖 AC1–AC5 的核心断言（预扣、退回、并发不透支、不产生负数）。
2. UI 侧改动（提示文案、余额展示）逻辑简单，且沿用原有 toast 通道，改动见 `src/demo-ai-app/DemoAppPage.tsx`。
3. 接手者在 WSL2 环境按 README 启动后，可按 `ACCEPTANCE.md` 逐条手动验证；日志断言（`mock-ai.started` 是否出现）在 AC2/AC4 中尤其值得核对。

## 待办与已知限制（交接）

- **崩溃补偿**：预扣成功后进程崩溃，该额度不会自动退回（TASK.md 范围外）。如需补齐：引入 `CreditReservation` 表记录「预扣中」状态，生成结束后置为 consumed/refunded，定时任务对超时记录对账退回。
- **UI 级验证**：如上，未在真实应用中执行。
- `wasp compile` 与两个 tsc 检查未运行（依赖 `wasp install` 生成的 SDK，环境受限）。改动范围小且类型显式，风险集中在 `operations.ts` 的返回类型变更，前端已同步。
- **一处未验证的假设**：`operations.ts` 使用的 `GetUserCredits` 操作类型名是按 Wasp 对声明式操作的命名惯例推断的，未经 `wasp compile` 实测。接手者运行 `wasp compile` 后若报类型不存在，检查 `main.wasp.ts`/`demo-ai-app.wasp.ts` 中 `getUserCredits` 的声明是否与框架版本匹配即可。
