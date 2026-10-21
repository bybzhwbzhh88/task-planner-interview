# 原型检查

这里的检查仅针对本地产品原型，不运行 Wasp、Prisma、PostgreSQL 或原项目的模型接口。真实业务验收仍按上级目录的 ACCEPTANCE.md 执行。

需要 Node.js、npm、Python 3。使用两个终端：

```sh
# 终端一：在 docs/product 目录
python3 -m http.server 18765 --bind 127.0.0.1
```

```sh
# 终端二：在 docs/product/qa 目录
npm install
npx playwright install chromium
npm run check
```

可用 `PROTOTYPE_URL` 指定其他地址。每次运行会重置浏览器上下文的演示数据，重写 results.json，并更新上级 assets 目录的四张原型截图。测试浏览器使用独立临时上下文，不接触真实应用账号。

检查覆盖成功占用与结算、零额度、模型与保存失败、两个页面争用最后一次、独立并发上限、重复点击、响应丢失、查询失败、刷新恢复、输入版本、混合完成结果及页面适配。

每次运行使用一个与真实浏览器隔离的 context。各场景通常通过“载入场景”重置本地演示数据；P11 接续 P10 验证刷新恢复。P05、P17 在同一个 context 打开多个页面，以共享演示账号；它们不是彼此隔离的账号。

自动检查在该 context 固定 `Date.now`，用“推进至本批完成”控制结束，避免机器较慢时请求先自动完成、把并发场景变成串行。固定时钟只作用于测试，不改产品原型默认约 4 秒自动完成的行为；这些检查不声称验证了自动完成耗时。

## 维护阅读版

Markdown 是事实源，review.html 是导出阅读版。修改文档并更新验证记录后，在本目录执行：

```sh
npm run build:review
npm run check:delivery
```

前者重新生成阅读版，后者检查本地文档链接、导航、原型嵌入、流程图和移动布局，并更新 delivery-results.json 及阅读截图。可用 `REVIEW_URL` 指定阅读地址。无需把生成器之外的临时构建目录提交到仓库。

实际结果见 [results.json](results.json)，面向评审的解释见 [VERIFICATION.md](../VERIFICATION.md)。
