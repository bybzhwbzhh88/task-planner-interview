# 提交说明

- 姓名或称呼：吕
- 应聘方向：技术
- 打码手机号：153\*\*\*\*7442

## 结果概览

**问题判断**：原实现把额度校验放在模型调用**之后**，且"判断够不够"与"扣减"不是原子的（`operations.ts:49` 先调模型，`:67` 用请求开始时的 `credits` 判断，`:68` 无条件 `decrement`）。后果是三条：0 额度用户仍会真实发起一次模型调用；`credits=1` 时并发两个请求会把余额扣成 `-1`；页头余额取自登录快照，生成后不刷新。

**主要方案**：把"够不够"下沉到 SQL 的 `WHERE`，改为 **预扣 → 确认 / 退还**：`UPDATE ... WHERE credits > 0` 影响行数为 0 就返回 402 且零调用；模型失败则退还 1 并返回 502；成功写库后返回本次剩余额度。客户端余额收敛为单一数据源（页头订阅 `getCreditBalance`），0 额度时禁用按钮并给出原因。

**当前状态**：功能完成，验收全绿——接口层 29 项断言 + 界面层 4 项 + 单测 8 项全部通过；`tsc` 两个项目 exit 0。已知缺口在 [VERIFICATION.md](VERIFICATION.md) §3 明确标注（未做故障注入、未做崩溃补偿）。

## 交付入口

| 内容 | 位置 |
| --- | --- |
| 规格（范围/假设/流程/并发思路/实现步骤/验收案例） | [SPEC.md](SPEC.md) |
| 主要改动 | [credits.ts](src/demo-ai-app/credits.ts)（预扣/退还/落库）、[operations.ts](src/demo-ai-app/operations.ts)（流程与错误码）、[App.tsx](src/client/App.tsx)（余额单一来源）、[DemoAppPage.tsx](src/demo-ai-app/DemoAppPage.tsx)（禁用态与文案） |
| 并发验收脚本 | [verify-quota.mjs](scripts/verify-quota.mjs)，`npm run verify:quota` |
| 逻辑层单测 | [credits.test.ts](tests/credits.test.ts)，`npm run verify:unit` |
| 验证记录与证据 | [VERIFICATION.md](VERIFICATION.md)，截图在 [docs/verification/](docs/verification/) |

运行命令：

```sh
wasp db migrate-dev
wasp start > /tmp/wasp-dev.log 2>&1     # 另开终端；日志供验收脚本统计 mock-ai.started
npm run verify:unit
npm run verify:quota                     # 默认打 127.0.0.1:3001，日志读 /tmp/wasp-dev.log
```

## 验证记录

逐条对应 SPEC §7 的 AC-01~AC-14，操作、预期、实际与证据见 [VERIFICATION.md](VERIFICATION.md)。要点：

- **并发不透支**：3 额度下并发 10 个请求 → 3 个 200、7 个 402，余额正好 0（不为负），`PlanResult` 3 条，`mock-ai.started` 3 条。
- **额度不足零调用**：402 请求耗时 11ms（成功请求约 527ms），`mock-ai.started` 计数不变。
- **失败不扣额度**：含 `[fail]` 任务时返回 502，余额 3→3，无 `PlanResult`。
- **链路可核验**：每次尝试用同一 `callId` 串起 `credits.begin → credits.reserved → mock-ai.started → credits.committed`，`grep <callId>` 即可还原。
- **未验证项**：写库失败/退还失败仅单测覆盖，崩溃窗口与多实例部署未验证，均已在 VERIFICATION §3 标注。

## 待办与交接

1. **残留窗口**：预扣成功后进程崩溃会少 1 额度且无产物。TASK 已排除自动补偿，方案留在 SPEC §3.4 与 §9：加 `CreditLedger`（`pending/committed/refunded`）或按 `callId` 对账。
2. **退还无账本可审计**：正常路径不会双退，但没有交易流水。同上一条一并解决。
3. **未做故障注入**：建议补一条"写库失败自动退还"的集成测试（可用可控的 Prisma 中间层或临时改名表制造失败）。
4. **改动范围克制**：`isDone` 过滤、`hours` 上下界校验、任务排序等与额度无关的问题保持原样，避免把评审面拉大。
