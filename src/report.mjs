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
const needsReview = (i) => i.severity === "warning" || ["heuristic", "diagnostic"].includes(i.confidence) || /（疑似：/.test(i.msg);

// 把「说明（疑似：…）」和「console: 原始报错」从正文里拆出来，分开排版
function split(msg) {
  let text = String(msg), note = "", detail = "";
  const n = text.match(/（疑似：(.*?)）\s*$/); if (n) { note = n[1]; text = text.slice(0, n.index); }
  const d = text.indexOf("console: "); if (d >= 0) { detail = text.slice(d + 9).trim(); text = text.slice(0, d).replace(/[：:]\s*$/, ""); }
  return { text: text.trim(), note, detail };
}

const page = (p) => { try { return decodeURIComponent(p); } catch { return p; } };

function card(i) {
  const { text, note, detail } = split(i.msg);
  const tall = i.viewports.includes("mobile") && !i.viewports.includes("desktop");
  const review = needsReview(i); const badge = i.confidence === "diagnostic" ? "诊断" : review ? "需复核" : "确定";
  return `<article class="card${review ? " doubt" : ""}" data-cat="${esc(i.cat)}">
  <div class="body">
    <div class="head"><span class="tag ${review ? "t-doubt" : "t-sure"}">${badge}</span><h3>${esc(RULE_LABEL[i.rule] ?? i.rule)}</h3><code class="rule">${esc(i.rule)}</code></div>
    <p class="msg">${esc(text)}</p>
    ${detail ? `<pre class="detail">${esc(detail)}</pre>` : ""}
    ${note ? `<p class="note">${esc(note)}</p>` : ""}
    ${i.states?.length ? `<p class="note">状态路径：${i.states.map(esc).join("；")}</p>` : ""}
    <div class="meta">${i.viewports.map((v) => `<span class="vp">${esc(VIEWPORT[v] ?? v)}</span>`).join("")}${i.pages.map((p) => `<span class="pg" title="${esc(page(p))}">${esc(page(p))}</span>`).join("")}</div>
  </div>
  ${i.shot ? `<button class="shot${tall ? " tall" : ""}" type="button" data-src="${esc(i.shot)}" aria-label="查看截图"><img src="${esc(i.shot)}" loading="lazy" alt=""><span>查看截图</span></button>` : ""}
</article>`;
}

export function writeHtml(report, file) {
  const issues = report.issues;
  const cats = [...new Set(issues.map((i) => i.cat))].sort((a, b) => (CAT_ORDER.indexOf(a) + 99) % 99 - (CAT_ORDER.indexOf(b) + 99) % 99);
  const doubt = issues.filter(needsReview).length;
  const pages = report.scannedPages?.length ?? new Set(issues.flatMap((i) => i.pages)).size;
  const coverage = report.coverage ?? { summary: { checked: 0, skipped: 0, error: 0 }, records: [] };
  const incomplete = coverage.summary.error > 0 || coverage.summary.skipped > 0;
  const coverageHtml = `<section class="coverage"><h2>检查覆盖情况</h2><p>已完成 ${coverage.summary.checked} 项 · 跳过 ${coverage.summary.skipped} 项 · 检查失败 ${coverage.summary.error} 项。跳过和检查失败不代表通过。</p><details><summary>查看检查记录与未测原因</summary><table><thead><tr><th>检查</th><th>页面 / 视口</th><th>结果 / 原因</th></tr></thead><tbody>${coverage.records.map((r) => `<tr><td>${esc(r.check)}</td><td>${esc(r.page ?? r.scenario ?? "全局")} ${esc(VIEWPORT[r.vp] ?? r.vp ?? "")}${r.state ? ` · ${esc(r.state)}` : ""}</td><td>${esc({ checked: "已完成", skipped: "跳过", error: "检查失败" }[r.status] ?? r.status)}${r.reason ? `：${esc(r.reason)}` : ""}</td></tr>`).join("")}</tbody></table></details></section>`;
  const limitations = report.limitations ?? ["自动检查不能替代真实设备、辅助技术与业务流程验证。"];
  const safe = /一致/.test(report.isolation ?? "");
  const sections = cats.map((c) => {
    const items = issues.filter((i) => i.cat === c).sort((a, b) => /（疑似：/.test(a.msg) - /（疑似：/.test(b.msg));
    return `<section data-cat="${esc(c)}"><h2>${esc(c)}<span>${items.length}</span></h2>${items.map(card).join("")}</section>`;
  }).join("");

  writeFileSync(file, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(report.project ?? "UX")} 检查报告</title>
<style>
:root{--bg:#f4f6f9;--panel:#fff;--fg:#1b2230;--m:#667085;--line:#e4e8ee;--soft:#f7f8fa;--accent:#2f6bff;--sure:#d92d20;--sure-bg:#fef3f2;--doubt:#b54708;--doubt-bg:#fffaeb;--ok:#067647;--ok-bg:#ecfdf3;--code:#f2f4f7;--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1217;--panel:#171b22;--fg:#e7eaf0;--m:#98a2b3;--line:#272d37;--soft:#1c212a;--accent:#7aa2ff;--sure:#f97066;--sure-bg:#2a1714;--doubt:#fdb022;--doubt-bg:#2a2210;--ok:#47cd89;--ok-bg:#102a1d;--code:#1f2530;--shadow:none}}
:root[data-theme="dark"]{--bg:#0f1217;--panel:#171b22;--fg:#e7eaf0;--m:#98a2b3;--line:#272d37;--soft:#1c212a;--accent:#7aa2ff;--sure:#f97066;--sure-bg:#2a1714;--doubt:#fdb022;--doubt-bg:#2a2210;--ok:#47cd89;--ok-bg:#102a1d;--code:#1f2530;--shadow:none}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:32px 16px 64px}
header h1{margin:0;font-size:24px;letter-spacing:.01em}
.sub{margin:6px 0 0;color:var(--m);font-size:13px;word-break:break-all}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:24px 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow)}
.stat b{display:block;font-size:24px;line-height:1.2;font-variant-numeric:tabular-nums}
.stat span{color:var(--m);font-size:12px}
.stat.ok b{color:var(--ok);font-size:16px;line-height:1.9}.stat.bad b{color:var(--sure);font-size:16px;line-height:1.9}
nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;position:sticky;top:0;padding:10px 0;background:var(--bg);z-index:2}
nav button{font:inherit;font-size:13px;color:var(--m);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:5px 14px;cursor:pointer;min-height:32px}
nav button[aria-pressed="true"]{color:#fff;background:var(--accent);border-color:var(--accent)}
nav button em{font-style:normal;opacity:.75;margin-left:4px}
section{margin-top:20px}
h2{display:flex;align-items:center;gap:8px;font-size:15px;margin:0 0 10px;color:var(--m);font-weight:600}
h2 span{font-size:12px;background:var(--code);border-radius:999px;padding:0 8px;color:var(--m)}
.card{display:flex;gap:20px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--sure);border-radius:12px;padding:16px 18px;margin-bottom:12px;box-shadow:var(--shadow)}
.card.doubt{border-left-color:var(--doubt)}
.body{flex:1;min-width:0}
.head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
h3{margin:0;font-size:16px}
.tag{font-size:12px;font-weight:600;border-radius:6px;padding:1px 8px}
.t-sure{color:var(--sure);background:var(--sure-bg)}.t-doubt{color:var(--doubt);background:var(--doubt-bg)}
.rule{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--m)}
.msg{margin:8px 0 0}
.detail{margin:8px 0 0;padding:8px 10px;background:var(--code);border-radius:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;color:var(--fg)}
.note{margin:8px 0 0;font-size:13px;color:var(--doubt)}
.note::before{content:"判断：";font-weight:600}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.meta span{font-size:12px;border-radius:6px;padding:2px 8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vp{background:var(--accent);color:#fff}
.pg{background:var(--soft);border:1px solid var(--line);color:var(--m);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.shot{flex:none;width:240px;height:150px;padding:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;cursor:zoom-in;position:relative;background:var(--soft)}
.shot.tall{width:120px;height:180px}
.shot img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.shot span{position:absolute;inset:auto 0 0 0;font-size:12px;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.55));padding:14px 8px 6px;opacity:0;transition:opacity .15s}
.shot:hover span,.shot:focus-visible span{opacity:1}
.empty{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:48px 16px;text-align:center;color:var(--m)}
.empty b{display:block;color:var(--ok);font-size:18px;margin-bottom:4px}
.empty.incomplete b{color:var(--doubt)}.coverage{background:var(--panel);padding:16px;border:1px solid var(--line);border-radius:12px}.coverage table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}.coverage th,.coverage td{padding:8px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.coverage details{overflow:auto}.limitations{color:var(--m);font-size:13px;margin-top:24px}
dialog{border:0;padding:0;background:transparent;max-width:min(1200px,94vw);max-height:92vh}
dialog::backdrop{background:rgba(10,12,16,.8)}
dialog img{display:block;max-width:100%;max-height:92vh;border-radius:8px;cursor:zoom-out}
@media (max-width:720px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.card{flex-direction:column;gap:12px}.shot,.shot.tall{width:100%;height:200px}}
</style>
<div class="wrap">
<header><h1>${esc(report.project ?? "UX")} 的 UX 检查报告</h1><p class="sub">${report.finishedAt ? esc(new Date(report.finishedAt).toLocaleString("zh-CN", { hour12: false })) + " · " : ""}沙箱地址 ${esc(report.app)}</p></header>
<div class="stats">
  <div class="stat"><b>${issues.length}</b><span>问题</span></div>
  <div class="stat"><b>${issues.length - doubt} / ${doubt}</b><span>确定 / 需复核与诊断</span></div>
  <div class="stat"><b>${pages}</b><span>已扫描页面 · 用时 ${esc(report.seconds)}s</span></div>
  <div class="stat ${safe ? "ok" : "bad"}"><b>${safe ? "✓ 数据未改动" : "⚠ 请核对"}</b><span>${esc(report.isolation ?? "")}</span></div>
</div>
${issues.length ? `<nav aria-label="按类型筛选"><button type="button" data-f="" aria-pressed="true">全部<em>${issues.length}</em></button>${cats.map((c) => `<button type="button" data-f="${esc(c)}" aria-pressed="false">${esc(c)}<em>${issues.filter((i) => i.cat === c).length}</em></button>`).join("")}</nav>${sections}` : `<div class="empty${incomplete ? " incomplete" : ""}"><b>${coverage.summary.error ? "检查未完成" : incomplete ? "已完成部分未发现问题" : "没有发现问题"}</b>${incomplete ? "仍有跳过或失败的检查，请查看下方覆盖记录。" : "报告干净不代表体验好：文案、流程是否合理仍需人看"}</div>`}
${coverageHtml}<div class="limitations"><b>检测边界</b><ul>${limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>
</div>
<dialog id="lb"><img alt=""></dialog>
<script>
const lb=document.getElementById("lb"),img=lb.querySelector("img");
document.querySelectorAll(".shot").forEach(b=>b.onclick=()=>{img.src=b.dataset.src;lb.showModal()});
lb.onclick=()=>lb.close();
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{
  document.querySelectorAll("nav button").forEach(x=>x.setAttribute("aria-pressed",x===b));
  document.querySelectorAll("section[data-cat]").forEach(s=>s.hidden=!!b.dataset.f&&s.dataset.cat!==b.dataset.f);
});
</script></html>`);
}
