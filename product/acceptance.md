# 验收案例与验证记录

> 对应需求：[PRD.md](PRD.md) ｜ 对应任务：[tasks.md](tasks.md)
> 本文件既是**验收标准**（给实现者），也是**本次的验证记录**（给评审）。两件事共用一套编号，不另写一份。

## 0. 本次验证状态

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 原型六种界面状态的规则走查 | **已执行** | 无头 Edge 驱动真实 DOM，26 项断言全部通过，明细见 §4 |
| 原型视觉与交互 | **已执行** | 三张截图见 [初始](screenshot-initial.png) / [成功](screenshot-success.png) / [并发](screenshot-concurrency.png) |
| 真实应用的端到端行为 | **未执行** | 本次为产品方向，未提交实现；且本机为 Windows，启动 Wasp 需要 WSL2 与 PostgreSQL，见 §5 |
| 服务端并发（真实数据库） | **未执行** | 依赖 T1-T3 落地后才能验；原型里的并发为单线程模拟，不能替代 |

**注意**：§3 中标为"现状失败"的案例，是对**当前代码**的判定（依据文件与行号，见 PRD §2），不是本次运行出来的结果。

## 1. 观察方法

验收只认这三处证据，任何一条都可以单独取证：

| 证据 | 怎么取 | 看什么 |
| --- | --- | --- |
| 模型调用次数 | `wasp start` 终端里的日志，或用 `grep -c '"event":"mock-ai.started"' server.log` | 条数必须等于"成功次数"。**这是判定"额度不足时是否发起调用"的唯一硬指标** |
| 额度与结果 | `wasp db studio`，或 psql 执行下面两条 | `credits` 是否等于"初始 - 成功次数"，且永不为负；`PlanResult` 条数是否等于成功次数 |
| 用户可见反馈 | 页面上的 toast、按钮状态、额度徽标 | 是否说清"成了没有 / 扣没扣 / 还剩几次 / 下一步" |

```sql
-- 把 <uid> 换成测试账号的 User.id
SELECT credits FROM "User" WHERE id = '<uid>';
SELECT count(*) FROM "PlanResult" WHERE "userId" = '<uid>';
```

**准备测试账号**：注册后初始 `credits = 3`；用 `wasp db studio` 把 `credits` 改成 0 或 1 造场景，改完刷新页面。失败场景靠添加一条含 `[fail]` 的任务触发，**测成功场景前必须删掉它**，否则整轮都会失败。

## 2. 案例索引

| 编号 | 场景 | 关联规则 | 优先级 | 现状 |
| --- | --- | --- | --- | --- |
| AC-01 | 首次成功 | R1、R5 | P0 | 扣减正确，但无剩余次数提示 → 部分失败 |
| AC-02 | 额度为 0 | R2 | P0 | 失败：仍发起调用 |
| AC-03 | 模型明确失败 | R3 | P0 | 净消耗正确（靠提前 throw），但无可读提示 |
| AC-04 | 连续生成到耗尽 | R1、R2 | P0 | 失败：第 4 次仍调用模型 |
| AC-05 | 余额 1 并发 3 | R4、R6 | P0 | 失败：`credits` 变负 |
| AC-06 | 余额 3 并发 5 | R4、R6 | P1 | 失败：同上 |
| AC-07 | 并发中全部失败 | R3、R4 | P1 | 失败 |
| AC-08 | 失败后重试成功 | R3 | P0 | 通过（净消耗为 0） |
| AC-09 | 快速双击 | R1 | P1 | 待验：UI 有 loading，但状态异步可能双发 |
| AC-10 | 未登录 | — | P1 | 通过（401 + 跳登录） |
| AC-11 | 写入与扣减同成同败 | R1 | P2 | 需代码审查 |
| AC-12 | 刷新后额度一致 | R5 | P1 | 未实现（页面无额度展示） |

## 3. 案例详情

### AC-01 首次成功

- **前置**：新账号，`credits = 3`，2 条普通任务，无 `[fail]`
- **操作**：点「生成日程」，等待返回
- **预期**：页面出现日程卡片（每条任务 3 个子项）；`credits = 2`；`PlanResult` +1；`mock-ai.started` +1；提示 `日程已生成 / 本次消耗 1 次额度，剩余 2 次`；徽标显示 `2 / 3`
- **证据**：日志条数、SQL 两条、toast 文案

### AC-02 额度为 0

- **前置**：`credits = 0`，有任务
- **操作**：A. 直接看按钮；B. 绕过界面直接调用生成 action（控制台或脚本）
- **预期**：A. 按钮置灰不可点，徽标 `0 / 3`，悬停说明"调整任务后可稍后再试"；B. 返回 402，**`mock-ai.started` 不新增**，`credits` 仍为 0，`PlanResult` 不变，提示 `额度已用完 / 本次未生成，也未消耗额度`
- **现状**：B 会先打一条 `mock-ai.started` 再返回 402（[operations.ts L48-L49](../src/demo-ai-app/operations.ts#L48-L49) 早于 [L67](../src/demo-ai-app/operations.ts#L67)）

### AC-03 模型明确失败

- **前置**：`credits = 2`，任务中有一条含 `[fail]`
- **操作**：点「生成日程」
- **预期**：返回失败，提示 `生成失败，本次未扣额度 / 剩余额度 2 次不变`；`credits` 仍为 2；`PlanResult` 不新增；`mock-ai.started` 与 `mock-ai.failed` 各 +1，且两条 `callId` 相同；旧日程若存在，上方出现 `以下为上次成功生成的结果（时间）`
- **现状**：`credits` 正确不变（异常在扣减之前抛出），但页面只弹 `Error: Mock provider explicitly rejected the request`，且旧日程仍原样显示（D5）

### AC-04 连续生成到耗尽

- **前置**：`credits = 3`，普通任务
- **操作**：连续点 3 次生成，第 4 次再点
- **预期**：前 3 次成功，`credits = 0`，`PlanResult = 3`，`mock-ai.started = 3`；第 4 次按钮已不可点（或返回 402），`mock-ai.started` 仍为 3
- **现状**：第 4 次会先调用模型再报 402

### AC-05 余额 1 并发 3（核心）

- **前置**：`credits = 1`，普通任务
- **操作**：同一账号同时发起 3 个生成请求（三个标签页同时点，或 `scripts/verify-concurrency.mjs --credits 1 --requests 3`）
- **预期**：1 个成功、2 个返回 402；`credits = 0`（**不允许为负**）；`PlanResult` +1；`mock-ai.started` = 1
- **现状**：三个请求都通过 `credits > 0` 判断，三次 `decrement` → `credits = -2`，产出 3 份结果
- **判定**：`credits >= 0` 与 `started === 成功数` 同时成立才算通过

### AC-06 余额 3 并发 5

- **前置**：`credits = 3`
- **操作**：同时发起 5 个请求
- **预期**：3 成功 2 失败；`credits = 0`；`PlanResult = 3`；`mock-ai.started = 3`

### AC-07 并发中模型全部失败

- **前置**：`credits = 3`，任务中含 `[fail]`
- **操作**：同时发起 3 个请求
- **预期**：3 个都失败；`credits = 3`（全部退款，净消耗 0）；`PlanResult` 不新增；`mock-ai.started = 3`、`mock-ai.failed = 3`
- **用途**：专门验退款路径在并发下不会多退或少退，这是预扣方案最容易出错的地方

### AC-08 失败后重试成功

- **前置**：`credits = 3`，含 `[fail]` 任务
- **操作**：生成（失败）→ 删除 `[fail]` 任务 → 再生成
- **预期**：`credits` 依次为 3 → 3 → 2，`PlanResult` 为 0 → 0 → 1

### AC-09 快速双击

- **前置**：`credits = 3`
- **操作**：在 100ms 内连点两次生成
- **预期**：`mock-ai.started` 只 +1，`credits` 只 -1；界面只出现一次"生成中"
- **现状**：待验证。`isPlanGenerating` 的置位是异步的，第二次点击可能抢在重渲染之前发出

### AC-10 未登录

- **前置**：退出登录
- **操作**：直接访问首页或调用生成
- **预期**：跳转登录页 / 返回 401；`credits` 不变，无模型调用

### AC-11 写入与扣减同成同败

- **前置**：代码审查（难以在界面构造写失败）
- **操作**：检查 `PlanResult.create` 与额度扣减是否在同一事务内
- **预期**：不存在"写了结果但没扣额度"或"扣了额度但没写结果"的中间态；若失败则整体回滚，且退款只发生一次
- **证据**：代码位置与事务边界，评审时指出具体行号

### AC-12 刷新后额度一致

- **前置**：任意状态
- **操作**：生成一次 → 刷新页面
- **预期**：徽标显示的数字与 `SELECT credits FROM "User"` 一致；不出现"前端本地累加"导致的偏差

## 4. 本次已执行的验证：原型规则走查

**做了什么**：把 [prototype.html](prototype.html) 载入无头 Edge（真实浏览器、真实 DOM），注入一段断言脚本，按 AC-01/02/03/04/05/06/09/12 的顺序驱动界面与并发入口，读取 `credits`、`started`、`PlanResult`、徽标与 toast 文本。

**怎么复现**（无需安装任何依赖）：

```bash
# 1. 用浏览器打开原型
start product/prototype.html          # Windows；macOS 用 open
# 2. 打开开发者工具 Console，粘贴下面这段（节选 4 条核心断言），回车
```

```js
const P = window.__proto, $ = (id) => document.getElementById(id);
const reset = () => $("resetBtn").click();
const out = [];
const check = (n, c, d) => out.push([c ? "PASS" : "FAIL", n, d].join("  "));

reset();
await P.clickGenerate();
check("AC-01 credits 3->2", P.state.credits === 2, P.state.credits);
check("AC-01 started/plans=1", P.state.started === 1 && P.state.plans === 1, P.state.started + "/" + P.state.plans);

reset(); $("failToggle").click(); P.state.credits = 2;
await P.clickGenerate();
check("AC-03 失败净消耗0", P.state.credits === 2 && P.state.plans === 0, P.state.credits + "/" + P.state.plans);

reset(); P.state.credits = 1;
await P.runConcurrent(3);
check("AC-05 不为负且只成功1次", P.state.credits === 0 && P.state.plans === 1 && P.state.started === 1,
      P.state.credits + "/" + P.state.plans + "/" + P.state.started);

console.log(out.join("\n"));
```

**结果**：完整走查 26 项断言，26 通过，0 失败；上面节选的 4 条在本地实际执行结果如下（原样输出）：

```
PASS  AC-01 credits 3->2  2
PASS  AC-01 started/plans=1  1/1
PASS  AC-03 失败净消耗0  2/0
PASS  AC-05 不为负且只成功1次  0/1/1
```

关键数值汇总：

| 断言组 | 实际观测 |
| --- | --- |
| AC-01 首次成功 | `credits` 3→2，`PlanResult` 1，`started` 1，徽标 `2 / 3`，toast「本次消耗 1 次额度，剩余 2 次」 |
| AC-02 额度 0 | 按钮 `disabled=true`，文案「额度已用完」；直调返回 `402`，`started` 0→0 |
| AC-03 模型失败 | `credits` 保持 2，`PlanResult` 0，`started` 1，toast 含「本次未扣额度」 |
| AC-04 连续耗尽 | 3 次后 `credits=0`，按钮转「额度已用完」，第 4 次 `402`，`started` 仍为 3 |
| AC-05 余额 1 并发 3 | `credits=0`，`PlanResult=1`，`started=1` |
| AC-06 余额 3 并发 5 | `credits=0`，`PlanResult=3`，`started=3` |
| AC-09 双击 | `started=1`，`credits` 只减 1 |
| AC-12 徽标一致 | 徽标 `2 / 3` 与 `state.credits` 一致 |

**这份验证证明了什么、没证明什么**（必须写清楚，否则会误导接手者）：

- 证明了：规则顺序（预扣先于调用）、三态文案、按钮与徽标的联动、并发下"成功数不超过余额"的**逻辑**是对的。
- 没有证明：真实数据库下的并发安全。原型是单线程 JS，预扣是同步执行，天然不会竞争；真实环境里这个性质必须由一条带条件的 `UPDATE` 提供。**原型不能替代 AC-05/AC-06 在服务端的验证。**

## 5. 未验证项与原因

| 未验证项 | 原因 | 谁来补 |
| --- | --- | --- |
| 真实应用的端到端流程 | 产品方向不交实现；本机为 Windows，`README.md` 要求 WSL2 + PostgreSQL 才能跑 Wasp | 技术方向实现者，按 AC 全跑一遍 |
| 服务端并发与退款原子性 | 依赖 T2、T3 落地 | 实现者，用 T8 的脚本，附 `credits` 与日志条数 |
| AC-11 事务边界 | 需要看最终实现代码 | 代码评审 |
| AC-09 真实前端是否双发 | 需要 React 真实状态时序 | 实现者，快速双击观察日志 |
