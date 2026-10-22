# 验证记录

> 对应 [SPEC.md](SPEC.md) §7 的验收案例。每条写明：操作/命令、预期、实际、证据位置。
> 复现命令见 [SPEC.md](SPEC.md) §8.2，本文不重复流程。

## 0. 结论

| 层 | 用例数 | 结果 | 跑法 |
| --- | --- | --- | --- |
| 静态检查（两个 `tsc` 项目） | 2 | 全部 exit 0 | `npx tsc --project … --noEmit` |
| 逻辑层单测（假存储） | 8 | 8 passed | `npm run verify:unit` |
| 接口层（真实 HTTP + Postgres） | 29 项断言 | 29 PASS / 0 FAIL / 0 SKIP | `npm run verify:quota` |
| 界面层（真实浏览器） | 4 | 4 PASS | 一次性 Playwright 脚本，截图见 `docs/verification/` |

**环境**：WSL2 Ubuntu 24.04.5 / Node 24.22.0 / Wasp 0.25.0 / PostgreSQL 16.15。API 在 `3001`，Vite 客户端在 `3000`。
**代码状态**：本节数据来自提交 `test: 四场景与并发可重复验收` 之后的工作树，与最终 PR 分支一致。

## 1. 验收矩阵

接口层的「证据」列对应 `npm run verify:quota` 的输出行；界面层的证据是对应截图。

| ID | 操作 | 预期 | 实际 | 证据 |
| --- | --- | --- | --- | --- |
| AC-01 | 新账号 3 额度、1 条任务，生成一次 | 200；`creditsRemaining=2`；余额 2；`PlanResult` +1；`mock-ai.started` +1 | 全部成立，耗时 527ms（含 500ms 模拟延迟） | `[PASS] AC-01 生成成功并返回 creditsRemaining=2` 等 4 行 |
| AC-02 | 同一账号连续生成 4 次 | 余额依次 2/1/0；第 4 次 402；`PlanResult` 3 条；`started` 只增 3 | 全部成立 | `[PASS] AC-02 连续 3 次余额依次为 2/1/0` 等 4 行 |
| AC-03 | 余额 0 时再生成 | 402；`started` 不变；`PlanResult` 不变；耗时 < 100ms | 402；`started` 4→4；耗时 **11ms**（成功请求 ~527ms） | `[PASS] AC-03 不发起模型调用：耗时明显低于 500ms 模拟延迟 — 11ms` |
| AC-04 | 任务含 `[fail]`，生成一次 | 502；余额不变；`PlanResult` 不变；`started` +1、`failed` +1 | 502；余额 3→3；`PlanResult` 0；`started` 4→5 | `[PASS] AC-04 余额不变（已退还） — before=3 after=3` |
| AC-05 | 删除 `[fail]` 任务后重试 | 200；余额 2 | 200；余额 2 | `[PASS] AC-05 移除失败任务后重试成功并扣 1` |
| AC-06 | 3 额度，并发 10 个请求 | 余额 0（不为负）；`PlanResult` 3；`started` 3；3 成功 7 拒绝 | `statuses=[200,200,200,402,402,402,402,402,402,402]`；余额 0；`PlanResult` 3；`started` 6→9 | `[PASS] AC-06 10 个请求中 3 个成功、7 个 402` |
| AC-07 | 先消耗到剩 1，再并发 5 个 | 余额 0；`PlanResult` +1；`started` +1；1 成功 4 拒绝 | `statuses=[200,402,402,402,402]`；余额 0；`started` 11→12 | `[PASS] AC-07 5 个请求中 1 个成功、4 个 402` |
| AC-08 | 无 token 直接打 action | 401；`started` 不变 | 401；`started` 12→12 | `[PASS] AC-08 未登录不发起模型调用 — 12 -> 12` |
| AC-09 | 新账号打开 `/demo-app` | 页头即显示「剩余额度： 3」 | 页头显示 3 | [01-balance-3.png](docs/verification/01-balance-3.png) |
| AC-10 | 生成成功后观察页头 | 即时变 2，无需刷新 | 变 2，并弹出「本次已生成日程，剩余 2 次额度。」 | [02-after-generate.png](docs/verification/02-after-generate.png) |
| AC-11 | 余额用到 0 | 按钮禁用 + 「额度已用完」说明 | `disabled=true`，提示可见 | [03-exhausted.png](docs/verification/03-exhausted.png) |
| AC-12 | 全部用例跑完后查库 | `min(credits) >= 0` 且 `max(credits) <= 3` | 26 个账号：`min=0, max=3`，判定 `I1+I2 OK` | `psql … SELECT CASE WHEN … THEN 'I1+I2 OK'` |
| AC-13 | `hours` 传字符串 | 400；余额不变 | 400；余额 3→3 | `[PASS] AC-13 hours 类型错误返回 400 且不扣额度` |
| AC-14 | 页头显示 3、库里改成 0 后点击生成 | 命中 402 专用文案并刷新余额 | toast「额度已用完，本次未发起生成。」，页头变 0 | [04-insufficient-toast.png](docs/verification/04-insufficient-toast.png) |

AC-14 顺带验证了假设 A4：客户端能拿到 action 抛出的 `statusCode`，`DemoAppPage` 的 `err.statusCode === 402` 分支确实命中。

## 2. 日志链自洽检查

TASK 指定 `mock-ai.started` 是"已发起调用"的唯一证据，因此额外做了一次全量计数核对（同一次运行，日志为冷启动后的完整输出）：

| 事件 | 条数 | 关系 |
| --- | --- | --- |
| `credits.begin` | 25 | = `reserved` 12 + `reserve_failed` 13 |
| `credits.reserved` | 12 | 预扣成功次数 |
| `credits.reserve_failed` | 13 | 402 次数（AC-02 1 + AC-03 1 + AC-06 7 + AC-07 4） |
| `mock-ai.started` | 12 | **= `reserved`**：预扣成功才发调用，额度不足零调用 |
| `mock-ai.succeeded` | 11 | |
| `mock-ai.failed` | 1 | `succeeded + failed = started = 12` |
| `credits.committed` | 11 | |
| `credits.refunded` | 1 | `committed + refunded = reserved = 12` |
| `credits.refund_failed` | 0 | |

同一 `callId` 的完整链路（从日志原文摘出，已去 ANSI 颜色）：

```json
{"event":"credits.begin","callId":"58dbe663-…","userId":"c5748b38-…"}
{"event":"credits.reserved","callId":"58dbe663-…","userId":"c5748b38-…"}
{"event":"mock-ai.started","callId":"58dbe663-…"}
{"event":"mock-ai.succeeded","callId":"58dbe663-…"}
{"event":"credits.committed","callId":"58dbe663-…","userId":"c5748b38-…","creditsRemaining":2}
```

复现：`grep <callId> /tmp/wasp-dev.log`。

## 3. 未验证 / 已知缺口

明确标注，避免把"没跑过"写成"已通过"：

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `commit` 写库失败 → 退还（500 分支） | **仅单测覆盖** | `tests/credits.test.ts` 的 `commitPlan` 抛错用例；未在真实数据库上制造写入故障 |
| `refund` 本身失败（`credits.refund_failed`） | **仅单测覆盖** | 同上，未注入故障 |
| 进程在预扣后崩溃的窗口 | **未验证** | TASK 已排除补偿；只在 SPEC §3.4 说明后果，没有伪造证据 |
| 假设 A2（`context.user` 是否会话快照） | **未单独验证** | 方案不依赖：余额读取与落库都直接走数据库 |
| 假设 A3（生成的确切 SQL 文本） | **行为已验证，文本未核对** | 并发结果（AC-06/07）证明原子性，但没有逐条读 Prisma 生成的 SQL |
| 浏览器 E2E 纳入 CI | **未做** | Playwright 未加入依赖，只做了一次性本地复核；理由见 SPEC §8.3 |
| 多实例部署下的正确性 | **未验证** | 题面限定单服务单库；条件 UPDATE 在单库下成立，多实例需另议 |

## 4. 复现提示

1. 首次运行前 `wasp db migrate-dev`，并把 dev server 日志留到文件：`wasp start > /tmp/wasp-dev.log 2>&1`。
2. `npm run verify:quota` 默认读 `/tmp/wasp-dev.log`；日志路径不同就传 `--log`。
3. 日志不可读时，脚本会把"起步于日志的断言"标为 `SKIP`，不会伪装成 PASS。
4. 脚本每次新建 6~7 个测试账号（初始 3 额度），跑完留在开发库里；需要干净数据用 `wasp db reset`。
