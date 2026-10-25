# 验证脚本与本地复现

此脚本用于本轮部署环境的**原始版本复现**，不改业务代码，不人工调整余额。测试会新建4个专用账号、执行18次生成、保存原始截图/请求结果/只读业务快照，并在结束后关闭测试浏览器。执行期间可看见Chrome真实操作。

## 已运行的版本与限制

实际运行入口是部署目录 `.runtime/browser/product-validation.mjs`。这里的副本仅增加了Playwright依赖的查找回退，测试步骤相同；副本已做语法检查，没有另跑一次业务流程。原始实际执行脚本另存为 `executed-product-validation.mjs.txt`，供核对。

运行目录应为本地部署外层文件夹，即同时包含 `task-planner-interview/`、`.runtime/browser/`、`logs/app.log` 的目录。本环境为：

```powershell
Set-Location 'C:\Users\21829\Documents\ChatGPT\额度分配'
node .\task-planner-interview\docs\product\tools\product-validation.mjs
```

前置：项目3000/3001端口正常，Studio5555可用；Chrome已安装；Playwright1.56.0已在`.runtime/browser/node_modules`安装；WSL发行版TaskPlanner、PostgreSQL数据库taskplanner、postgres只读查询权限可用。安装环境见外层本地使用说明。无需外部模型API。

这不是跨平台通用脚本：数据库快照通过 `wsl.exe -d TaskPlanner -u postgres --exec psql -d taskplanner` 读取，日志读取Windows部署目录`logs/app.log`。在其他机器运行，需先适配这些部署位置及日志来源，不能宣称开箱即用。题目产品方向不强制提交此脚本，此处作为复现附件。

## 每次运行产生什么

新建一个UTC时间命名的 `docs/product/evidence/<run>/` 目录，生成45张主流程截图、`results.json`、每个案例JSON和JSONL、带前后步骤的`index.html`。本轮另外4张Studio截图为只读补充，合计49张；主脚本本身不生成这4张。

脚本固定描述基线提交，因此仅用于当前原版。对改进版本回归应新建运行目录、记录真实新提交，并调整业务目标断言/错误码；不能把固定commit标签或旧用例结果沿用为新版证据。

测试日志没有userId；运行时应避免其他账号同时点生成。如果窗口有额外started，停止归因并重跑。结果JSON不输出密码、Cookie、Authorization，也不导出认证表行。新账号数据保留用于复核，不自动删除。

## 判定和退出状态

`status=completed` 表示测试流程执行完毕，**不代表产品验收通过**。每项 `verdict` 是特定数值断言；原版AC06、AC08及CC01–03为FAIL是预期发现的缺陷。脚本只有执行中断时非零退出，没有把业务FAIL当成进程崩溃。

数据库截图补拍方式：Studio→User→Filters→id equals测试ID；PlanResult→Filters→userId equals同ID；保留图中筛选条件和关键列。本轮基线截图和证据不要覆盖。

离线回放只需打开已保存的 `evidence/<run>/index.html`；上一步/下一步/自动回放查看截图，不执行任何生成或扣额操作。
