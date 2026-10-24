# 验收案例

每条案例含：前置条件、操作、可观察的预期结果。对应用户规则见 [requirements.md §2.1](./requirements.md)。

通用前置：本地 `wasp start db` + `wasp start` 已起，浏览器登录一个测试账号；`wasp db studio` 可随时查看 `User.credits` 真实值。

---

## C1. 正常生成成功，扣 1 额度

- **前置**：测试账号 `credits = 3`（可用 `wasp db studio` 设置）。
- **操作**：添加任意任务（不含 `[fail]`），点击"生成日程"，等待 500ms。
- **预期**：
  1. 页面展示生成的日程；toast 显示"生成成功，剩余 2 次"。
  2. 服务端日志出现一次 `mock-ai.started` 和一次同 `callId` 的 `mock-ai.succeeded`。
  3. `wasp db studio` 中该账号 `credits` 由 3 变为 2。
  4. 页面"剩余额度"显示 2。

## C2. 额度不足，不发起模型调用

- **前置**：测试账号 `credits = 0`。
- **操作**：页面已有任务，点击"生成日程"。
- **预期**：
  1. 不转圈或极短返回，toast"额度已用完"，且说明本次未调用模型、未扣额度。
  2. 服务端日志**不出现**新的 `mock-ai.started`。
  3. `credits` 保持 0，不出现负数。
  4. "生成日程"按钮呈禁用/"额度已用完"态。

## C3. 模型明确失败，不扣额度

- **前置**：测试账号 `credits = 2`。
- **操作**：添加一条描述含 `[fail]` 的任务，点击"生成日程"。
- **预期**：
  1. 服务端日志出现一次 `mock-ai.started` 和一次同 `callId` 的 `mock-ai.failed`。
  2. toast"生成失败，本次未扣额度"，提示删除含 `[fail]` 的任务后重试。
  3. `wasp db studio` 中 `credits` 仍为 2（被预扣后已回滚）。
- **清理**：删除该 `[fail]` 任务，再次生成应成功且 `credits` 变为 1（验证恢复路径）。

## C4. 同账号并发请求，不透支（可重复执行）

- **前置**：测试账号 `credits = 1`；已拿到该账号的登录会话（用于脚本直接打接口）。
- **操作**：并发发起 5 次"生成日程"请求（建议脚本同时发出，不靠手动连点）。
- **预期**：
  1. **恰好 1 次**成功返回日程，其余 4 次收到 402"额度不足"。
  2. 服务端日志中 `mock-ai.started` 恰好出现 1 次（多余请求被额度挡住，没调用模型）。
  3. `wasp db studio` 中 `credits = 0`，**不为负**。

### 可重复执行的并发脚本（说明）

放在仓库根 `scripts/concurrent-credits.mjs`，思路（工程实现见 T5）：

```js
// 伪代码：用测试账号的会话 cookie，并发打 generatePlan 接口
const results = await Promise.all(
  Array.from({ length: 5 }, () =>
    fetch("/api/operations/generatePlan", {
      method: "POST",
      headers: { cookie: TEST_COOKIE, "content-type": "application/json" },
      body: JSON.stringify({ hours: 8 }),
    }).then((r) => r.status),
  ),
);
const success = results.filter((s) => s === 200).length;
console.log("成功数:", success, "状态码分布:", results);
console.assert(success === 1, "应恰好成功 1 次");
// 再查 DB: credits 应 === 0，不能 < 0
```

运行方式：先把 `User.credits` 手动设为 1，执行 `node scripts/concurrent-credits.mjs`，再用 `wasp db studio` 核对 `credits=0`。重复执行前把 `credits` 重置为 1 即可复现。

---

## 验收矩阵

| 规则 | 对应案例 |
| --- | --- |
| 成功扣 1 额度 | C1 |
| 额度不足不调用模型 | C2 |
| 模型失败不扣额度 | C3 |
| 并发不透支 | C4 |
| 用户理解结果、知道下一步 | C1/C2/C3 的 toast 与额度展示 |
