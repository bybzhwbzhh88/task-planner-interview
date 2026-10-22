# 本地额度验收记录

2026-10-21，Ubuntu / WSL2，Node 24.14.1、Wasp 0.25.0、PostgreSQL 16.15。**本地实现与验证已完成；已提交 [PR #3](https://github.com/bybzhwbzhh88/task-planner-interview/pull/3)，等待仓库方评审。** 原始环境基线不是本轮功能证据，仍单独保留在 [BASELINE_RUN](BASELINE_RUN.md)。

最新自助完整复验：[CI通过，17项数据库／35个HTTP场景／15步浏览器](https://github.com/Theodora-Y/task-planner-interview/actions/runs/39793738843)，详见第8节。

原始额度实现提交 `da266a9146fc173213840f87328c36dafdc47f1c`；设计提交 `99cecc9` 保留。后续审查补强见第5节，原始证据链接当前指向最新复验文件，初验快照保留在摘要的原字段中。

执行入口与完整命令见 [QUOTA_RUN](QUOTA_RUN.md)：S=真实 PostgreSQL 服务测试，H=真实 HTTP，B=Edge/Playwright，C=编译与类型检查。初验为 AC01～AC23；审查新增 AC24 的补测与修复见第5节。验收前置条件和操作按 [SPEC 第7节](../SPEC.md#7-验收标准与验证入口)；下表列明预期和实际。S 中 HTTP 状态是业务错误到响应的映射结果，并非声称发生了真实 HTTP 数据库断网。

## 1. 初验汇总与证据（审查前）

- S：完整运行 **17/17 测试通过，0 失败、0 跳过**，52 条状态观测；AC07/AC08 各 10 轮，并完成 5 个独立 Node 进程竞争。
- H：**35 个场景全部通过**；包含 20 轮五请求并发。每轮同时断言响应、数据库余额/预占、结果增量和模型日志。
- B：**12 步全部通过，0 个页面异常**；错误提示注入与真实模型失败分别记录。
- C：`wasp compile`、`npx tsc --project tsconfig.src.json --noEmit`、`npx tsc --project tsconfig.wasp.json --noEmit` 均退出 0。
- 新迁移已在开发库成功应用；最终只读核对为负余额 0、RESERVED 0，两条迁移均已完成。模型文件、原初始化迁移和依赖锁文件保持原样。

随 Git 提交的 [脱敏结果摘要](verification/summary.json) 包含逐场景的实际状态、模型次数和结果计数，供审阅。它是本次运行的快照，不代替重新执行。下列原始证据在本机存在但受 Git 忽略，**不随 PR 提交**：

- [S 测试报告](../test-results/quota/vitest.json)、[S 状态观测](../test-results/quota/service-observations.json)、[S 最终日志](../test-results/quota/service.log)。
- [H 报告](../test-results/quota/http.json)、[H 日志](../test-results/quota/http.log)。
- [B 报告](../test-results/quota/browser/report.json)、[成功截图](../test-results/quota/browser/success.png)、[失败释放截图](../test-results/quota/browser/failure-released.png)、[双标签页零额度截图](../test-results/quota/browser/zero-credit-two-tabs.png)。
- [编译日志](../test-results/quota/compile.log)、[源码类型检查](../test-results/quota/typescript-src.log)、[Wasp 类型检查](../test-results/quota/typescript-wasp.log)。两项类型检查无诊断输出，退出码保留在摘要中。

## 2. 逐项结果

C 为可用额度，P 为 RESERVED 数，M 为模型 started 数，ΔR 为本场景结果增量。S 的统计以当前场景为界；AC11 使用两个账号的聚合 M=2，分别各调用 1 次。

| 编号 | 命令组 / 前置与操作 | 预期 | 实际结果 / 证据 |
| --- | --- | --- | --- |
| AC01 | S/H/B；新注册查看 | C=3，P=0，M=0，ΔR=0 | 通过；数据库、auth 与页头均为 3，空任务按钮禁用；S/H AC01、B AC01-UI |
| AC02 | S/H/B；C=3 普通生成 | 200；C=2，M=1，ΔR=1 | 通过；显示日程与消费提示，P=0；S/H AC02、B AC02-UI |
| AC03 | S/H/B；C=1 生成 | 200；C=0，M=1，ΔR=1，按钮禁用 | 通过；页头同步到 0；H AC03、B AC03-AC06-UI |
| AC04 | S/H/B；C=0 直接请求 | 402；C=0，M=0，ΔR=0 | 通过；未调用模型、未新增结果；H AC04、B AC04-AC13-stale-direct-request |
| AC05 | S/H/B；C=1，包含 [fail] | 502；释放后 C=1，M=1/failed=1，ΔR=0 | 通过；页面明确已释放，保留旧结果并改标题；H AC05、B AC05-UI |
| AC06 | S/H/B；删除失败任务再生成 | 200；C=0，M=1，ΔR=1 | 通过；未被前次失败阻塞；H AC06、B AC03-AC06-UI |
| AC07 | S/H；C=1，5 并发×10 轮 | 每轮 1×200/4×402，C=0，M=1，ΔR=1 | 全部通过；S 10 轮及 H AC07-1～10 均符合，无负数余额或多发模型 |
| AC08 | S/H；C=3，5 并发×10 轮 | 每轮 3×200/2×402，C=0，M=3，ΔR=3 | 全部通过；S 10 轮及 H AC08-1～10 均符合 |
| AC09 | S 屏障保持失败预占；H 无屏障补测 | 屏障阶段 1×502/2×402，C=1，M=1，ΔR=0；随后可成功 | 通过；S 恢复为 200/C=0/M=1/ΔR=1；H 本次实际也是 [502,402,402]，但脚本依 SPEC 允许失败释放后再受理 |
| AC10 | S 在 T2 状态更新后注入真实 SQL 错误，再恢复 | 首次 500/C=1/M=1/ΔR=0；随后成功 | 通过；T2 回滚、T3 释放，第二次 200/C=0/ΔR=1；B 保存失败提示另用注入验证 |
| AC11 | S；两个账号各 C=1，模型返回屏障 | 两账号都进入模型再释放，各 200/C=0/ΔR=1 | 通过；聚合 M=2，不依赖耗时阈值；S AC11 A/B |
| AC12 | S/H/B；未登录、空任务、非法时长；合法边界/小数 | 401/400 均 M=0/ΔR=0；合法值可成功 | 通过；S 覆盖 NaN/±Infinity；H 覆盖认证、空任务、0/25/字符串及 1/24/1.25；B 非法输入禁用 |
| AC13 | B；双标签页 C=1，A 消费后聚焦 B，再直接请求 | B 显示 0；直接请求 402/M=0/ΔR=0 | 通过；实际页头与服务器一致，无新模型调用；B AC04-AC13-stale-direct-request |
| AC14 | S；数据库 0/认证快照 3，及数据库 1/快照 0 | 分别 402/M=0/ΔR=0，及 200/C=0/M=1/ΔR=1 | 通过；两种过期方向均以数据库为准；S stale high/low |
| AC15 | S；T1 扣减后插入前 SQL 错误，恢复后再生成 | 首次 503/C=1/P=0/M=0/ΔR=0；随后成功 | 通过；确认预占整体回滚；S rollback/recovery，B DB_UNAVAILABLE 文案注入通过 |
| AC16 | S；并发两次释放后再释放；成功后再尝试释放 | 只返还一次，成功不退款 | 通过；预占 fixture 最终 C=1/P=0/M=0/ΔR=0；成功 fixture C=0/M=1/ΔR=1，重复释放不改变 |
| AC17 | S；T2 真实提交后抛提交应答丢失，再确认 | 返回既有成功；C=0/P=0/M=1/ΔR=1 | 通过；未再次调用或保存、未退款；S recovered commit/repeated confirmation |
| AC18 | S；模型失败后持续阻断释放；另一个请求已提交但阻断确认 | 都 OUTCOME_UNKNOWN；保留各自真实状态，不承诺退款 | 通过；A C=0/P=1/M=1/ΔR=0；B C=0/P=0/M=1/ΔR=1。B 的 UI 注入显示编号、不声称未扣费、无自动重试 |
| AC19 | S；三份任务快照/预占，其中一份失败，屏障期间发第四请求 | 中途 C=0/P=3；终态 2×200/1×502，C=1/P=0/M=3/ΔR=2 | 通过；第四请求 402 且不新增调用；S AC19 |
| AC20 | S；5 个独立 Node 进程共用测试库 C=1 | 1×200/4×402，C=0/P=0/M=1/ΔR=1 | 通过；跨进程 IPC 聚合模型日志；未冒称多副本 HTTP 部署测试 |
| AC21 | S；旧结构库含历史记录；另建负余额库，应用迁移 | 普通库保留数据；负余额库拒绝，不修正金额 | 通过；正常退出 0，C=2、任务/结果各1、旧关联 NULL；负余额退出 3、C=-1 保留，无部分新表；M=0 |
| AC22 | S；T3 状态更新后退款 SQL 一次失败 | T3 全回滚后第二次清理成功，502/C=1/P=0/M=1/ΔR=0 | 通过；第二次释放前确认 C=0/P=1，有限重试共2次；S AC22 |
| AC23 | S；T1 真提交后丢失应答；可清理/持续不可清理两例 | 均零模型；已释放为 DB_UNAVAILABLE，否则 OUTCOME_UNKNOWN | 通过；前者 503/C=1/P=0/M=0/ΔR=0；后者 503/C=0/P=1/M=0/ΔR=0；S AC23 |

## 3. 失败定位与重跑

首轮 S 为 16 通过、1 失败：AC21 在创建旧结构 fixture 时，新客户端默认读取了尚不存在的 generationAttemptId。修正为只返回旧结构已有的 id，未修改迁移或削弱断言。AC21 单独重跑通过后，最终完整 S 重跑 17/17 通过。首轮与定点日志保留于本机 `service-first.log`、`migration-rerun.log`。

Wasp 客户端实际将服务端详情封装为 error.data.data，页面按生成代码适配，真实 [fail] 浏览器测试已验证。未修改模拟模型的延迟、失败触发或日志来通过测试。

## 4. 已知边界及未执行事项

- 服务崩溃自动补偿、模型永久挂起的取消、跨请求幂等不在题目范围内，未实现也未宣称验证。
- 未进行真实数据库网络故障/操作系统断电测试。提交应答丢失通过“真实数据库提交后抛出传输错误”注入验证；UI 错误响应通过 Playwright 路由注入验证。
- 未部署多副本 HTTP 服务；AC20 已验证独立进程共享数据库的原子准入。
- H/B 的专用本地账号保留；S 自己的 fixture 已清理。密码与连接配置不提交，原始大日志/截图仅本机保存。
- 应聘身份和通知时间已确认并补齐，见 SUBMISSION；Fork与推送记录见第7节，当前PR状态见 [SUBMISSION](../SUBMISSION.md)。

## 5. 独立审查后的补强（2026-10-21）

- **提交资料，已采纳**：应聘者确认称呼“郑女士”、打码手机号132****3133；通知为北京时间2026-10-21 17:38，48小时截止为2026-10-23 17:38。SUBMISSION 已填写，拟用标题为 `技术｜郑女士｜132****3133`。本节审查完成时个人Fork尚未创建；后续状态见第7节。
- **成功后刷新失败，已补测并修复**：初次仅注入页面 /auth/me 503，真实生成200后，Wasp默认受保护页面包装器进入error并卸载日程组件，原“刷新失败不得改报成功结果”的承诺缺少实际保障。保存了[修复前报告](../test-results/quota/review/auth-refresh-before-fix.json)及[截图](../test-results/quota/review/auth-refresh-before-fix.png)。先同步SPEC，再让首页与demo使用同一源码内登录守卫：仅已确认身份的缓存遇到暂时查询失败时保留视图；无身份/401/403仍限制页面，所有服务端认证和额度逻辑保持原样。
- **本轮实际复验**：S17/17；B15步、0页面异常；编译、两项tsc均退出0。H35场景为上一轮既有证据，本轮没有重跑，因核心额度服务、数据库、模型与HTTP入口均未改动；新增浏览器401回归核对页面保护调整没有放开生成接口。

AC24 命令仍为 QUOTA_RUN 的 B，明确预期与实际：

| 阶段 | 前置与操作 | 预期 | 实际 |
| --- | --- | --- | --- |
| 生成与刷新失败 | 新账号C=3、普通任务；仅页面auth/me返回503，真实generate-plan放行；独立API读取服务器事实 | 200，C=2，M=1，ΔR=1；保留成功日程和成功提示，额度读取失败，按钮禁用 | 全部通过；B `AC24-success-auth-refresh-failed` |
| 恢复查询 | 解除页面拦截，点击刷新额度 | 显示C=2、按钮恢复；新增M=0、ΔR=0；不再次生成 | 全部通过；B `AC24-auth-refresh-recovered`；两阶段累计生成请求数仍为1 |
| 未登录保护 | 新的未登录窗口分别访问/和/demo-app，并直接请求生成 | 两页面跳到/login；API401，M=0、ΔR=0 | 全部通过；B `AC12-AC24-unauthenticated-guard` |
| 明确认证拒绝 | 已登录缓存下仅页面auth/me返回403，随后解除拦截并刷新 | 不显示任务页，不在login/demo间循环；恢复后服务器额度和结果不变，M=0、ΔR=0 | 全部通过；B `AC24-auth-rejected-UI-injected` |

psql相关建议按应聘者最新要求保持原样，新增预检和客户端说明均已撤回，未纳入提交。

新增测试只注入认证刷新响应，不修改生成结果、断言或模拟模型。最终15步浏览器报告沿用原[报告入口](../test-results/quota/browser/report.json)，包含既有场景与上述四条记录；本轮数据库日志为[review/service.log](../test-results/quota/review/service.log)。三项本轮编译/类型日志位于同一review目录。脱敏摘要的reviewFollowup标明本轮结果和未重跑项，历史初验快照仍保留。

## 6. 最终交付核对（2026-10-21）

最后功能代码为本地 Git 提交 `2b46f01f487be8931d468cbc2b88d1233fcad9c6`。本轮只整理 README、SPEC、运行说明、提交说明与 PR 正文，源码、测试、依赖及迁移未改变，因此未重复运行业务测试。前述 S17/17、B15步和三项编译/类型检查对应这份功能源码；H35场景对应核心额度逻辑未变的初验版本，未冒称本轮重跑。

实际执行的收尾检查：

- `git diff --check`：通过；相对 `2b46f01` 仅有文档差异。
- Git 历史：设计 `99cecc9` 仅含三份文档，是实现 `da266a9` 的直接父提交；上游历史保留。这里的“提交”均指本地 Git commit，不等同于 GitHub PR。
- 静态扫描当前公开文件及本地提交历史：未发现完整手机号、私钥、常见 GitHub/npm 令牌、带密码的数据库连接；无被跟踪的生成目录、本地配置或原始测试凭据。
- 本地文档链接全部存在；链接到 `test-results/` 的原始证据已明确标为仅本机保存，不属于 PR 文件。
- 原始 S/B/H 报告与脱敏摘要交叉核对一致；H正式场景48个唯一callId均对应服务日志中一次started和一次succeeded/failed。
- `git ls-remote --symref upstream HEAD refs/heads/main`：上游默认分支为main，HEAD/main均为 `114aeb28f6368e96c08a25627ac094b8d102fd1b`。

本轮静态核对脚本及详细结果仅保存在被忽略的 `test-results/quota/final/`；随 Git 保留的核对摘要见 `summary.json` 的 finalDelivery。没有把静态核对写成业务复验。

PR正文见 [PR_BODY](PR_BODY.md)，目标与身份见 [SUBMISSION](../SUBMISSION.md)。本节文档收尾时技术实现及材料已具备发布准备条件，尚未创建Fork或推送；后续按用户授权执行的Fork与推送见第7节；本节完成时PR尚未创建，当前状态见SUBMISSION。最终作业交付仍须在北京时间2026-10-23 17:38前完成PR提交。

## 7. Fork与分支推送（2026-10-21）

按应聘者明确授权，使用其选定的GitHub账号Theodora-Y创建个人Fork，并推送 `chore/original-baseline` 分支；没有创建PR。

- GitHub接口确认账号为Theodora-Y，Fork为 [Theodora-Y/task-planner-interview](https://github.com/Theodora-Y/task-planner-interview)，父仓库为bybzhwbzhh88/task-planner-interview。
- origin配置为个人Fork，upstream保留原仓库；`git push --set-upstream origin chore/original-baseline` 成功，分支建立远端跟踪，未使用force。
- 首次远端核对：`git ls-remote origin refs/heads/chore/original-baseline` 为 `a090375b8a898355240bb95cb7b19b5a7ece2de4`，与当时本地HEAD一致；先SPEC后代码的完整历史已推送。
- 此后仅同步本节、SPEC、SUBMISSION与摘要中的交付状态，不改源码、测试、依赖或迁移，因此不重复业务测试。历史reviewFollowup/finalDelivery保留当时状态，本节Fork阶段记录在摘要forkDelivery，后续PR状态见prDelivery。
- 本节完成时尚待创建PR；后续已提交 [PR #3](https://github.com/bybzhwbzhh88/task-planner-interview/pull/3)，当前交付状态统一见SUBMISSION。

## 8. 自助复验入口修正（2026-10-22）

此前交付虽然列出验证命令，但数据库配置、浏览器安装及服务日志路径需要接手者组合，不足以快速复验。本轮新增统一命令与自动隔离环境，不改额度业务或模拟模型。原数据库测试仅调整环境变量读取及SQL客户端启动，所有原断言保持原文。Playwright1.64.1由本机外挂改为固定开发依赖，仅新增playwright/playwright-core两个锁文件包，既有依赖版本未升级。

- 本机 npm run verify：真实执行通过，自动创建/销毁独立PostgreSQL16集群，编译、两项tsc及17/17数据库测试通过，0失败/跳过，33秒。依赖已有缓存，不将此耗时写成首次安装承诺。
- 干净检出核心：未复制.env、node_modules或.wasp，从检出源码运行npm run verify，57秒通过编译、两项tsc和17/17数据库测试。OS工具及npm下载缓存可复用，不冒称全新操作系统。
- 干净检出完整：在另一无配置、无依赖、无生成目录的临时检出运行npm run verify:all；系统浏览器库就绪后136秒通过S17/17、H35场景、B15步，0页面异常。临时应用与PostgreSQL均已停止。
- [GitHub完整CI](https://github.com/Theodora-Y/task-planner-interview/actions/runs/39793738843)：复验实现提交ebb08bb8005382a90f5884d4eb046f17054b5ca6，Ubuntu24.04/Docker PostgreSQL16/Chromium，170秒通过相同的S17/H35/B15与编译、两项tsc；下载quota-verification附件已核对全部计数及各阶段退出0。默认Docker路径用容器内SQL客户端，无需宿主psql。
- 首次本地完整复验在浏览器阶段因缺少Linux系统库失败（非零退出），已按Playwright安装必要系统库后，在新检出完整重跑通过。未修改断言或模型来通过。
- 安全拒绝实测：非*_quota_test地址在迁移前退出1，报告stages为空；未读取或改动开发库。
- 新入口与前提统一见[QUOTA_RUN](QUOTA_RUN.md)。历史原始报告受Git忽略；本轮本地归档在test-results/quota/reproduction，公开的完整CI报告/截图在上述Actions附件。脱敏摘要的reproductionRepair绑定真实运行与提交，历史快照继续保留。
