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
};
const CAT_ORDER = ["反馈", "状态", "流程", "操作", "呈现"];
const VIEWPORT = { desktop: "桌面", mobile: "手机" };

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
  return `<article class="card${note ? " doubt" : ""}" data-cat="${esc(i.cat)}">
  <div class="body">
    <div class="head"><span class="tag ${note ? "t-doubt" : "t-sure"}">${note ? "疑似" : "确定"}</span><h3>${esc(RULE_LABEL[i.rule] ?? i.rule)}</h3><code class="rule">${esc(i.rule)}</code></div>
    <p class="msg">${esc(text)}</p>
    ${detail ? `<pre class="detail">${esc(detail)}</pre>` : ""}
    ${note ? `<p class="note">${esc(note)}</p>` : ""}
    <div class="meta">${i.viewports.map((v) => `<span class="vp">${esc(VIEWPORT[v] ?? v)}</span>`).join("")}${i.pages.map((p) => `<span class="pg" title="${esc(page(p))}">${esc(page(p))}</span>`).join("")}</div>
  </div>
  ${i.shot ? `<button class="shot${tall ? " tall" : ""}" type="button" data-src="${esc(i.shot)}" aria-label="查看截图"><img src="${esc(i.shot)}" loading="lazy" alt=""><span>查看截图</span></button>` : ""}
</article>`;
}

export function writeHtml(report, file) {
  const issues = report.issues;
  const cats = [...new Set(issues.map((i) => i.cat))].sort((a, b) => (CAT_ORDER.indexOf(a) + 99) % 99 - (CAT_ORDER.indexOf(b) + 99) % 99);
  const doubt = issues.filter((i) => /（疑似：/.test(i.msg)).length;
  const pages = new Set(issues.flatMap((i) => i.pages)).size;
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
dialog{border:0;padding:0;background:transparent;max-width:min(1200px,94vw);max-height:92vh}
dialog::backdrop{background:rgba(10,12,16,.8)}
dialog img{display:block;max-width:100%;max-height:92vh;border-radius:8px;cursor:zoom-out}
@media (max-width:720px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.card{flex-direction:column;gap:12px}.shot,.shot.tall{width:100%;height:200px}}
</style>
<div class="wrap">
<header><h1>${esc(report.project ?? "UX")} 的 UX 检查报告</h1><p class="sub">${report.finishedAt ? esc(new Date(report.finishedAt).toLocaleString("zh-CN", { hour12: false })) + " · " : ""}沙箱地址 ${esc(report.app)}</p></header>
<div class="stats">
  <div class="stat"><b>${issues.length}</b><span>问题</span></div>
  <div class="stat"><b>${issues.length - doubt} / ${doubt}</b><span>确定 / 疑似</span></div>
  <div class="stat"><b>${pages}</b><span>涉及页面 · 用时 ${esc(report.seconds)}s</span></div>
  <div class="stat ${safe ? "ok" : "bad"}"><b>${safe ? "✓ 数据未改动" : "⚠ 请核对"}</b><span>${esc(report.isolation ?? "")}</span></div>
</div>
${issues.length ? `<nav aria-label="按类型筛选"><button type="button" data-f="" aria-pressed="true">全部<em>${issues.length}</em></button>${cats.map((c) => `<button type="button" data-f="${esc(c)}" aria-pressed="false">${esc(c)}<em>${issues.filter((i) => i.cat === c).length}</em></button>`).join("")}</nav>${sections}` : `<div class="empty"><b>没有发现问题</b>报告干净不代表体验好：文案、流程是否合理仍需人看</div>`}
</div>
<dialog id="lb"><img alt=""></dialog>
<script>
const lb=document.getElementById("lb"),img=lb.querySelector("img");
document.querySelectorAll(".shot").forEach(b=>b.onclick=()=>{img.src=b.dataset.src;lb.showModal()});
lb.onclick=()=>lb.close();
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{
  document.querySelectorAll("nav button").forEach(x=>x.setAttribute("aria-pressed",x===b));
  document.querySelectorAll("section").forEach(s=>s.hidden=!!b.dataset.f&&s.dataset.cat!==b.dataset.f);
});
</script></html>`);
}
