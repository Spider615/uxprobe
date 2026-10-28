# UX 覆盖扩展验证记录

日期：2026-10-29。运行环境：macOS、Node.js v22.23.1、Google Chrome 156.0.8078.73，通过 `UXPROBE_CHROME` 指定浏览器。

## 实现范围

- 键盘遍历、可见焦点和模态弹窗焦点行为。
- 表单声明约束、错误关联、提交故障及输入保留和重试。
- 查询参数 / hash 路由、深链接、刷新、前进后退和可配置的草稿保护。
- 桌面 / 手机交互、紧凑 / 横屏 / 缩短高度模拟。
- axe 可访问性规则、动态状态通知和报告置信度。
- 有界状态探索、标签页 / 开关 / 选择器、下载验证。
- 声明式多步工作流、上传故障 / 限制、分页和无限列表断言。
- 实验室性能采样、读取条件及局部接口故障注入。

每类检查提供 checked / skipped / error 覆盖记录；检查异常使 CLI 返回运行失败。写入检查使用独立浏览器上下文和沙箱恢复，并保留原有隔离检查。

## 自动测试

运行命令（需要 Node.js 22+ 和已安装的浏览器）：

```bash
UXPROBE_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm test
UXPROBE_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test --test-concurrency=1 test/forms.test.mjs
```

| 运行 | 结果 | 本机日志 |
|---|---|---|
| 提交前扩展测试全集 | 80 / 80 通过，0 失败、0 跳过 | `.uxprobe/validation/pre-push-tests.log` |
| 最后一次失败反馈文案修正后的表单测试 | 11 / 11 通过，含新增的否定成功文案用例 | `.uxprobe/validation/forms-tests.log` |

提交前已完整运行全部 80 个测试用例，耗时约 303 秒。其中包括最后增加的反馈文案用例，验证 `Not saved` 等否定文案不会误报成提交成功。此前也单独重跑过全部 11 个表单用例。

## 原有 25 项兼容基准

```bash
UXPROBE_SCORE_PROGRESS=1 node test/score.mjs
UXPROBE_SCORE_PROGRESS=1 node test/score.mjs /m/truncated /m/longtext
```

- 完整运行分别扫描有雷版和修好版的 33 个页面：预置问题检出 25 / 25，正常对照页误报 0，检查器错误 0。
- 扩大的 axe 检查额外发现两个样例本身的列表 HTML 语义错误，所以这次完整运行以非零退出，修好版报告 2 条 `a11y:list` 残留。
- 修正 `/m/truncated` 的嵌套列表容器和 `/m/longtext` 的列表子元素后，只复测这两个受影响的页面：预置问题检出 2 / 2，正常对照页误报 0，修好版残留 0。
- 其余 23 项在完整运行中通过，未受两处样例 HTML 修正影响；修正后没有再次运行完整的 25 项基准。

完整运行日志：`.uxprobe/validation/minefield-score.log`。修正后复测日志：`.uxprobe/validation/minefield-recheck.log`。这些是本机忽略的验证产物，未纳入 Git。

兼容基准关闭新增检查族，不能代替上面的扩展测试。静态可访问性仍纳入基准评分。

## 其他验证与边界

源码语法检查、`git diff --check`、CLI `--version` / `--root` 已通过。独立的规格和代码质量复核已完成，提出的问题均已修正并验证。

真实手机软键盘、辅助技术实际播报、线上用户性能和业务流程合理性仍需对应环境验证。性能采样不是线上 INP，自动规则也不构成完整 WCAG 合规认证；业务预期通过明确的工作流断言配置。

本次扩展在 `codex/ux-coverage` 分支开发，交付目标为 `main`；提交及推送状态以仓库 Git 记录为准。
