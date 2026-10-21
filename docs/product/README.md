# 日程生成额度处理

小刘 · 产品经理方向 · 2026-10-21

生成前先占用额度，生成并保存成功后扣除，明确失败则释放占用。页面展示剩余次数和每次生成的记录，帮助用户判断该等待、重新生成，还是查询原结果。

本次完成产品方案和本地原型，未修改应用代码。

## 阅读顺序

1. [需求方案](PRD.md)：现有问题、修改范围和具体规则。
2. [业务流程](FLOWS.md)、[交互原型](prototype/index.html)与[页面说明](PROTOTYPE.md)：用户如何操作，页面如何反馈。
3. [开发任务拆解](DEVELOPMENT.md)与[验收案例](ACCEPTANCE.md)：需要开发什么，如何检查。
4. [原型检查记录](VERIFICATION.md)：本次实际检查的内容和结果。

也可打开 [review.html](review.html) 集中阅读。规则以 PRD.md 为准，文中的编号用于查找对应任务和案例；名词解释见 [GLOSSARY.md](GLOSSARY.md)。

## 原型预览

直接打开 `prototype/index.html` 可体验单页操作。要演示刷新和多个页面共享同一账号，建议启动本地服务：

```sh
# 在本文件所在的 docs/product 目录执行；需要 Python 3
python3 -m http.server 18765 --bind 127.0.0.1
```

打开 `http://127.0.0.1:18765/review.html` 或 `http://127.0.0.1:18765/prototype/index.html`。无需安装应用依赖、数据库或模型密钥。

顶部“演示控制”用于切换额度不足、生成失败、响应丢失等场景，也可模拟其他页面提交和手动完成生成。它不属于产品页面；点击“新账号”可重置数据。

原型使用浏览器本地数据，不连接真实账号、数据库或模型。具体演示方法见[页面说明](PROTOTYPE.md)。

## 提交方法

将交付包中的根目录 `SUBMISSION.md` 和 `docs/product/` 加入自己 Fork 的仓库，在分支中提交后向原仓库发起 PR。保留原仓库的 README、TASK、代码和配置。

PR 标题：`产品｜小刘｜150****0251`。正文可使用交付包根目录的 `PR_BODY.md`。

## 参考与维护

方案基于原仓库提交 [114aeb2](https://github.com/bybzhwbzhh88/task-planner-interview/tree/114aeb28f6368e96c08a25627ac094b8d102fd1b)，阅读了题目、提交要求、数据结构和日程生成相关代码，尚未安装或运行原应用。

修改材料时先更新 Markdown，再按 [qa/README.md](qa/README.md#维护阅读版) 重新生成阅读版并检查。
