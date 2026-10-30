# 提交说明

- 姓名或称呼：凌心怡
- 应聘方向：技术/产品
- 打码手机号：178****3963

## 结果概览

原实现先调用模型再检查额度，无额度请求仍会发起模型调用；
同账号并发请求还可能重复使用同一额度。

本次使用数据库条件扣减预占额度。
只有预占成功的请求才能调用模型；
生成并保存结果成功后保留扣减，失败时尝试恢复额度。
页面增加可用额度、刷新入口和操作反馈。

核心实现与验证已完成。进程崩溃自动补偿不在范围内，
数据库故障及额度恢复失败尚未进行故障注入验证。

## 交付入口
- [产品方案、用户流程、页面草图、开发任务拆解与验收案例](PRODUCT.md)
- [规格说明与验收案例](SPEC.md)
- [服务端额度控制与查询](src/demo-ai-app/operations.ts)
- [Wasp 操作声明](src/demo-ai-app/demo-ai-app.wasp.ts)
- [页面额度展示与反馈](src/demo-ai-app/DemoAppPage.tsx)
- [可重复执行的验证脚本](scripts/verify-quota.mjs)
- [环境安装与基础启动说明](README.md)

## 运行方式

按 README 准备环境、配置文件和依赖。
本次验证环境为 macOS、Node.js 26.8.1、Wasp 0.25.0、
Docker PostgreSQL 18。

首次运行需要执行数据库迁移。
以下命令均在项目根目录执行。

终端一，启动数据库并保持运行：

```bash
wasp start db
```

终端二，首次初始化数据库后启动应用：

```bash
wasp db migrate-dev
wasp start
```

终端三，执行验证脚本：

```bash
node scripts/verify-quota.mjs
```

脚本连接 http://localhost:3001，自动注册两个独立测试账号，
创建测试任务，并检查响应状态、剩余额度和保存的日程数量。
每次运行使用新账号，测试数据保留在本地数据库中。

本次使用的 npm 版本需要显式允许 Prisma 安装脚本。
如安装时提示脚本被跳过，可执行：

```bash
npm install-scripts approve @prisma/engines prisma
npm rebuild @prisma/engines prisma --foreground-scripts
```

## 验证记录

验证日期：2026-10-27。

### 接口与并发验证

执行命令：

```bash
node scripts/verify-quota.mjs
```

实际结果：全部脚本断言通过。

| 对应案例 | 操作与预期 | 实际结果 |
| --- | --- | --- |
| A1 | 新账号额度为 3，成功生成一次；额度应为 2，新增 1 条日程 | 通过，额度 3 → 2，结果数为 1 |
| A2 | 零额度直接请求；返回 402，额度与结果数不变 | 通过 |
| A3 | 添加含 [fail] 的任务并生成；失败后额度不变，不新增结果 | 通过，额度仍为 2，结果数仍为 1 |
| A4 | 额度为 1，同时发送 5 个请求；仅 1 个成功，最终额度为 0 | 通过，1 个 200、4 个 402，结果总数由 2 增至 3 |
| A5 | 新账号额度为 3，同时发送 5 个请求；仅 3 个成功 | 通过，3 个 200、2 个 402，最终额度为 0，结果数为 3 |

A3 使用额度为 2 的账号执行，与 SPEC 中额度为 1 的示例有所不同；
验证的业务规则同为“明确失败后额度不变”。

### 模型调用日志核对

停止应用后，使用以下命令重新启动并记录日志：

```bash
wasp start 2>&1 | tee /tmp/task-planner-quota-verification.log
```

启动后仅执行一轮验证脚本，期间不进行其他生成操作。
随后统计：

```bash
grep -c '"event":"mock-ai.started"' /tmp/task-planner-quota-verification.log
grep -c '"event":"mock-ai.succeeded"' /tmp/task-planner-quota-verification.log
grep -c '"event":"mock-ai.failed"' /tmp/task-planner-quota-verification.log
```

预期与实际结果一致：

- started：7。
- succeeded：6。
- failed：1。

本轮包含 6 次成功生成和 1 次明确失败。
模型调用总数符合预期，被额度拦截的请求没有产生额外调用。

日志文件为本地临时文件，未提交仓库。
以上命令可用于重新生成验证证据。

### 页面手动验证

- 模型明确失败后，显示额度已恢复，额度最终不变。
- 失败后，页面保留之前成功生成的日程，对应 A8。
- 成功生成后，额度从 1 变为 0。
- 零额度时，生成按钮禁用，并展示暂无可用额度提示。

实际结果：上述操作符合预期。

A7 的生成中按钮状态尚未单独记录验证证据。
A6 的并发失败及恢复场景尚未执行。

### 基础检查

| 命令 | 实际结果 |
| --- | --- |
| wasp compile | 通过 |
| npx tsc --project tsconfig.src.json --noEmit | 通过 |
| npx tsc --project tsconfig.wasp.json --noEmit | 通过 |

## 待办与交接

- 并发安全入口是 User.updateMany 中的 credits > 0 条件扣减；
  不应改回“先查询额度，再无条件扣减”。
- 模型调用不放在长时间持有数据库锁的事务中。
- 前端额度仅用于展示，服务端条件更新决定是否允许调用。
- 失败恢复每个请求只尝试一次，恢复失败时记录服务端错误。
- 进程在预占额度后崩溃可能遗留额度，不提供自动补偿。
- 结果保存与请求响应存在网络或数据库异常时的状态不确定性；
  未实现请求幂等与自动重试。
- 后续可补充并发失败恢复、数据库故障及恢复失败测试。
