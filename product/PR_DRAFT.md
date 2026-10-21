# 产品｜李晗亮｜181****2618

针对原日程生成在模型返回后才检查额度、并发可能使用旧余额以及操作结果不够明确的问题，提交产品方向改进方案。

方案在生成前校验最新额度，同账号已有生成时拒绝重叠请求；保留并完善现有扣费与保存事务，成功保存后消耗1额度，明确失败不扣费。结果未知时引导核查额度与已有日程，避免盲目重试。

交付入口：

- [提交概览](https://github.com/lhlaiwyn/task-planner-interview/blob/product-lihanliang/SUBMISSION.md)与[需求、流程及业务规则](https://github.com/lhlaiwyn/task-planner-interview/blob/product-lihanliang/product/PRD.md)。
- [交互原型](https://github.com/lhlaiwyn/task-planner-interview/blob/product-lihanliang/product/prototype.html)：10种本地演示场景；下载后保留同目录的prototype.js再用浏览器打开。[桌面预览](https://github.com/lhlaiwyn/task-planner-interview/blob/product-lihanliang/product/prototype-preview.png)。
- [开发任务拆解](https://github.com/lhlaiwyn/task-planner-interview/blob/product-lihanliang/product/DELIVERY.md)与[13组验收案例](https://github.com/lhlaiwyn/task-planner-interview/blob/product-lihanliang/product/ACCEPTANCE.md)。
- [实际审查记录](https://github.com/lhlaiwyn/task-planner-interview/blob/product-lihanliang/product/REVIEW.md)及[42项原型检查结果](https://github.com/lhlaiwyn/task-planner-interview/blob/product-lihanliang/product/prototype-checks.json)，含可复跑脚本。

42项浏览器原型检查通过；原型模拟不等于真实应用、数据库或并发验收，开发后的AC01–AC13验收要求已明确。应用业务代码保持仓库基线。

称呼：李晗亮；岗位：AI产品经理；打码手机号：181****2618。
