# 提交说明

- 姓名或称呼：李泳春
- 应聘方向：产品
- 打码手机号：156****8390

## 结果概览

**问题判断**：当前额度处理把余额判断放在模型调用之后，且使用请求开始时的旧快照。额度为 0 时仍会发起模型调用；并发请求都可能认为余额充足，把额度扣成负数；用户也看不到“这次扣没扣、还剩多少、下一步做什么”。

**主要方案**：把额度改成“调用前原子预扣 → 成功确认 / 失败退款”。额度不足直接拒绝且不调用模型；模型或保存失败退款；页面用成功、额度不足、模型失败三类明确文案区分结果，并始终展示真实余额。

**当前状态**：产品方案、流程、可交互原型、任务拆解、验收案例已完成。原型覆盖 5 个演示场景，额度并发/退款逻辑测试 5 组全部通过，UI 冒烟 7 项全部通过。真实后端/数据库不在产品方向内实现，工程落地要求见任务拆解与验收案例。已用 GitHub 账号 `lyc2248622657` 创建 fork、推送分支并提交 [PR #12](https://github.com/bybzhwbzhh88/task-planner-interview/pull/12)，等待评审。

## 交付入口

- 总览与阅读路径：[product/README.md](product/README.md)
- 需求方案：[product/PRD.md](product/PRD.md)
- 流程与并发时序：[product/FLOW.md](product/FLOW.md)
- 可交互原型：[product/prototype/index.html](product/prototype/index.html)
- 任务拆解与工程交接：[product/TASKS.md](product/TASKS.md)
- 验收案例：[product/ACCEPTANCE.md](product/ACCEPTANCE.md)
- 原型逻辑测试：[product/prototype/quota-model.test.mjs](product/prototype/quota-model.test.mjs)

原型打开方式：直接双击 `product/prototype/index.html`，不需要安装依赖或启动服务。

## 验证记录

环境：Windows / Node.js 24.21.0；原型为纯静态 HTML/CSS/JS，无外部运行时依赖。

### 1. 原型额度逻辑测试

```sh
node product/prototype/quota-model.test.mjs
```

预期：1 额度并发只成功 1 个、3 额度并发成功 3 个、模型失败退款、0 额度不调用、连续生成第 4 次被拒绝。

实际：

```text
PASS  1 额度 / 3 并发 — 1 成功，2 不足，余额 0，模型调用 1 次
PASS  3 额度 / 5 并发 — 3 成功，2 不足，余额 0，模型调用 3 次
PASS  模型失败退款 — 余额恢复 1，未形成扣费
PASS  0 额度不调用模型 — 余额 0，模型调用 0 次
PASS  连续生成耗尽 — 状态序列 success → success → success → insufficient，余额 0
全部通过：5 组场景
```

### 2. 脚本静态检查

```sh
node --check product/prototype/quota-model.js
node --check product/prototype/app.js
```

预期/实际：两条命令均退出 0，无语法错误。

### 3. 原型 UI 冒烟（辅助验证）

使用本地临时 jsdom harness 加载原型，跑 5 个演示场景，并补充无任务、时长非法两项检查。实际 7/7 通过：

- 场景 1 成功：余额 3→2，日程展示，日志 `started` + `succeeded`。
- 场景 2 额度不足：余额 0，提示未生成/未扣，日志无 `started`。
- 场景 3 模型失败：余额仍 3，日志 `started` + `failed` + 退款。
- 场景 4 并发 1 额度：1 成功、2 不足，最终 0，1 次模型调用。
- 场景 5 并发 3 额度：3 成功、2 不足，最终 0，3 次模型调用。
- 场景 6 无任务：按钮禁用、提示添加任务、不扣额度、无调用日志。
- 场景 7 时长非法：提示修正、不扣额度、无调用日志。

说明：jsdom harness 只用于本轮辅助验证，不随仓库交付；可重复执行的核心证据是上面的 `quota-model.test.mjs`。

### 4. 未执行的验证

- **真实 Wasp 服务 + PostgreSQL 的 E-AC1–E-AC10 未执行**：产品方向不包含后端实现，这些是工程验收标准，见 [ACCEPTANCE.md](product/ACCEPTANCE.md)。
- **Wasp compile / tsc 未运行**：本轮未改后端代码，且产品方向不依赖编译产物。
- **浏览器视觉截图走查未完成**：当前环境 headless Edge 启动时无法访问缓存目录，未生成截图；不把 DOM 冒烟等同于视觉验收。

## 待办与交接

- 工程实现顺序：先做服务端“模型调用前条件预扣 + 失败退款”，再做前端状态/文案，最后用真实并发脚本跑 E-AC4/E-AC5。
- 重点不能只做前端禁用：并发和旧页面必须由服务端条件更新兜底。
- 已知限制：
  - v1 不做幂等键，同一页面生成中已禁用重复提交，多标签页仍可能分别计费。
  - v1 不做历史记录，成功后刷新余额仍在，但最近日程可能不保留。
  - 本地项目没有充值入口，额度不足文案引导联系管理员。
  - 崩溃后自动补偿、退款失败自动修复不在本轮范围。
- 更完整的工程要求、风险和测试矩阵见 [product/TASKS.md](product/TASKS.md)。

## 提交信息

- PR 标题：`产品｜李泳春｜156****8390`
- PR：[#12](https://github.com/bybzhwbzhh88/task-planner-interview/pull/12)
- 提交账号：`lyc2248622657`
- 分支：`feat/quota-product-handling`
- 状态：已提交，等待评审
- 目标分支：`main`
