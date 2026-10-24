# 项目说明

本项目使用 React、TypeScript、Wasp 0.25.0、Prisma 和 PostgreSQL。

- 任务与范围见 `TASK.md`，本地运行方式见 `README.md`。
- 技术方向先提交 `SPEC.md` 再修改代码；实现与验证应对应其中的验收案例，设计调整时同步更新 spec。
- 额度处理的产品方案、任务拆解和验收案例见 `docs/product/`；技术方向的 `SPEC.md` 可以直接引用其中的验收案例。
- `main.wasp.ts` 声明路由和操作，`schema.prisma` 定义数据模型。
- `.wasp/` 为生成目录，修改源文件后通过 Wasp 重新生成。
- 模拟接口由 `src/demo-ai-app/mockAi.ts` 提供，无需接入外部模型。
- 框架文档：https://wasp.sh/docs 。使用与项目版本相符的接口，避免无关的依赖升级。
