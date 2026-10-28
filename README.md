# uxprobe

自动找 web 项目页面交互和体验层面的 bug。为 vibe coding 项目准备：AI 写出来的代码往往只考虑正常路径，加载中、失败、空数据、刷新后这些状态最容易出问题，而这些问题大多可以用确定性的规则检出。

它不调用任何大模型。同一个 commit 跑两次，结果一样。

## 能找到什么

| 类型 | 例子 |
|---|---|
| 反馈 | 点了没反应、接口失败时显示成「没有数据」、加载中先显示「没有数据」、失败后一直转圈、提交后没提示、可以重复提交、字段为空时页面崩溃 |
| 状态 | 写入后页面不刷新、刷新后数据丢失、快速输入时旧请求的结果覆盖新结果 |
| 流程 | 数据为空时没有引导、内容不存在时只给「重试」、页面没有任何出口 |
| 操作 | 按钮被遮挡、点击区域太小、只在悬停时出现的操作、能点但不是按钮、回车不能提交 |
| 呈现 | 手机宽度横向溢出、长文字撑破布局、文字被截断且看不到全文、图片加载失败、页面显示 undefined/null |

核心方法是**条件对比**：同一个页面分别在正常、空数据、接口 500、接口慢、字段为空、超长文本几种条件下渲染，然后比较页面上的文字。比如「接口失败时」和「真的没数据时」页面一模一样，就说明失败被伪装成了空数据。这个判断不需要知道页面的业务含义。

测不到的：文案看不看得懂、流程设计是否合理、要多步向导或拖拽才能到达的状态。

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

## 验证

`test/minefield/` 是一个埋了 25 个 UX bug 的小应用，外加一组故意做对、但容易误报的对照页。

```bash
node test/score.mjs
```

它会分别跑「有雷」和「雷全修好」两个版本，报告检出率、对照页误报、修好后的残留。当前结果是 25/25 检出、0 误报、0 残留。

## License

MIT
