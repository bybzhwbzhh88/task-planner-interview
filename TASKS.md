# 开发任务拆解：额度有据 V2

> 状态：本文是**产品方向**的工程交接稿。仓库内应用源码未修改，T1–T7 均未开始，真实后端、数据库与并发均未验证。
>
> 需求与取舍见 [SPEC.md](SPEC.md)；验收口径与现有原型证据见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 0. 完成标准

全部任务完成后，应满足：

1. `generatePlan` 在调用模拟模型**之前**完成一次原子预占；余额不足时影响 0 行，且本次尝试没有 `mock-ai.started`。
2. 成功净扣 1；模型明确失败或 `PlanResult` 保存失败时返还，净扣 0；余额永不为负。
3. 同账号真实并发下，成功数不超过预占前余额；AC-04、AC-05 由可重复执行的脚本验证。
4. 用户能看到余额、本次变动、`attemptId` 与下一步；未知错误不谎称“未扣费”。
5. `SPEC.md`、`ACCEPTANCE.md` 与实现、日志、截图一致；未验证项明确标注。

不要修改数据模型，不引入支付/幂等/崩溃补偿，不升级 Wasp 或 Prisma，不删除现有 `[fail]` 注入能力。

## 1. 文件地图

| 文件 | 动作 | 责任 |
| --- | --- | --- |
| `src/demo-ai-app/operations.ts` | 修改 | `getCreditBalance`；`generatePlan` 编排鉴权、参数读取、预占、调用、保存、返还 |
| `src/demo-ai-app/quotaTypes.ts` | 新建 | 客户端与服务端共享的结果联合类型，不含运行时依赖 |
| `src/demo-ai-app/quota.ts` | 新建 | 条件预占、返还、`attemptId` 与结构化额度日志 |
| `src/demo-ai-app/mockAi.ts` | 修改 | 接收 `attemptId`；用专门的错误类表达模型明确失败 |
| `src/demo-ai-app/demo-ai-app.wasp.ts` | 修改 | 声明 `getCreditBalance` 查询；确认 User 实体声明 |
| `src/demo-ai-app/DemoAppPage.tsx` | 修改 | 余额、预检、生成中、回执、重试、旧日程标注、状态区 |
| `src/client/App.tsx` | 修改 | 页头余额改为查询结果；未登录时不请求额度 |
| `scripts/verify-quota-concurrency.mjs` | 新建 | 发起真实并发请求，断言状态、余额和日志口径 |
| `docs/evidence/` | 追加 | 保存真实实现阶段的后端、界面与脚本运行证据 |

## 2. 任务依赖

| 编号 | 任务 | 依赖 | 对应验收 | 状态 |
| --- | --- | --- | --- | --- |
| T1 | 余额查询与页头接真 | - | AC-01, AC-06, AC-07 | 未开始 |
| T2 | 原子预占与结果契约 | T1（可并行启动） | AC-02, AC-04, AC-05 | 未开始 |
| T3 | 结算、失败返还与保存失败 | T2 | AC-01, AC-03 | 未开始 |
| T4 | 回执、状态与预检界面 | T1, T2 | AC-01–AC-03, AC-06, AC-08 | 未开始 |
| T5 | 日志、错误分类与兜底 | T2, T3 | AC-02, AC-03, AC-08 | 未开始 |
| T6 | 真并发、回归与证据 | T1–T5 | AC-01–AC-07 | 未开始 |
| T7 | 文档、检查与公开交付 | T6 | 全部 | 未开始 |

推荐顺序是 T1 → T2 → T3 → T4 → T5 → T6 → T7。T4 可以在 T3 完成前先接假数据做静态检查，但验收必须等 T3 接通。

---

## T1. 余额查询与页头接真

**目标**：页面所有余额都来自服务端查询，不再把 `useAuth().user.credits` 当作权威值。

**文件**

- 修改 `src/demo-ai-app/operations.ts`：新增查询。
- 修改 `src/demo-ai-app/demo-ai-app.wasp.ts`：导入并声明查询。
- 修改 `src/client/App.tsx`：页头显示查询余额。
- 修改 `src/demo-ai-app/DemoAppPage.tsx`：暴露 `refetch` 给 T4 使用。

**接口**

```ts
export const getCreditBalance: GetCreditBalance<
  void,
  { credits: number }
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  const user = await context.entities.User.findUnique({
    where: { id: context.user.id },
    select: { credits: true },
  });
  if (!user) {
    throw new HttpError(401);
  }
  return { credits: user.credits };
};
```

```ts
import { getCreditBalance } from "./operations" with { type: "ref" };

query(getCreditBalance, { entities: ["User"] }),
```

页头只在已登录时挂载查询组件，避免登录页触发 401：

```tsx
{user && <CreditBalance />}

function CreditBalance() {
  const { data } = useQuery(getCreditBalance);
  return <span>剩余额度：{data?.credits ?? "—"}</span>;
}
```

`DemoAppPage` 同样只在该路由（已要求登录）内查询。加载中显示“—”，不要先用 0 占位。

**验证**

1. `wasp compile` 后确认生成 `GetCreditBalance` 类型，两个 `tsc` 命令通过。
2. 用 db studio 把测试账号余额依次改为 3、1、0，刷新后页头分别显示 3、1、0。
3. 记录 Wasp 0.25 在 action 完成后是否自动刷新该查询。若不刷新，保留 `refetch`，并在 T4 的每次结算后显式调用。
4. 未登录打开 `/demo-app` 应被路由拦到登录页，网络面板无额度查询。

**完成定义**：页头不再读取 `user.credits`；余额查询有 401；加载态不是假 0；失效行为有记录。

---

## T2. 原子预占与结果契约

**目标**：把“先调用、后检查”改为“先预占、后调用”，并把可预期结果变成稳定的领域对象。

**文件**

- 新建 `src/demo-ai-app/quotaTypes.ts`、`src/demo-ai-app/quota.ts`。
- 修改 `src/demo-ai-app/operations.ts`、`src/demo-ai-app/mockAi.ts`。
- 修改 `src/demo-ai-app/DemoAppPage.tsx`：只做最小兼容，完整界面在 T4。

**契约**

```ts
// quotaTypes.ts
import type { GeneratedSchedule } from "./schedule";

export type GeneratePlanResult =
  | { status: "success"; attemptId: string; schedule: GeneratedSchedule }
  | { status: "insufficient_credits"; attemptId: string }
  | { status: "provider_failed"; attemptId: string }
  | { status: "save_failed"; attemptId: string };
```

不要把 `creditsRemaining` 放进结果。余额由 `getCreditBalance` 读取。

**预占**

`quota.ts` 必须用单条条件更新，不允许先读余额再判断：

```ts
export async function reserveCredit(userId: string): Promise<boolean> {
  const { count } = await prisma.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  return count === 1;
}
```

`updateMany` 会生成一条 `UPDATE ... WHERE id = ? AND credits > 0`；同一行的并发更新由 PostgreSQL 串行化。`count === 0` 即余额不足。

**`generatePlan` 顺序**

1. 鉴权；校验 `hours` 为数值。缺失、字符串或其他类型返回 400；本期不新增业务范围限制。
2. 读取当前用户任务。
3. 生成 `attemptId`（`attempt_` + `randomUUID()`），记录 `quota.attempt.started`。
4. 调 `reserveCredit(context.user.id)`。
5. 返回 false：记录 `quota.rejected` 和 `quota.settled`，返回 `{ status: "insufficient_credits", attemptId }`。**此处直接返回，不调用模型、不写 PlanResult。**
6. 返回 true：记录 `quota.reserved`，进入 T3。

**模拟模型**

在 `mockAi.ts` 中区分“明确失败”和未知异常：

```ts
export class MockProviderError extends Error {}

export async function generateMockSchedule(
  tasks: Pick<Task, "description" | "time">[],
  hours: number,
  attemptId: string,
): Promise<GeneratedSchedule> {
  const callId = randomUUID();
  console.info(JSON.stringify({ event: "mock-ai.started", attemptId, callId }));
  // ...
  if (tasks.some((task) => task.description.includes("[fail]"))) {
    console.info(JSON.stringify({ event: "mock-ai.failed", attemptId, callId }));
    throw new MockProviderError("Mock provider explicitly rejected the request");
  }
  // ...
}
```

现有 `generatedSchedule === null` 分支不可达，可删除；不要把它当作失败路径。

**验证**

- 余额 0：action 返回 `insufficient_credits`；`mock-ai.started` 为 0；`PlanResult` 数量不变。
- 余额 3：返回 `success`；日志中 `quota.reserved` 早于 `mock-ai.started`。
- 测试用两个服务端请求同时进入时，预占结果必须一个 true、一个 false；在 T6 前只能视为数据库逻辑自测，不能宣称已通过并发验收。

**完成定义**：业务失败不再用 402/502；零额度路径确定性地不调用模型；结果类型被客户端消费。

---

## T3. 结算、失败返还与保存失败

**目标**：每次预占都有唯一结局：核销（成功）或返还（明确失败），且不能声称未发生的返还。

**文件**：`src/demo-ai-app/operations.ts`、`src/demo-ai-app/quota.ts`。

**返还原语**

```ts
export async function refundCredit(userId: string): Promise<boolean> {
  const { count } = await prisma.user.updateMany({
    where: { id: userId },
    data: { credits: { increment: 1 } },
  });
  return count === 1;
}
```

**分支**

| 分支 | 动作 | 返回 | 日志 |
| --- | --- | --- | --- |
| 模型成功 + 保存成功 | 保留预占 | `success` + 日程 | `plan.saved`、`quota.settled` |
| 模型抛出 `MockProviderError` | 返还 1 | `provider_failed` | `mock-ai.failed`、`quota.refunded`、`quota.settled` |
| `PlanResult.create` 失败 | 返还 1 | `save_failed` | `plan.save.failed`、`quota.refunded`、`quota.settled` |
| 预占后发生其他异常 | 尽力返还；无论结果如何都抛出 500 | 500 | `quota.refunded`（reason `unknown_error`）或 `quota.refund.failed`；**不记 `quota.settled`** |

关键约束：

- **返还失败时不得返回 `provider_failed` / `save_failed`。** 记 `quota.refund.failed` 并抛 500，让客户端进入 S7“额度状态待确认”。
- 未知异常不能包装成已知失败；可以尝试返还，但用户文案仍是“待确认”，不能声称“未扣费”；未知异常返回 500 时不写 `quota.settled`。
- 不把模型调用和数据库写入放进同一个数据库事务；长事务持锁会放大并发问题。
- 保存必须在额度核销前确认成功。代码上预占已经扣减，因此“保存失败 → 返还”是核销前的补偿，不要误解为第二次扣费。

**验收用注入（默认关闭）**

为了能真实执行保存失败与未知异常路径，在 `operations.ts` 读取 `process.env.QUOTA_TEST_INJECT`，仅接受两个值：

- `save_failure`：在保存 `try` 块内、调用 `PlanResult.create` 前抛出普通 `Error`，使其被保存失败分支捕获并返还。
- `unknown_after_reserve`：在模型调用 `try` 块内、调用 `generateMockSchedule` 前抛出普通 `Error`，使其进入未知异常分支、尽力返还并返回 500。

该开关只能由服务进程环境变量设置，不能由请求参数或任务正文触发；不得在部署环境设置。每次注入测试后必须重启服务并取消变量。

**伪代码**

```ts
if (!(await reserveCredit(user.id))) {
  return insufficient(attemptId);
}

let schedule: GeneratedSchedule;
try {
  schedule = await generateMockSchedule(tasks, hours, attemptId);
} catch (error) {
  if (error instanceof MockProviderError) {
    return await refundAndReturn(user.id, attemptId, "provider_failed");
  }
  await refundBestEffort(user.id, attemptId);
  throw error;
}

try {
  await context.entities.PlanResult.create({
    data: { user: { connect: { id: user.id } }, content: JSON.stringify(schedule) },
  });
} catch (error) {
  return await refundAndReturn(user.id, attemptId, "save_failed");
}

logQuotaEvent("plan.saved", { attemptId });
logQuotaEvent("quota.settled", { attemptId, status: "success" });
return { status: "success", attemptId, schedule };
```

**验证**

- 正常：余额 3 → 2，`PlanResult` +1，无 `quota.refunded`。
- `[fail]`：余额不变，`PlanResult` 不增加，有一条 `quota.refunded`。
- 保存失败：以 `QUOTA_TEST_INJECT=save_failure` 启动服务，1 个请求应返回 `save_failed`、余额不变且只返还 1 次；测试后取消变量并重启。
- 未知异常：以 `QUOTA_TEST_INJECT=unknown_after_reserve` 启动服务，1 个请求应返回 500；若返还确认，日志有 `quota.refunded`（reason `unknown_error`），否则有 `quota.refund.failed`；两种情况下都不得出现“已返还”的用户断言，也不得出现 `quota.settled`。
- 返还失败：用测试桩让返还 count 为 0，确认抛错且不出现“已返还”文案；在 ACCEPTANCE 标注未验证，除非有运行证据。

**完成定义**：三个已实现结果都能沿日志对账；失败路径没有“用户拿不到日程却扣费”。

---

## T4. 回执、状态与预检界面

**目标**：用户能看懂本次发生了什么、余额为什么变了、下一步做什么。

**文件**：`src/demo-ai-app/DemoAppPage.tsx`；必要时在 `src/client/App.tsx` 复用余额查询。

**状态来源**

```ts
type UiGeneratePlanResult =
  | GeneratePlanResult
  | { status: "unknown" }; // 仅客户端显示态，不进入服务端契约
```

- 余额：`useQuery(getCreditBalance)` 的 `data` 与 `refetch`。
- 生成结果：本地 `lastResult: UiGeneratePlanResult | null`。
- 旧日程：本地保留上一次成功日程；发起新尝试时把它标为“上次日程”。
- 生成中：本地 `isPlanGenerating`，同时设置按钮 `aria-busy`。

**必须实现的界面规则**

1. **预检**：余额为 0 时主按钮禁用、文案“额度已用完”，显示常驻警告。余额为 1 时展示“这是最后 1 个额度；本次成功后额度将用完。”
2. **成本**：按钮附近常驻“每次成功生成消耗 1 个额度”，不使用确认弹窗。
3. **请求**：点击后立即禁用并显示“生成中…”。失败回执中的“重试本次生成”在生成中同样禁用。
4. **结算后刷新**：无论成功、拒绝还是失败，都 `await refetch()`。不要把 action 返回的快照当余额。
5. **回执**：常驻 `role="status"` / `aria-live="polite"` 区域，包含标题、本次变动、当前余额、`attemptId`、下一步。字段与文案严格按 [SPEC.md §4.2–4.3](SPEC.md#42-状态与文案)。
6. **成功**：把结果标题设为“本次日程”；旧结果被新结果替换。
7. **失败 / 拒绝**：保留旧日程并标为“上次日程”，避免被误认为本次生成。
8. **未知异常**：捕获非领域结果，进入 S7；不显示任何“未扣费/已返还”断言。
9. **可访问性**：错误信息不只靠颜色；键盘可操作重试；焦点不会被生成中禁用状态移走。

**关键分支**

```tsx
try {
  setIsPlanGenerating(true);
  setPreviousSchedule(schedule);
  setLastResult(null);
  const result = await generatePlan({ hours: todaysHours });
  setLastResult(result);
  if (result.status === "success") {
    setSchedule(result.schedule);
  }
} catch {
  setLastResult({ status: "unknown" });
} finally {
  await refetchCreditBalance();
  setIsPlanGenerating(false);
}
```

`unknown` 不要加入 `GeneratePlanResult`，以免服务端把未知异常伪装成正常结果。

**验证**：逐项走 AC-01、AC-02、AC-03、AC-06、AC-08；检查 DOM 状态区、按钮禁用、余额查询 refetch 和旧日程标注。截图存入 `docs/evidence/`，命名见 ACCEPTANCE。

**完成定义**：没有仅靠 toast 的额度反馈；每次结果都有 `attemptId` 和一个可执行下一步；零余额不会仍显示可生成。

---

## T5. 日志、错误分类与兜底

**目标**：用同一 `attemptId` 串起产品回执与支持日志，并能从日志证明“被拒绝的请求没有调用模型”。

**事件**

| 事件 | 何时写 | 必需字段 |
| --- | --- | --- |
| `quota.attempt.started` | 鉴权与参数校验后 | `attemptId` |
| `quota.reserved` | 条件更新影响 1 行 | `attemptId` |
| `quota.rejected` | 条件更新影响 0 行 | `attemptId`, `reason: "insufficient_credits"` |
| `mock-ai.started` / `succeeded` / `failed` | 模拟接口 | `attemptId`, `callId` |
| `plan.saved` | `PlanResult` 创建成功 | `attemptId` |
| `plan.save.failed` | `PlanResult` 创建失败，进入返还 | `attemptId`, `error` |
| `quota.refunded` | 返还确认成功 | `attemptId`, `reason`（`provider_failed` / `save_failed` / `unknown_error`） |
| `quota.refund.failed` | 应返还但更新失败 | `attemptId`, `reason`, `error` |
| `quota.settled` | 返回领域结果的已分类结局 | `attemptId`, `status` |

- 全部为单行 JSON：`console.info(JSON.stringify({ event, ...fields }))`。
- 不记录任务正文、邮箱、完整请求体或其他个人信息。
- `mock-ai.started` 只在预占成功后出现。验收时按 `attemptId` 分组检查。
- 未知错误：记录 `error.name` / `message` 摘要，不记录堆栈中的敏感数据；客户端统一 S7。未知异常返回 500，不写 `quota.settled`；返还结果按实际写 `quota.refunded` 或 `quota.refund.failed`。

**验证**

```sh
grep -E '"event":"(quota|mock-ai)\.' /tmp/wasp.log | tail -n 80
```

对一次余额 0 的请求，日志应包含 `quota.attempt.started`、`quota.rejected`、`quota.settled`，且该 `attemptId` 下没有 `mock-ai.started`。对一次 `[fail]` 请求，应包含 started、reserved、mock-ai.started/failed、refunded、settled，且没有 `plan.saved`。对一次 `unknown_after_reserve` 注入请求，应包含 started、reserved、refunded/refund.failed，且没有 settled。

**完成定义**：回执上的 `attemptId` 能在日志中定位完整链路；没有“被拒绝却出现模型调用”的记录。

---

## T6. 真并发、回归与证据

**目标**：在 Wasp + PostgreSQL 上真实执行并发请求，不把单线程模拟器当证据。

**前置**

1. 按 `README.md` 启动 PostgreSQL、迁移与 `wasp start`；服务端日志重定向到文件。
2. 注册独立测试账号，创建至少一条普通任务；用 `wasp db studio` 把余额设为场景要求值。
3. 在浏览器 Network 面板确认 Wasp 0.25 的 action 实际 HTTP 路径、请求格式与会话 cookie。Wasp 版本间可能有差异，**不要凭猜测写死**；同时确认余额查询能否用同一 cookie 调用。
4. 新建 `scripts/verify-quota-concurrency.mjs`，只依赖 Node 24 内置 `fetch`。并发请求必须由脚本在同一时刻发出，不能通过连续点击按钮代替。

**脚本接口**

```sh
BASE_URL=http://localhost:3000 \
SESSION_COOKIE='<从浏览器复制的完整 cookie>' \
GENERATE_PATH='<Network 面板确认的 action 路径>' \
BALANCE_PATH='<Network 面板确认的余额查询路径>' \
INITIAL=1 REQUESTS=2 \
WASP_LOG=/tmp/wasp.log \
node scripts/verify-quota-concurrency.mjs
```

脚本输出一行 JSON：HTTP 状态列表、领域 `status` 计数、最终余额、按 attemptId 统计的日志事件、断言结果；任一断言失败时退出码非 0。证据中不得包含 cookie。

**AC-04：余额 1，2 个并发请求**

预期：成功 1、额度不足 1、`mock-ai.started` 1、`PlanResult` +1、最终余额 0、`credits >= 0`；没有 500。`quota.rejected` 的 attempt 下不得出现 `mock-ai.started`。至少连续重置并执行 5 轮。

**AC-05：余额 3，5 个并发请求**

预期：成功 3、额度不足 2、`mock-ai.started` 3、`PlanResult` +3、最终余额 0、`credits >= 0`；没有 500。至少连续重置并执行 3 轮。每次都要确认最终余额先设为 3。

**AC-03 回归：余额 2，任务含 `[fail]`，1 个请求**

预期：`provider_failed`；最终余额 2；`mock-ai.started` 1；`quota.refunded` 1；`PlanResult` 不增加。

**其他回归**

- 余额 0：1 个请求返回 `insufficient_credits`；`mock-ai.started` 0。
- 正常成功：余额 3 → 2；`PlanResult` +1。
- AC-07 刷新一致：成功请求后用同一 cookie 调用 `BALANCE_PATH`，返回值应等于数据库余额与刷新后的页头；同时确认日程在刷新后仍可见。
- 未登录：不带会话请求被拒绝，不扣额度、不调用模型。
- 非法 `hours`：`hours: "abc"` 与缺失 `hours` 均返回 400，不预占、不调用模型。
- 保存失败：以 `QUOTA_TEST_INJECT=save_failure` 重启服务，1 个请求返回 `save_failed`，余额不变，出现 1 次 `quota.refunded`；测试后取消变量。不得用纯代码阅读代替运行证据。
- 未知异常：以 `QUOTA_TEST_INJECT=unknown_after_reserve` 重启服务，1 个请求返回 500；按实际结果出现 `quota.refunded`（reason `unknown_error`）或 `quota.refund.failed`，不出现 `quota.settled`；界面进入 S7，不显示“未退费/已返还”断言。测试后取消变量。

**证据保存**

- 运行输出脱敏后保存为 `docs/evidence/t6-concurrency-*.json`（不要提交 cookie）。
- 页面成功/失败/零额度截图保存为 `docs/evidence/ac-*.png`。
- 日志片段只保留事件名、attemptId 与计数，不保留用户信息。
- 把每条 AC 的实际结果写回 [ACCEPTANCE.md](ACCEPTANCE.md)，包含运行命令和证据链接。

**完成定义**：AC-04 与 AC-05 的多次真实并发全部通过；有脚本、有输出、有日志计数；失败路径与顺序路径回归通过。只有此时才能对外声明“并发不透支”。

---

## T7. 文档、检查与公开交付

**目标**：让评审能从 PR 一次看懂结论、验证和未完成项。

1. 更新 `SPEC.md`：实现状态、Wasp 查询失效结论、实际日志字段与最终行为一致。
2. 更新 `ACCEPTANCE.md`：每项从“未验证”改为“已验证”，附命令、实际值、证据；未运行的保存失败/未知异常保持明确未验证。
3. 更新 `SUBMISSION.md`：填写称呼、方向、打码手机号；结果概览、交付入口、验证记录、未完成交接。不得写完整手机号或其他敏感信息。
4. 更新 `prototype/README.md` 中若有与实际证据不符的说明；原型仍标明模拟环境。
5. 执行并保存输出：

```sh
wasp compile
npx tsc --project tsconfig.src.json --noEmit
npx tsc --project tsconfig.wasp.json --noEmit
git diff --check
```

6. 隐私与占位检查：只扫描本次新增/修改文件，禁止完整手机号、测试 cookie、个人邮箱和未完成标记。过程草稿与临时测试脚本不进入 PR。
7. PR 标题严格为 `产品｜{称呼}｜{前三位}****{后四位}`；PR 描述列出结论、验证摘要、证据链接、明确未完成项。提交前再次打开所有截图和文档链接。

**完成定义**：干净分支、可重复的验证说明、无敏感信息、所有链接可达；PR 中没有任何“已验证”但没有证据的声明。

---

## 3. 验收映射

| 验收 | 主任务 | 关键证据 |
| --- | --- | --- |
| AC-01 成功净扣 1 | T2, T3, T4, T6 | 余额 3→2；日志 started < reserved < mock-ai.started |
| AC-02 零额度不调用 | T2, T4, T5, T6 | rejected；同 attempt 无 mock-ai.started；PlanResult 不增 |
| AC-03 失败返还 | T3, T4, T5, T6 | 余额不变；refunded 1；无 plan.saved |
| AC-04 1 额度 2 请求 | T2, T6 | 1 success / 1 insufficient / 1 started / 余额 0 |
| AC-05 3 额度 5 请求 | T2, T6 | 3 success / 2 insufficient / 3 started / 余额 0 |
| AC-06 回执与下一步 | T4 | 标题、变动、余额、attemptId、下一步、旧日程 |
| AC-07 余额刷新一致 | T1, T4, T6 | 页面余额等于查询/数据库值 |
| AC-08 鉴权、参数、未知兜底 | T2, T4, T5 | 401/400 不扣费；未知错误 S7 不说已返还 |

## 4. AI 接手提示

```text
先读 SPEC.md 和 ACCEPTANCE.md，打开 prototype/index.html 跑 P1–P4。
按 TASKS.md 顺序实现，先从 T1 开始；T2 的预占必须是单条条件更新，
不能先读再判断。每完成一个任务，运行其“验证”步骤并更新 ACCEPTANCE
的实际结果；未跑的检查保持“未验证”。不要修改范围外的数据模型或依赖。
```
