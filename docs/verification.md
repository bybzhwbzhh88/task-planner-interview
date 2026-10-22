# 验证记录

额度规则、回滚和并发均已通过真实 PostgreSQL 验证；输入/权限边界与页面状态共 38 项自动检查通过。测试断言同时核对余额、结果数与实际模拟模型日志。完整浏览器与 HTTP 认证中间件未做端到端验收，不能将组件测试当作浏览器验收。

## 环境与复现

2026-10-22，Node.js 24.14.1、Prisma 5.19.1、Vitest 4.1.11、PostgreSQL 17.6。测试在 Windows 上使用 Wasp 0.25.0 生成的 SDK/Prisma 客户端执行，完整编译另在 WSL 的独立 Linux 临时目录运行。项目依赖按原有 `package-lock.json` 安装，未升级依赖。

先按 [README](../README.md) 完成安装、生成与专用测试库准备，再运行：

```sh
npm test -- --reporter=verbose
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/task_planner_test?connection_limit=12' npm run test:integration
npm run check:types
wasp compile
```

数据库脚本拒绝缺少连接串或库名不以 `_test` 结尾的配置；不读取应用的开发库连接。它只部署已有迁移，不 reset 数据库。临时账号均已清理，实查测试库 `User` 数为 0。首次执行应用了 1 条初始迁移，后续重复执行显示无待应用迁移。

## 案例到证据

设计前置条件与预期见 [SPEC 验收表](../SPEC.md#验收案例)。下表为实际结果，`started` 来自原有 `mockAi.ts` 的日志计数；未用模拟数据库替代 PostgreSQL。

| 案例 | 实际操作 / 自动检查 | 实际结果 |
| --- | --- | --- |
| A1 成功 | 余额 3，普通任务，故意传入余额 0 的旧认证快照 | 成功；余额 2、结果 1、started/succeeded 各 1 |
| A2 不足 | 库内余额 0，认证快照故意为 999，任务含 `[fail]` | 402；余额 0、结果 0、started 0 |
| A3 失败与重试 | 余额 1，`[fail]` 后修改任务重试 | 失败 502 后余额 1、结果 0、failed 1；重试后余额 0、结果 1；累计 started 2 |
| A4 最后 1 次额度 | `Promise.allSettled` 同时提交 10 个请求 | 成功 1、402 为 9；余额 0、结果 1、started 1 |
| A5 三次额度 | 同时提交 10 个请求 | 成功 3、402 为 7；余额 0、结果 3、started 3 |
| A6 失败释放 | 用 Promise 屏障暂停首个失败请求，再启动成功请求 | 失败回滚后成功；余额 0、结果 1；started 2、failed 1、succeeded 1 |
| A7 保存失败 | 模型成功后，在保存边界注入不存在的 owner，执行真实 INSERT | PostgreSQL 外键错误 `P2003`；余额 1、结果 0；started/succeeded 各 1，证明成功模型并不等于已提交扣费 |
| A8 权限与参数 | 未登录、9 种非法时长、合法边界/小数、错误映射、余额查询隔离、空任务列表 | 单元 19 项通过；空任务实际事务返回 400、余额 1、结果 0、started 0 |
| A9 账号隔离 | A 的模型被屏障暂停时让 B 完成，再释放 A | B 先完成且只包含自己的任务；两账号各余额 0、结果 1；总 started 2 |
| A10 页面反馈 | 渲染实际页面组件，替换网络/查询边界；操作按钮和时长输入 | 组件 10 项通过：零额度/加载/读取失败禁用、pending 防重复、成功刷新、模型失败可重试、402 更新余额、网络错误不虚称未扣费、时长校验、任务读取失败、非法历史 JSON |

直接输出：[单元与页面 29 项](evidence/unit-ui.txt)、[数据库 9 项与逐例计数](evidence/database.txt)。测试入口：[操作边界](../tests/unit/operations.test.ts)、[数据库验收](../tests/integration/quota.test.ts)、[页面组件](../tests/ui/quota-feedback.test.tsx)。

## 编译与交付检查

| 检查 | 实际状态 |
| --- | --- |
| `npx tsc --project tsconfig.src.json --noEmit` | 通过，退出码 0 |
| `npx tsc --project tsconfig.wasp.json --noEmit` | 通过，退出码 0 |
| `wasp compile` | 通过，退出码 0；Prisma 客户端及 SDK 生成成功。临时 WSL 缺少 OpenSSL/兼容引擎运行库，迁移状态检查产生警告；真实迁移与事务另在 PostgreSQL 17.6 验证通过。[编译输出](evidence/compile.txt) |
| `git diff --check` | 通过 |
| GitHub Actions | 已配置[工作流](../.github/workflows/verify.yml)；尚未远端运行，结果以 PR Checks 为准 |
| 浏览器视觉、真实登录与多标签页切换 | 未做端到端验证；不能据组件测试宣称已通过 |

页面的手工补充步骤：按 README 启动应用并注册；添加普通任务后生成，确认余额从 3 到 2；添加 `[fail]` 后生成，确认未扣费并出现删除任务重试提示；在两个已登录标签页争抢最后 1 次额度；切回旧标签页，确认聚焦刷新余额。再断开网络生成，恢复网络后用“刷新余额与最近日程”确认结果。以上步骤作为后续浏览器验收清单，未伪造执行记录。
