## 解决的问题

完善日程生成额度处理：模型调用前原子预占，余额不足不调用模型；模型明确失败释放；成功结果与消费状态一致提交；同账号并发不透支，页面区分成功、明确失败与结果不明。

采用PostgreSQL条件更新及RESERVED/SUCCEEDED/RELEASED请求状态，不依赖单个Node进程。模型在短事务之外执行，代价是增加请求记录和异常结算逻辑。保留原模拟模型语义及原初始化迁移。

## 接手者复验

Linux／Ubuntu WSL准备Node >=24.14.1、Wasp0.25.0，以及Docker或本机PostgreSQL服务端工具后，在PR分支根目录运行：

```sh
npm run verify
```

自动安装依赖、创建并清理隔离数据库、编译、类型检查和运行17项真实数据库验收，无需作者配置或数据库密码。干净检出运行 `npm run verify:all`，自动启动隔离应用并验证真实HTTP与Chromium；首次本地浏览器系统库准备见运行说明，CI自动安装。

## 实际验证

[完整GitHub CI已通过](https://github.com/Theodora-Y/task-planner-interview/actions/runs/39793738843)，对应复验实现提交ebb08bb；已下载核对归档报告：

- 编译和两项TypeScript检查退出0。
- 真实PostgreSQL 17/17，0失败、0跳过；包含事务、故障注入、迁移及5个独立Node进程。
- 真实HTTP 35场景，包含余额1/3各10轮、每轮5请求并发；核对响应、余额、结果和实际模型调用。
- Chromium浏览器15步，0页面异常，包括生成成功后认证刷新503的保留与恢复。
- 同一命令在本地无个人配置/依赖/生成目录的干净检出中通过：核心57秒、完整136秒；CI完整170秒。网络与缓存会影响耗时。
- 非测试库URL在迁移前拒绝；原验收断言及额度业务未改。新增固定Playwright开发依赖，既有依赖版本未升级。

## 文档与历史

- [最终SPEC](https://github.com/Theodora-Y/task-planner-interview/blob/chore/original-baseline/SPEC.md)：FR01～FR10、方案与AC01～AC24。
- [快速运行与复验](https://github.com/Theodora-Y/task-planner-interview/blob/chore/original-baseline/docs/QUOTA_RUN.md)
- [逐项实际结果与最新证据](https://github.com/Theodora-Y/task-planner-interview/blob/chore/original-baseline/docs/VERIFICATION.md)
- [提交说明](https://github.com/Theodora-Y/task-planner-interview/blob/chore/original-baseline/SUBMISSION.md)

99cecc9为代码修改前的独立SPEC提交，早于实现da266a9；21bad24为实现后的交接版修订。初稿历史保留，未重写上游。

## 已知限制

自动崩溃补偿、跨请求幂等、模型永久挂起取消不在范围；长期故障可能遗留预占。未做真实网络断电、多副本HTTP部署测试；数据库提交应答丢失及页面错误响应均明确采用注入验证。无缓存503与缓存401尚缺专项浏览器证据，不宣称已覆盖。

历史原始日志仅本机保留；本轮完整报告、截图和检查日志可从上述CI的quota-verification附件下载，不包含个人配置或测试密码。
