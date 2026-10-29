import { writeFileSync } from "node:fs";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// 规则名的中文说法，报告里规则 id 只作小字备查
const RULE_LABEL = {
  "null-crash": "字段为空时报错", "null-shown": "直接显示空值", "error-as-empty": "失败显示成没数据", "loading-as-empty": "加载中显示成没数据",
  "empty-as-error": "没数据显示成失败", "error-stuck-loading": "失败后一直转圈", "silent-error": "失败没有提示", "no-loading": "没有加载状态",
  "no-empty-state": "没有空状态", "no-feedback": "点了没反应", "write-no-feedback": "提交后没反馈", "double-submit": "可以重复提交",
  "uncaught": "未捕获的报错", "stale-after-write": "写入后页面没刷新", "lost-after-reload": "刷新后数据丢失", "race": "快速操作时结果错乱",
  "retry-on-404": "404 只给重试", "dead-end": "走进死胡同", "small-target": "点击区域太小", "occluded": "按钮被遮挡",
  "not-a-button": "能点但不是按钮", "enter-no-submit": "回车不能提交", "horizontal-overflow": "横向溢出", "long-text-overflow": "长文字撑破布局",
  "truncated": "文字被截断", "broken-image": "图片加载失败", "raw-value": "显示了原始值",
  "keyboard-unreachable": "键盘无法到达", "focus-invisible": "焦点不可见", "modal-focus": "弹窗焦点未进入", "modal-focus-trap": "焦点离开弹窗", "modal-escape": "弹窗无法按 Esc 关闭", "modal-focus-return": "弹窗关闭后焦点丢失",
  "invalid-accepted": "无效输入仍被提交", "invalid-no-feedback": "校验失败没有提示", "form-error-unlinked": "错误未关联字段",
  "write-false-success": "保存失败却提示成功", "write-error-silent": "保存失败没有提示", "write-input-lost": "失败后输入丢失", "write-stuck-control": "失败后无法再提交", "write-retry-failed": "重试未成功", "read-fault-crash": "读取失败导致崩溃", "read-error-silent": "读取失败缺少恢复提示",
  "mobile-reflow": "紧凑 / 横屏布局溢出", "mobile-obstructed": "缩短视口后操作被裁切", "broken-navigation": "导航链接失效", "deep-link-broken": "页面不能直接打开", "reload-broken": "刷新页面失败", "history-back-broken": "后退状态错误", "history-forward-broken": "前进状态错误", "history-input-lost": "后退后输入丢失", "history-scroll-lost": "后退后位置丢失", "draft-leave-unprotected": "未保存输入缺少保护",
  "tab-no-switch": "标签页无法切换", "tab-panel-hidden": "标签内容不可见", "toggle-no-change": "开关状态不更新", "select-no-change": "选择值未更新", "combobox-escape": "下拉框无法按 Esc 关闭", "download-failed": "下载失败", "download-empty": "下载结果为空", "download-missing": "没有收到下载", "scenario-failed": "工作流断言失败", "live-status-missing": "动态反馈缺少读屏通知",
  "slow-lcp": "主要内容呈现慢", "layout-shift": "加载后内容跳动", "long-task": "主线程阻塞", "slow-interaction": "操作响应慢", "probe-error": "检查未完成", "color-only-status": "状态只靠颜色表达", "keyboard-activation": "控件无法用键盘触发", "tab-keyboard": "标签页无法用键盘切换", "tab-multiple-selected": "单选标签组多项被选中",
};
const CAT_ORDER = ["反馈", "状态", "流程", "操作", "呈现", "理解", "性能", "工具"];
const VIEWPORT = { desktop: "桌面", mobile: "手机", compact: "紧凑宽度", landscape: "横屏" };
const label = (rule) => RULE_LABEL[rule] ?? (rule.startsWith("a11y:") ? `无障碍：${rule.slice(5)}` : rule);
const needsReview = (i) => i.severity === "warning" || ["heuristic", "diagnostic"].includes(i.confidence) || /（疑似：/.test(i.msg);

// 把「说明（疑似：…）」和「console: 原始报错」从正文里拆出来，分开排版
function split(msg) {
  let text = String(msg), note = "", detail = "";
  const n = text.match(/（疑似：(.*?)）\s*$/); if (n) { note = n[1]; text = text.slice(0, n.index); }
  const d = text.indexOf("console: "); if (d >= 0) { detail = text.slice(d + 9).trim(); text = text.slice(0, d).replace(/[：:]\s*$/, ""); }
  return { text: text.trim(), note, detail };
}

const page = (p) => { try { return decodeURIComponent(p); } catch { return p; } };

// 一条问题是一行：收起时看标题和一句话，展开看原始报错、判断依据、页面和截图
function item(i) {
  const { text, note, detail } = split(i.msg);
  const tall = i.viewports.includes("mobile") && !i.viewports.includes("desktop");
  const review = needsReview(i); const badge = i.confidence === "diagnostic" ? "诊断" : review ? "需复核" : "";
  const pgs = i.pages.map(page);
  return `<details class="item${review ? " doubt" : ""}">
  <summary><i class="dot" aria-hidden="true"></i><span class="t"><b>${esc(label(i.rule))}</b>${badge ? `<em class="tag">${badge}</em>` : ""}<span class="m">${esc(text)}</span></span><span class="where">${i.viewports.map((v) => esc(VIEWPORT[v] ?? v)).join(" · ")}<span class="mono">${esc(pgs[0] ?? "")}${pgs.length > 1 ? ` +${pgs.length - 1}` : ""}</span></span><i class="chev" aria-hidden="true"></i></summary>
  <div class="more">
    ${detail ? `<pre class="detail">${esc(detail)}</pre>` : ""}
    ${note ? `<p class="note"><b>判断</b>${esc(note)}</p>` : ""}
    ${i.states?.length ? `<p class="note"><b>状态路径</b>${i.states.map(esc).join("；")}</p>` : ""}
    <dl><dt>页面</dt><dd>${pgs.map((p) => `<span class="mono">${esc(p)}</span>`).join("")}</dd><dt>视口</dt><dd>${i.viewports.map((v) => `<span>${esc(VIEWPORT[v] ?? v)}</span>`).join("")}</dd><dt>规则</dt><dd><span class="mono">${esc(i.rule)}</span></dd></dl>
    ${i.shot ? `<button class="shot${tall ? " tall" : ""}" type="button" data-src="${esc(i.shot)}" data-cap="${esc(label(i.rule))}" aria-label="放大截图"><img src="${esc(i.shot)}" loading="lazy" alt="${esc(label(i.rule))}的截图"></button>` : ""}
  </div>
</details>`;
}

export function writeHtml(report, file) {
  const issues = report.issues;
  const cats = [...new Set(issues.map((i) => i.cat))].sort((a, b) => (CAT_ORDER.indexOf(a) + 99) % 99 - (CAT_ORDER.indexOf(b) + 99) % 99);
  const doubt = issues.filter(needsReview).length, sure = issues.length - doubt;
  const pages = report.scannedPages?.length ?? new Set(issues.flatMap((i) => i.pages)).size;
  const coverage = report.coverage ?? { summary: { checked: 0, skipped: 0, error: 0 }, records: [] };
  const sum = coverage.summary, total = sum.checked + sum.skipped + sum.error || 1;
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
  const incomplete = sum.error > 0 || sum.skipped > 0;
  const safe = /一致/.test(report.isolation ?? "");
  const limitations = report.limitations ?? ["自动检查不能替代真实设备、辅助技术与业务流程验证。"];
  const verdict = issues.length ? `发现 ${issues.length} 个问题` : sum.error ? "检查未完成" : incomplete ? "已完成部分未发现问题" : "没有发现问题";
  const hint = issues.length ? (sure ? `其中 ${sure} 个已确定，可以直接修${doubt ? `；${doubt} 个需要人看一眼再决定` : ""}。` : `都需要人看一眼再决定。`) : incomplete ? "仍有跳过或失败的检查，请看下方覆盖记录。" : "报告干净不代表体验好：文案、流程是否合理仍需人看。";
  const sections = cats.map((c) => {
    const items = issues.filter((i) => i.cat === c).sort((a, b) => needsReview(a) - needsReview(b));
    return `<section data-cat="${esc(c)}"><h2>${esc(c)}<span>${items.length}</span></h2><div class="list">${items.map(item).join("")}</div></section>`;
  }).join("");
  const coverageHtml = `<section class="coverage"><h2>检查覆盖</h2><div class="bar" role="img" aria-label="已完成 ${sum.checked} 项，跳过 ${sum.skipped} 项，检查失败 ${sum.error} 项"><i class="b-ok" style="width:${pct(sum.checked)}"></i><i class="b-skip" style="width:${pct(sum.skipped)}"></i><i class="b-err" style="width:${pct(sum.error)}"></i></div><div class="legend"><span class="l-ok">已完成 ${sum.checked}</span><span class="l-skip">跳过 ${sum.skipped}</span><span class="l-err">检查失败 ${sum.error}</span><span class="aside">跳过和失败不代表通过</span></div><details class="records"><summary>检查记录与未测原因</summary><table><thead><tr><th>检查</th><th>页面 / 视口</th><th>结果</th></tr></thead><tbody>${coverage.records.map((r) => `<tr><td class="mono">${esc(r.check)}</td><td>${esc(r.page ?? r.scenario ?? "全局")} ${esc(VIEWPORT[r.vp] ?? r.vp ?? "")}${r.state ? ` · ${esc(r.state)}` : ""}</td><td class="st-${esc(r.status)}">${esc({ checked: "已完成", skipped: "跳过", error: "检查失败" }[r.status] ?? r.status)}${r.reason ? `：${esc(r.reason)}` : ""}</td></tr>`).join("")}</tbody></table></details></section>`;

  writeFileSync(file, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(report.project ?? "UX")} 检查报告</title>
<style>
:root{--bg:#fafafa;--panel:#fff;--fg:#18181b;--m:#52525b;--m2:#a1a1aa;--line:#ececee;--hover:#f6f6f7;--code:#f4f4f5;--accent:#2563eb;--sure:#e5484d;--doubt:#e2900b;--ok:#30a46c;--skip:#d4d4d8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b0b0d;--panel:#141417;--fg:#ededef;--m:#a1a1aa;--m2:#63636b;--line:#232327;--hover:#1a1a1e;--code:#1c1c20;--accent:#6e9bff;--sure:#f2555a;--doubt:#f1a10d;--ok:#3dd68c;--skip:#3a3a40}}
:root[data-theme="dark"]{--bg:#0b0b0d;--panel:#141417;--fg:#ededef;--m:#a1a1aa;--m2:#63636b;--line:#232327;--hover:#1a1a1e;--code:#1c1c20;--accent:#6e9bff;--sure:#f2555a;--doubt:#f1a10d;--ok:#3dd68c;--skip:#3a3a40}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:880px;margin:0 auto;padding:48px 16px 80px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
header .top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--m);font-size:13px}
header .top b{color:var(--fg);font-weight:600}
.safe{display:inline-flex;align-items:center;gap:6px}
.safe i{width:6px;height:6px;border-radius:50%;background:var(--ok)}.safe.bad i{background:var(--sure)}.safe.bad{color:var(--sure)}
h1{margin:28px 0 6px;font-size:30px;line-height:1.25;font-weight:650;letter-spacing:-.02em}
.hint{margin:0;color:var(--m);font-size:15px}
.stats{display:flex;flex-wrap:wrap;gap:8px 28px;margin:24px 0 0;padding:0}
.stats div{display:flex;align-items:baseline;gap:6px}
.stats b{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.stats span{color:var(--m);font-size:13px}
.stats .s-sure b{color:var(--sure)}.stats .s-doubt b{color:var(--doubt)}.stats b.zero{color:var(--m2)}
.meta{margin:8px 0 0;color:var(--m2);font-size:12px;overflow-wrap:anywhere}
nav{display:flex;align-items:center;gap:4px;margin:36px -16px 0;padding:10px 16px;position:sticky;top:0;z-index:2;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);overflow-x:auto;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav button{flex:none;font:inherit;font-size:13px;color:var(--m);background:none;border:0;border-radius:6px;padding:4px 10px;min-height:32px;cursor:pointer}
nav button:hover{color:var(--fg);background:var(--hover)}
nav button[aria-pressed="true"]{color:var(--fg);background:var(--panel);box-shadow:0 0 0 1px var(--line);font-weight:600}
nav button em{font-style:normal;margin-left:5px;color:var(--m2);font-variant-numeric:tabular-nums}
nav .toggle{margin-left:auto;color:var(--accent)}
section[data-cat]{margin-top:24px}
h2{display:flex;align-items:baseline;gap:8px;margin:0 0 8px;font-size:13px;font-weight:600;color:var(--m)}
h2 span{color:var(--m2);font-weight:400}
.list{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.item+.item{border-top:1px solid var(--line)}
.item summary{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;cursor:pointer;list-style:none}
.item summary::-webkit-details-marker{display:none}
.item summary:hover{background:var(--hover)}
.item summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:7px;background:var(--sure)}
.doubt .dot{background:none;box-shadow:inset 0 0 0 2px var(--doubt)}
.t{flex:1;min-width:0}
.t b{font-weight:600;font-size:15px}
.tag{font-style:normal;font-size:12px;color:var(--doubt);margin-left:8px}
.m{display:block;margin-top:2px;color:var(--m);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.item[open] .m{-webkit-line-clamp:unset}
.where{flex:none;max-width:34%;display:flex;flex-direction:column;align-items:flex-end;color:var(--m2);font-size:12px;margin-top:3px;text-align:right}
.where .mono{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chev{flex:none;width:7px;height:7px;margin:9px 2px 0 0;border:solid var(--m2);border-width:0 1.5px 1.5px 0;transform:rotate(45deg);transition:transform .15s}
.item[open] .chev{transform:rotate(-135deg);margin-top:12px}
.more{padding:6px 16px 18px 36px;border-top:1px dashed var(--line)}
.detail{margin:0 0 12px;padding:10px 12px;background:var(--code);border-radius:8px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;color:var(--m)}
.note{margin:0 0 12px;font-size:13px;color:var(--m)}
.note b{font-weight:600;color:var(--doubt);margin-right:8px}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:0 0 14px;font-size:13px}
dt{color:var(--m2)}dd{margin:0;display:flex;flex-wrap:wrap;gap:4px 12px;min-width:0;overflow-wrap:anywhere}
.shot{display:block;padding:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;cursor:zoom-in;background:var(--code);max-width:100%}
.shot.tall{max-width:300px}
.shot img{display:block;width:100%;height:auto}
.empty{margin-top:28px;padding:40px 16px;text-align:center;color:var(--m);background:var(--panel);border:1px solid var(--line);border-radius:12px}
.coverage{margin-top:48px}
.bar{display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--line);margin:4px 0 10px}
.b-ok{background:var(--ok)}.b-skip{background:var(--skip)}.b-err{background:var(--sure)}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:var(--m)}
.legend span:not(.aside)::before{content:"";display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
.l-ok::before{background:var(--ok)}.l-skip::before{background:var(--skip)}.l-err::before{background:var(--sure)}
.aside{color:var(--m2);margin-left:auto}
.records{margin-top:14px;font-size:13px}
.records summary{cursor:pointer;color:var(--accent)}
.records table{width:100%;border-collapse:collapse;font-size:12px;text-align:left;margin-top:8px}
.records th{color:var(--m2);font-weight:500}
.records th,.records td{padding:7px 8px 7px 0;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.st-error{color:var(--sure)}.st-skipped{color:var(--m2)}
.limits{margin-top:32px;color:var(--m2);font-size:12px}
.limits b{color:var(--m);font-weight:600}
.limits ul{margin:6px 0 0;padding-left:16px}
dialog{border:0;padding:0;background:transparent;max-width:min(1280px,94vw);max-height:94vh;color:#fff}
dialog::backdrop{background:rgba(0,0,0,.8)}
dialog img{display:block;max-width:100%;max-height:86vh;border-radius:8px;cursor:zoom-out;background:#fff}
dialog p{margin:10px 0 0;font-size:13px;opacity:.8;display:flex;justify-content:space-between;gap:16px}
@media (max-width:640px){.wrap{padding-top:28px}h1{font-size:24px}.where{display:none}.m{-webkit-line-clamp:2}nav .toggle{display:none}.aside{margin-left:0;width:100%}}
</style>
<div class="wrap">
<header>
  <div class="top"><span><b>${esc(report.project ?? "UX")}</b> · UX 检查报告</span><span class="safe${safe ? "" : " bad"}" title="${esc(report.isolation ?? "")}"><i></i>${safe ? "原数据未改动" : "请核对原数据"}</span></div>
  <h1>${verdict}</h1><p class="hint">${hint}</p>
  <div class="stats"><div class="s-sure"><b${sure ? "" : ' class="zero"'}>${sure}</b><span>确定</span></div><div class="s-doubt"><b${doubt ? "" : ' class="zero"'}>${doubt}</b><span>需复核</span></div><div><b>${pages}</b><span>已扫描页面</span></div><div><b>${esc(report.seconds)}s</b><span>用时</span></div></div>
  <p class="meta">${report.finishedAt ? esc(new Date(report.finishedAt).toLocaleString("zh-CN", { hour12: false })) + " · " : ""}沙箱 <span class="mono">${esc(report.app)}</span></p>
</header>
${issues.length ? `<nav aria-label="按类型筛选"><button type="button" data-f="" aria-pressed="true">全部<em>${issues.length}</em></button>${cats.map((c) => `<button type="button" data-f="${esc(c)}" aria-pressed="false">${esc(c)}<em>${issues.filter((i) => i.cat === c).length}</em></button>`).join("")}<button type="button" class="toggle">全部展开</button></nav>${sections}` : `<div class="empty">${incomplete ? "仍有跳过或失败的检查，请查看下方覆盖记录。" : "可以再人工过一遍文案和流程。"}</div>`}
${coverageHtml}
<div class="limits"><b>检测边界</b><ul>${limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>
</div>
<dialog id="lb"><img alt=""><p><span></span><span>点击或按 Esc 关闭</span></p></dialog>
<script>
const lb=document.getElementById("lb"),img=lb.querySelector("img"),cap=lb.querySelector("p span");
document.querySelectorAll(".shot").forEach(b=>b.onclick=()=>{img.src=b.dataset.src;cap.textContent=b.dataset.cap||"";lb.showModal()});
lb.onclick=()=>lb.close();
const items=[...document.querySelectorAll(".item")],tg=document.querySelector("nav .toggle");
document.querySelectorAll("nav button[data-f]").forEach(b=>b.onclick=()=>{
  document.querySelectorAll("nav button[data-f]").forEach(x=>x.setAttribute("aria-pressed",x===b));
  document.querySelectorAll("section[data-cat]").forEach(s=>s.hidden=!!b.dataset.f&&s.dataset.cat!==b.dataset.f);
});
if(tg)tg.onclick=()=>{const open=!items.every(d=>d.open);items.forEach(d=>d.open=open);tg.textContent=open?"全部收起":"全部展开"};
</script></html>`);
}
