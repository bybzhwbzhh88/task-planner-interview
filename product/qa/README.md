# 原型检查复跑

此工具只检查本地产品原型，不运行仓库应用，不验证真实数据库或服务端并发。

需要 Node ≥22 及已安装的 Chrome、Edge 或 Chromium。

```sh
cd product/qa
npm ci
npm run check
```

默认自动寻找常见浏览器路径；没有找到时设置 `BROWSER_PATH` 为本机浏览器可执行文件绝对路径。PowerShell 示例：`$env:BROWSER_PATH='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'`。

脚本打开 `../prototype.html`，验证成功、失败、忙碌、未知结果、旧余额、刷新失败及输入状态。结果写到 `../prototype-checks.json`，并更新桌面与移动预览截图。失败退出非零；截图只展示原型状态，不作为真实产品验收证据。

`npm run build:reader` 从现有 Markdown 生成离线可读的 `../阅读入口.html`，不改写需求源文档。修改文档后应重新生成。阅读入口是便于评审的派生文件，Markdown 仍是唯一内容来源。
