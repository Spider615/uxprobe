# uxprobe

自动找 web 项目页面交互和体验层面的 bug。为 vibe coding 项目准备：AI 写出来的代码往往只考虑正常路径，加载中、失败、空数据、刷新后这些状态最容易出问题，而这些问题大多可以用确定性的规则检出。

它不调用大模型，使用明确的规则和可重放的操作。动态数据、异步时序和本机负载仍可能影响结果；性能诊断需结合实际环境复核。

## 能找到什么

| 类型 | 例子 |
|---|---|
| 反馈 | 点了没反应、接口失败时显示成「没有数据」、加载中先显示「没有数据」、失败后一直转圈、提交后没提示、可以重复提交、字段为空时页面崩溃 |
| 状态 | 写入后页面不刷新、刷新后数据丢失、快速输入时旧请求的结果覆盖新结果 |
| 流程 | 数据为空时没有引导、内容不存在时只给「重试」、页面没有任何出口 |
| 操作 | 按钮被遮挡、点击区域太小、只在悬停时出现的操作、能点但不是按钮、回车不能提交 |
| 呈现 | 手机宽度横向溢出、长文字撑破布局、文字被截断且看不到全文、图片加载失败、页面显示 undefined/null |
| 键盘与焦点 | Tab 到不了控件、没有可识别的焦点样式、模态弹窗焦点没进入 / 跑到背景、Esc 无法关闭、关闭后焦点丢失 |
| 表单与恢复 | 违反声明的 required / type / min / max / minlength / pattern 约束仍提交、校验没反馈、字段错误未关联；写入失败却报成功、输入清空、按钮一直禁用、重试失败 |
| 导航与控件 | 查询参数 / hash 路由、失效链接、深链接 / 刷新失败、前进后退异常、标签页 / 开关 / 选择器状态不更新、空下载 / 下载失败 |
| 可访问性 | axe 的 WCAG A/AA 检查（包括对比度、ARIA、控件名称等）、动态反馈缺少读屏通知语义 |
| 性能诊断 | 加载后布局跳动、主要内容呈现慢、主线程长任务、已采样交互的响应延迟 |

核心方法是**条件对比**：同一个页面分别在正常、空数据、接口 500、接口慢、字段为空、超长文本几种条件下渲染，然后比较页面上的文字。比如「接口失败时」和「真的没数据时」页面一模一样，就说明失败被伪装成了空数据。这个判断不需要知道页面的业务含义。

桌面与手机都执行交互检查。工具还会从初始状态重放短操作链，继续检查菜单、标签页和弹窗里新出现的状态；有状态数、深度和控件数上限，触顶会写进覆盖记录。

读取条件注入支持本机 fetch/XHR 的 GET 和明确的 GraphQL POST 查询，覆盖详情对象、列表、全局和局部端点故障。写入恢复检查注入 401 / 403 / 422 / 429 / 500、断网和超时，并在解除故障后尝试重试。persisted GraphQL query、WebSocket、原生 EventSource、SSR 数据不能自动变形；这部分需专用工作流或人工验证。

业务特有的分页结果、无限滚动、文件类型 / 大小限制、上传失败重试、未保存草稿和复杂多步流程，通过下面的 `scenarios` 明确预期。工具不根据字段名猜哪些可选字段必须填写，也不一律要求所有页面保留草稿。

文案是否容易理解、流程是否合理、真实手机软键盘、读屏实际播报和真实用户性能仍需另外验证。紧凑 / 横屏 / 缩短视口只是浏览器模拟；性能结果是本机实验室诊断，不是线上 INP，也不代表完整 WCAG 合规认证。

## 不会动你的数据

被测应用连同它的数据会被复制进沙箱（`~/.uxprobe/`，macOS 上用 APFS 写时复制，几乎不占空间），在副本上启动、在副本上点。另外：

- 运行中每秒用 `lsof` 检查应用整个进程组往哪里写文件，写到沙箱外就中止。
- 原项目目录和所有数据目录跑前跑后各做一次指纹比对，不一致就中止。
- 浏览器只放行本机请求。
- 可以加只读校验命令（比如 MySQL 的 binlog 位置），跑前跑后输出必须一致。

隔离失效时退出码是 3，并列出具体路径。

## 安装

需要 Node.js 22+（被测项目用什么版本无所谓）和 macOS 或 Linux。

```bash
git clone https://github.com/Spider615/uxprobe.git ~/tools/uxprobe
~/tools/uxprobe/install.sh
```

`install.sh` 会把 `uxprobe` 命令链到 `~/.local/bin`，把 `skill/` 链到 Claude Code、Codex 和 `~/.agents` 的 skills 目录。之后在 Claude Code 里说「检查一下这个项目的交互有没有 bug」，它会自动用 uxprobe，而不是直接在你的真实应用上点。

浏览器用 Playwright 的 Chromium。没装的话运行 `npx playwright install chromium`。

## 使用

每个项目第一次跑之前需要一份配置，放在 `~/.uxprobe/configs/<项目目录名>.json`（或项目根目录的 `uxprobe.config.json`）。最小例子：

```json
{
  "start": "npm run dev -- --port {port.web}",
  "url": "http://localhost:{port.web}",
  "env": { "DATABASE_URL": "file:{data.db}" },
  "data": { "db": "prisma/dev.db" }
}
```

应用会写的每个地方都要列进 `data`，并用 `env` 把应用指到副本。字段说明见 [`src/config.mjs`](src/config.mjs) 开头。在 Claude Code 里用的话，它会自己读代码写配置。

```bash
uxprobe run <项目目录>
uxprobe run <项目目录> --page /settings     # 只测某些页
uxprobe run <项目目录> --config 别处.json
```

报告在 `~/.uxprobe/<项目>-<哈希>/report/`：`index.html` 带截图，问题元素用红框标出；`report.json` 给程序或 AI 读。

退出码：0 没问题，1 有问题，2 运行失败，3 隔离失效。

报告 JSON 额外包含 `scannedPages`、`coverage.summary` 和逐项 `coverage.records`。覆盖结果分为 `checked` / `skipped` / `error`：配置禁用、readOnly、抽样上限、未能重放的状态会说明跳过原因；检查器异常会记录为失败并使 CLI 返回 2。HTML 同样显示未测原因，不把检查失败显示成「没有发现问题」。诊断和启发式结果分别标成「诊断」与「需复核」。

## 扩展配置与工作流

以下字段合并到原来的项目配置；都可省略：

```json
{
  "viewports": ["desktop", "mobile"],
  "limits": { "controls": 25, "inputs": 6, "forms": 4, "recoveryControls": 2, "states": 8, "depth": 2, "tabStops": 80, "navigation": 4, "readEndpoints": 3 },
  "checks": { "performance": true, "explore": true },
  "performance": { "lcpMs": 2500, "cls": 0.1, "longTaskMs": 200, "interactionMs": 200 },
  "readFaults": [401, 403, 429, "offline", "timeout"],
  "navigation": { "preserveForms": false, "preserveScroll": false, "dirtyWarning": false },
  "scenarios": [
    {
      "name": "分页后显示下一页结果",
      "start": "/items?page=1",
      "viewports": ["desktop", "mobile"],
      "steps": [
        { "action": "click", "selector": "[aria-label='下一页']" },
        { "action": "expect", "kind": "text", "selector": "[data-page]", "value": "第 2 页" },
        { "action": "back" },
        { "action": "expect", "kind": "url", "value": "/items?page=1" }
      ]
    },
    {
      "name": "上传失败保留文件并允许重试",
      "start": "/files",
      "steps": [
        { "action": "fault", "match": "/api/upload", "method": "POST", "status": 500 },
        { "action": "upload", "selector": "input[type=file]", "file": { "name": "uxprobe.txt", "mimeType": "text/plain", "text": "test upload" } },
        { "action": "expect", "kind": "text", "selector": "[role=alert]", "value": "上传失败" },
        { "action": "clearFaults" },
        { "action": "click", "selector": "[data-action=retry]" },
        { "action": "expect", "kind": "text", "selector": "[role=status]", "value": "上传成功" }
      ]
    }
  ]
}
```

`viewports` 可用 `desktop`（1280×800）、`mobile`（375×760）、`compact`（320×640）、`landscape`（760×375）。手机检查另外模拟紧凑、横屏和缩短高度；不把它称为真实设备验证。`checks` 支持 `static`、`conditions`、`interactions`、`keyboard`、`forms`、`recovery`、`navigation`、`components`、`explore`、`performance`、`mobile`、`scenarios`，省略的检查默认启用。

工作流只支持声明式动作：`goto`、`click`、`fill`、`press`、`select`、`check`、`upload`、`scroll`、`back`、`forward`、`reload`、`wait`、`expect`、`fault`、`clearFaults`。所有入口必须是应用内 `/` 路径；没有执行任意 JS 的动作。`skipClick` 和 `readOnly` 对工作流同样有效。

`expect.kind` 支持 `visible` / `hidden` / `text` / `value` / `url` / `count` / `checked` / `enabled` / `disabled` / `download`。文字默认包含匹配，可加 `exact: true`；下载可设 `filename` 和 `minBytes`（默认 1）。`scroll` 用 `x` / `y` 指定增量，也可带滚动容器 `selector`；用 `expect count` 验证无限列表增长。`press` 需要 `key`，`select` 用 `value`；`wait` 使用 `selector` + `state` 或不超过 5000 的 `ms`。

上传只生成测试内容，不读取原项目的真实文件。用 `file.size` 生成指定字节数的文件，以验证大小上限；最多 10 MiB。故障匹配应用内 API 路径前缀，可加 `method`、`once`，或用 `mode: "offline" / "timeout"` 代替 HTTP 状态。工作流运行在独立浏览器 context 内；每次写入都标记沙箱待重置，结束后关闭页面再恢复数据副本。

当产品明确要求后退保留表单 / 滚动位置或离开未保存表单时确认，才把对应的 `navigation` 开关设为 true。自动保存、权限角色、取消上传等策略也可以通过有明确断言的工作流验证。无法自动验证的业务预期会保留在报告的检测边界中。

## 验证

`test/minefield/` 是一个埋了 25 个 UX bug 的小应用，外加一组故意做对、但容易误报的对照页。

```bash
node test/score.mjs
npm test
```

`score` 分别跑原始 25 个埋雷的「有雷」和「雷全修好」两个版本，检查原规则兼容性，报告检出率、对照页误报、修好后的残留；可访问性结果也计入统计，失败返回非零。该基准关闭扩展检查族，并明确记录在覆盖信息中。`npm test` 用独立的浏览器正反例验证新增检查、路由发现、故障恢复、文件 / 多步工作流、报告、只读模式和沙箱数据保留。两者不能推导出对任意产品的完整 UX 覆盖率。

本次扩展的运行环境、测试结果和复测范围见[验证记录](docs/ux-coverage-validation.md)。

## License

MIT
