# PR 草稿（尚未创建）

标题：`技术｜肖文超｜138****8178`

## 正文

修复日程生成在模型调用后才检查额度、同账号并发时可能透支的问题。生成前用数据库条件扣减预占 1 次，成功落库后保留扣减，生成或保存失败则返还；页面展示结果状态并刷新额度。

- 先提交 [SPEC.md](SPEC.md) 初稿，再实现；Git 历史保留设计与实现顺序。
- 真实 PostgreSQL 上的 15 项集成测试通过，包括 10 请求并发、失败返还和混合成败；命令为 `npm run test:quota`。另有 9 项前端组件交互检查通过。
- Linux 环境的 `wasp compile`、`tsc --project tsconfig.src.json --noEmit`、`tsc --project tsconfig.wasp.json --noEmit` 全部通过。
- 实现后复审和真实浏览器走查通过：注册/登录、成功扣减、失败返还、额度耗尽拦截、退出重登与页面刷新均正常，见 [复审记录](verification/REVIEW.md)。
- 设计、实际验证记录、运行说明与已知限制见 [SUBMISSION.md](SUBMISSION.md)。

## 创建前

此文件只是草稿，不会自动创建 PR。完成剩余验证并确认提交后，将本地分支推送到自己的 Fork，向 `bybzhwbzhh88/task-planner-interview:main` 发起 PR，按上面的标题填写。
