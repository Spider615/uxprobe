import { writeFileSync } from "node:fs";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function writeHtml(report, file) {
  const cats = [...new Set(report.issues.map((i) => i.cat))];
  const body = cats.map((c) => {
    const items = report.issues.filter((i) => i.cat === c);
    return `<h2>${esc(c)} <small>${items.length}</small></h2>` + items.map((i) => `<details><summary><code>${esc(i.rule)}</code> ${esc(i.msg)}
      <span class="m">${esc(i.viewports.join("/"))} · ${i.pages.length} 个页面</span></summary>
      <p class="m">${i.pages.map(esc).join("<br>")}</p>${i.shot ? `<a href="${esc(i.shot)}"><img src="${esc(i.shot)}" loading="lazy" alt=""></a>` : ""}</details>`).join("");
  }).join("");
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UX 检查报告</title>
<style>:root{--bg:#fff;--fg:#1d2433;--m:#5b6475;--line:#e3e8ef}@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e9ef;--m:#9aa3b2;--line:#2a2f37}}
body{margin:0 auto;max-width:960px;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"PingFang SC",sans-serif}
h2 small,.m{color:var(--m);font-size:13px;font-weight:normal}details{border-bottom:1px solid var(--line);padding:8px 0}summary{cursor:pointer}
code{font-size:12px;padding:1px 6px;border:1px solid var(--line);border-radius:4px;margin-right:4px}img{max-width:100%;border:1px solid var(--line);margin-top:8px}</style>
<h1>UX 检查报告</h1><p class="m">${esc(report.app)} · ${report.issues.length} 个问题 · 用时 ${report.seconds}s · ${esc(report.isolation)}</p>${body || "<p>没有发现问题</p>"}`);
}
