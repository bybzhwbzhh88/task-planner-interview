# 将本交付应用到你自己的 GitHub Fork

> 上传给助手的是 GitHub 下载的源码 ZIP，**不包含上游 Git 历史**。不能直接推送这里的临时 Git 仓库并期望得到正常的 PR。交付包另附 3 个按时间排序的补丁，必须在**从 GitHub 克隆的 Fork** 上依次应用并提交，这样能保留“SPEC 先于业务代码”的可审查历史。

在自己的 GitHub 账号中先 Fork `bybzhwbzhh88/task-planner-interview`，然后在本机终端运行：

```sh
git clone https://github.com/你的GitHub用户名/task-planner-interview.git
cd task-planner-interview
git checkout -b feat/quota-safe-generation
```

将交付包的 `patches/` 文件夹复制到仓库的临时位置，例如仓库**外部** `/tmp/task-planner-patches/`；以下命令假设补丁在 `/tmp/task-planner-patches/`：

```sh
# 先提交规格，不和业务代码混在一起
git apply /tmp/task-planner-patches/01-spec.patch
git add SPEC.md
git commit -m "docs: define quota requirements and acceptance criteria"

# 再提交业务实现和自动化测试
git apply /tmp/task-planner-patches/02-implementation.patch
git add src/demo-ai-app package.json tests
git commit -m "fix: reserve credits atomically and refund on failure"

# 最后提交验证记录、运行文档与规格更新
git apply /tmp/task-planner-patches/03-documentation.patch
git add README.md SPEC.md SUBMISSION.md PR_DESCRIPTION.md docs
git commit -m "docs: record verification and handoff"
```

接着，填写 `SUBMISSION.md` 中的**称呼和打码手机号**，并单独提交个人信息（只允许前三位、`****`、后四位）：

```sh
git add SUBMISSION.md
git commit -m "docs: complete masked applicant details"
```

完成本地运行和验证后推送：

```sh
git push -u origin feat/quota-safe-generation
```

在 GitHub 为此分支创建一个指向 `bybzhwbzhh88/task-planner-interview` 的 PR。标题格式 `技术｜称呼｜前三位****后四位`；正文可使用 `PR_DESCRIPTION.md`，需保持验证状态与实际运行一致。**切勿把完整手机号、`.env.server` 或数据库连接字符串上传到公开 PR。**

如 `git apply` 检查失败，通常表示源仓库自本次 ZIP 后已有更新：不要使用强制覆盖。先比较上游变更，再合并对应代码、重跑测试。
