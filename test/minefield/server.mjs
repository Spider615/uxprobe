// 埋雷应用：每个 /m/<id> 页面埋一个 UX bug，/ok/* 是故意做对的对照页（专门放容易误报的写法）。
// FIXED=1 时所有雷都修好，用来反向验证规则修好后不再报。
// 数据存在 ./data/db.json，每次请求都读写文件，方便沙箱直接换文件重置。
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FIXED = process.env.FIXED === "1";
const PORT = Number(process.env.PORT || 4600);
const DB = join(process.env.DATA_DIR || join(import.meta.dirname, "data"), "db.json");
const load = () => JSON.parse(readFileSync(DB, "utf8"));
const save = (db) => writeFileSync(DB, JSON.stringify(db, null, 2));
if (!existsSync(DB)) throw new Error(`缺少 ${DB}`);

const CSS = `
*{box-sizing:border-box} body{margin:0;font:15px/1.6 -apple-system,"PingFang SC",sans-serif;color:#1d2433;background:#fff}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid #e3e8ef}
header a{display:inline-block;padding:6px 10px;color:#1d4ed8;text-decoration:none}
main{padding:16px;max-width:960px}
button{font:inherit;padding:8px 14px;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;border-radius:8px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
input,textarea{font:inherit;padding:8px;border:1px solid #9aa4b2;border-radius:8px}
ul{padding-left:0;list-style:none} li{padding:8px 0;border-bottom:1px solid #eef1f5}
.nav a,a.back{display:inline-block;padding:8px 4px}
.toast{position:fixed;right:16px;bottom:16px;background:#1d2433;color:#fff;padding:10px 14px;border-radius:8px}
.muted{color:#4b5565}
`;
const TOAST = `function toast(t){const d=document.createElement('div');d.className='toast';d.setAttribute('role','status');d.textContent=t;document.body.append(d);setTimeout(()=>d.remove(),2000)}`;

function page(title, body, script = "", { nav = true, css = "" } = {}) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${CSS}${css}</style></head><body>
${nav ? `<header><a href="/">首页</a><strong>${title}</strong></header>` : ""}
<main>${body}</main><script>${TOAST}\n${script}</script></body></html>`;
}

// 列表页的通用加载代码：按参数决定 加载中 / 失败 / 空 三种状态写得对不对。
function listScript({ loading = "加载中…", onError = "showError", empty = "还没有活动，点上方「新建」开始", render = "i=>`<li>${esc(i.title)}</li>`" } = {}) {
  return `const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
const root=document.getElementById('list');root.innerHTML=${JSON.stringify(loading)};
function showError(){root.innerHTML='加载失败，请稍后重试 <button onclick="location.reload()">重试</button>'}
function showEmpty(){root.innerHTML=${JSON.stringify(empty)}}
fetch('/api/items').then(r=>{if(!r.ok)throw new Error(r.status);return r.json()}).then(d=>{
  const items=d.items; if(!items.length) return ${empty === null ? "void (root.innerHTML='')" : "showEmpty()"};
  root.innerHTML='<ul>'+items.map(${render}).join('')+'</ul>';
}).catch(${onError});`;
}

const mines = {
  // ---- 呈现 ----
  overflow: () => page("活动看板", `<div style="width:${FIXED ? "100%" : "640px"};padding:12px;border:1px solid #e3e8ef">本月活动共 12 场，详细数据见下方表格。</div>`),
  truncated: () => page("活动列表", `<div id="list"></div>`, listScript({ render: `i=>\`<li><span ${FIXED ? 'title="${esc(i.title)}"' : ""} style="display:inline-block;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom">\${esc(i.title)}</span></li>\`` })),
  image: () => page("品牌", `<img src="${FIXED ? "/logo.svg" : "/missing-logo.png"}" width="80" height="80" alt="品牌 logo"><p>品牌介绍</p>`),
  raw: () => page("活动详情", `<p id="o">加载中…</p>`, `const o=document.getElementById('o');fetch('/api/items').then(r=>{if(!r.ok)throw r.status;return r.json()}).then(d=>{const i=d.items[0];${FIXED ? "o.textContent=i?'负责人：'+(i.owner??'未指定'):'还没有活动'" : "o.textContent='负责人：'+i.ownr"}}).catch(()=>o.textContent='加载失败，请稍后重试')`),
  longtext: () => page("活动卡片", `<div id="list"></div>`, listScript({ render: `i=>\`<li style="display:flex;gap:8px;padding:6px 0"><b style="${FIXED ? "min-width:0;overflow-wrap:anywhere" : "white-space:nowrap"}">\${esc(i.title)}</b><span class="muted" style="${FIXED ? "min-width:0;overflow-wrap:anywhere" : "white-space:nowrap"}">\${esc(i.note)}</span></li>\`` })),
  // ---- 操作 ----
  small: () => page("通知", `<p>你有 1 条新通知 <button aria-label="关闭通知" style="${FIXED ? "width:32px;height:32px" : "width:16px;height:16px;padding:0;font-size:10px;line-height:1"}" onclick="this.parentElement.remove()">×</button></p>`),
  occluded: () => page("优惠券", `<div style="position:relative;padding:24px;border:1px solid #e3e8ef"><button onclick="this.textContent='已领取'">领取优惠券</button>
    <div style="position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.01));${FIXED ? "pointer-events:none" : ""}"></div></div>`),
  enter: () => page("搜索", FIXED
    ? `<form onsubmit="event.preventDefault();go()"><input id="q" aria-label="搜活动" placeholder="搜活动"> <button>搜索</button></form><ul id="r"></ul>`
    : `<div><input id="q" aria-label="搜活动" placeholder="搜活动"> <button onclick="go()">搜索</button></div><ul id="r"></ul>`,
    `function go(){fetch('/api/search?q='+encodeURIComponent(q.value)).then(r=>r.json()).then(d=>{r.innerHTML=d.items.map(i=>'<li>'+(i.title??'未命名')+'</li>').join('')||'<li>没有找到</li>'})}`),
  hover: () => page("成员", `<ul>${["张三", "李四"].map((n) => `<li class="row">${n} <button class="edit" onclick="this.textContent='编辑中'">编辑</button></li>`).join("")}</ul>`, "", { css: FIXED ? "" : ".row .edit{opacity:0}.row:hover .edit{opacity:1}" }),
  clickdiv: () => page("报表", FIXED ? `<button onclick="this.textContent='已打开'">打开月度报表</button>` : `<div style="cursor:pointer;padding:12px;border:1px solid #e3e8ef;display:inline-block" onclick="this.textContent='已打开'">打开月度报表</div>`),
  // ---- 反馈 ----
  nofeedback: () => page("导出", `<button onclick="${FIXED ? "toast('已开始导出，完成后会通知你')" : "void 0"}">导出报表</button>`),
  throw: () => page("设置", `<p id="s">通知：开</p><button onclick="save()">保存设置</button>`, `function save(){const cfg=${FIXED ? "{notify:true}" : "undefined"};document.getElementById('s').textContent='通知：'+(cfg.notify?'开':'关');toast('已保存')}`),
  "error-empty": () => page("活动", `<div id="list"></div>`, listScript({ empty: "暂无数据", onError: FIXED ? "showError" : "showEmpty" })),
  "loading-empty": () => page("活动", `<div id="list"></div>`, listScript({ loading: FIXED ? "加载中…" : "暂无数据", empty: "暂无数据" })),
  "silent-write": () => page("意见反馈", `<form id="f"><textarea id="t" aria-label="反馈内容"></textarea><br><button id="b">提交</button></form><p id="m" role="status"></p>`,
    `f.onsubmit=e=>{e.preventDefault();${FIXED ? "b.disabled=true;" : ""}fetch('/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t.value})}).then(r=>{${FIXED ? "if(r.ok){m.textContent='已提交，感谢反馈';t.value=''}" : ""}})}`),
  double: () => page("下单", `<button id="b">创建订单</button><p id="m" role="status"></p>`,
    `b.onclick=async()=>{${FIXED ? "b.disabled=true;" : ""}const r=await fetch('/api/orders',{method:'POST'});const d=await r.json();m.textContent='已创建订单 #'+d.id;${FIXED ? "b.disabled=false;" : ""}}`),
  console: () => page("首页配置", `<p>欢迎回来</p>${FIXED ? "" : `<script src="/vendor/analytics.js"></script>`}`),
  "stuck-loading": () => page("活动", `<div id="list"></div>`, listScript({ onError: FIXED ? "showError" : "()=>{}" })),
  // ---- 状态 ----
  stale: () => page("活动", `<form id="f"><input id="t" aria-label="活动名称" placeholder="活动名称"> <button id="b">新建</button></form><div id="list"></div>`,
    listScript() + `\nf.onsubmit=async e=>{e.preventDefault();${FIXED ? "b.disabled=true;" : ""}const r=await fetch('/api/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:t.value})});if(r.ok){t.value='';toast('已添加');${FIXED ? "location.reload()" : ""}}}`),
  lost: () => page("个人签名", `<p id="cur">加载中…</p><form id="f"><input id="sig" aria-label="新签名" placeholder="新签名"> <button id="b">保存</button></form>`,
    `const show=v=>cur.textContent='当前签名：'+(v??'未设置');fetch('/api/profile').then(r=>r.json()).then(d=>show(d.signature));
f.onsubmit=async e=>{e.preventDefault();${FIXED ? "b.disabled=true;" : ""}const v=sig.value;const r=await fetch('/api/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(${FIXED ? "{signature:v}" : "{sig:v}"})});${FIXED ? "b.disabled=false;" : ""}if(r.ok){show(v);sig.value='';toast('已保存')}}`),
  race: () => page("找门店", `<input id="q" aria-label="门店名" placeholder="输入门店名"><ul id="r"><li>输入关键词搜索</li></ul>`,
    `let seq=0;q.oninput=()=>{const my=++seq;fetch('/api/search?q='+encodeURIComponent(q.value)).then(x=>x.json()).then(d=>{${FIXED ? "if(my!==seq)return;" : ""}r.innerHTML=d.items.map(i=>'<li>'+(i.title??'未命名')+'</li>').join('')||'<li>没有找到「'+d.q+'」</li>'})}`),
  // ---- 流程 ----
  "no-empty": () => page("我的活动", `<div id="list"></div>`, listScript({ empty: FIXED ? "还没有活动，点上方「新建」开始" : null })),
  retry: () => page("活动详情", `<div id="d">加载中…</div>`,
    `fetch('/api/items/999').then(r=>{if(!r.ok)throw r.status;return r.json()}).then(i=>d.textContent=i.title).catch(s=>{${FIXED ? `d.innerHTML=s===404?'这条活动不存在或已被删除，<a href="/m/truncated">返回活动列表</a>':'加载失败 <button onclick="location.reload()">重试</button>'` : `d.innerHTML='加载失败 <button onclick="location.reload()">重试</button>'`}})`),
  null: () => page("活动标签", `<div id="list"></div>`, listScript({ render: FIXED ? "i=>`<li>${esc(i.title??'未命名')}：${esc((i.tags??[]).join('、')||'无标签')}</li>`" : "i=>`<li>${esc(i.title)}：${esc(i.tags.join('、'))}</li>`" })),
};

const okPages = {
  sidebar: () => page("侧栏", `<div style="display:flex;gap:16px"><aside style="width:220px;height:420px;display:flex;flex-direction:column;border:1px solid #e3e8ef">
    <div style="flex:1;min-height:0;overflow-y:auto">${Array.from({ length: 40 }, (_, i) => `<a href="/ok/sidebar" style="display:block;padding:10px 12px;color:#1d2433;text-decoration:none">对话记录 ${i + 1}</a>`).join("")}</div>
    <div style="padding:12px;background:#f5f8fc">底部说明卡片</div></aside><p>内容区</p></div>`),
  files: () => page("文件", `<input id="file" type="file" hidden><button onclick="file.click()">上传文件</button>
    <button onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['a,b\\n']));a.download='模板.csv';a.click()">下载模板</button>`),
  ellipsis: () => page("省略", `<span title="一个很长很长很长很长很长很长的标题" style="display:inline-block;max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">一个很长很长很长很长很长很长的标题</span>`),
  list: () => page("完整列表", `<div id="list"></div>`, listScript({ loading: "正在读取…", render: "i=>`<li><span style=\"min-width:0;overflow-wrap:anywhere\">${esc(i.title??'未命名')}</span> <button onclick=\"del(${i.id})\">删除</button></li>`" }) +
    `\nasync function del(id){if(!confirm('确定删除？'))return;const r=await fetch('/api/items/'+id,{method:'DELETE'});if(r.ok){toast('已删除');location.reload()}else toast('删除失败')}`, { css: "#list li{display:flex;justify-content:space-between;align-items:center}" }),
  form: () => page("新建活动", `<form id="f"><input id="t" aria-label="活动名称" placeholder="活动名称"> <button id="b">新建</button></form><div id="list"></div>`,
    listScript() + `\nf.onsubmit=async e=>{e.preventDefault();b.disabled=true;const r=await fetch('/api/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:t.value})});b.disabled=false;if(r.ok){t.value='';location.reload()}else toast('新建失败')}`),
  article: () => page("说明", `<p>本工具用于活动复盘，详细口径见<a href="/ok/ellipsis">口径说明</a>，问题请看<a href="/ok/list">常见问题</a>。</p>`),
  modal: () => page("弹窗", `<button onclick="dlg.showModal()">查看规则</button><dialog id="dlg"><p>活动规则说明</p><button onclick="dlg.close()">关闭</button></dialog>`),
};

const home = () => page("埋雷应用", `<ul class="nav">${[...Object.keys(mines).map((k) => `/m/${k}`), "/m/item/1", ...Object.keys(okPages).map((k) => `/ok/${k}`)]
  .map((p) => `<li><a href="${p}">${p}</a></li>`).join("")}</ul>`, "", { nav: false });

// 详情页：dead-end 雷，FIXED 时带导航和返回链接。
function detail(id) {
  const item = load().items.find((i) => String(i.id) === id);
  const body = item ? `<h1>${item.title}</h1><p>${item.note}</p>` : `<p>未找到这条活动</p>`;
  return page("活动详情", body + (FIXED ? `<p><a class="back" href="/m/truncated">返回活动列表</a></p>` : ""), "", { nav: FIXED });
}

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok({}); } }); });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"); const p = url.pathname; const m = req.method;
  if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
  if (p === "/logo.svg") { res.writeHead(200, { "content-type": "image/svg+xml" }); return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#1d4ed8"/></svg>`); }
  if (p === "/api/items" && m === "GET") return json(res, 200, { items: load().items });
  if (p === "/api/items" && m === "POST") { const b = await readBody(req); const db = load(); const item = { id: db.nextId++, title: b.title || "未命名", note: "", owner: "我", tags: [] }; db.items.push(item); save(db); return json(res, 201, item); }
  const im = p.match(/^\/api\/items\/(\d+)$/);
  if (im && m === "GET") { const i = load().items.find((x) => x.id === Number(im[1])); return i ? json(res, 200, i) : json(res, 404, { error: "not found" }); }
  if (im && m === "DELETE") { const db = load(); db.items = db.items.filter((x) => x.id !== Number(im[1])); save(db); return json(res, 200, { ok: true }); }
  if (p === "/api/search") { const q = url.searchParams.get("q") || ""; return json(res, 200, { q, items: load().items.filter((i) => i.title.includes(q)) }); }
  if (p === "/api/feedback" && m === "POST") { const b = await readBody(req); const db = load(); db.feedback.push(b.text || ""); save(db); return json(res, 201, { ok: true }); }
  if (p === "/api/orders" && m === "POST") { await new Promise((r) => setTimeout(r, 800)); const db = load(); const id = db.nextId++; db.orders.push(id); save(db); return json(res, 201, { id }); }
  if (p === "/api/profile" && m === "GET") return json(res, 200, { signature: load().profile.signature });
  if (p === "/api/profile" && m === "PUT") { const b = await readBody(req); const db = load(); if (typeof b.signature === "string") db.profile.signature = b.signature; save(db); return json(res, 200, { ok: true }); }
  const html = (s) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(s); };
  if (p === "/") return html(home());
  const dm = p.match(/^\/m\/item\/([^/]+)$/); if (dm) return html(detail(dm[1]));
  const mm = p.match(/^\/m\/([\w-]+)$/); if (mm && mines[mm[1]]) return html(mines[mm[1]]());
  const om = p.match(/^\/ok\/([\w-]+)$/); if (om && okPages[om[1]]) return html(okPages[om[1]]());
  json(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`minefield ready http://127.0.0.1:${PORT} fixed=${FIXED}`));
