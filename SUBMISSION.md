# 提交说明

- 姓名：小刘
- 应聘方向：产品
- 打码手机号：150****0251

## 方案说明

现有流程在调用模型后才检查额度，多个请求同时提交时也可能透支。本方案在生成前先占用 1 次额度，日程生成并保存成功后扣除，明确失败则释放占用。同一账号最多同时生成 3 份日程，可用额度不足时不能开始新的生成。

页面增加可用次数、占用次数和生成记录。断网后可以查询原请求，避免重复生成；额度用完后，仍可编辑待办和查看已有日程。

本次提交产品方案和本地交互原型，未修改应用代码。原型的 18 项检查已通过，真实应用的验收需在开发完成后执行。

## 材料

- [需求方案](docs/product/PRD.md)
- [业务流程](docs/product/FLOWS.md)
- [交互原型](docs/product/prototype/index.html)与[页面说明](docs/product/PROTOTYPE.md)
- [开发任务拆解](docs/product/DEVELOPMENT.md)
- [验收案例](docs/product/ACCEPTANCE.md)
- [原型检查记录](docs/product/VERIFICATION.md)

下载后可打开 [review.html](docs/product/review.html) 集中阅读；原型预览方法见 [README](docs/product/README.md)。GitHub 文件页面不能直接运行 HTML。

## 补充说明

并发上限 3 是本次方案的初始设置，后续可根据实际负载调整。不提供排队，服务崩溃后的自动补偿按题目要求不在本次范围内。

使用 AI 辅助查阅资料、整理文档、制作原型和检查；额度扣除、并发限制和异常处理方式经过讨论确定。
