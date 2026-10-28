// 从起始页沿同源链接发现页面。路径里像 ID 的段（数字、UUID、长哈希）折叠成一类，每类只测一个。
import { settle } from "./browser.mjs";

export const routePath = (url) => { const u = new URL(url, "http://local"); return u.pathname + u.search + u.hash; };
export const template = (path) => {
  const u = new URL(path, "http://local");
  return u.pathname.split("/").map((seg) => {
  let s; try { s = decodeURIComponent(seg); } catch { s = seg; }
  return /^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) || /^[\w-]*:[\w-]{8,}$/.test(s) ? ":id" : seg;
  }).join("/") + u.search + u.hash;
};

export async function discover(ctx, base, seeds, max, { onSkip = () => {}, onPage = () => {} } = {}) {
  const seen = new Map(); const visited = new Set(); const queue = seeds.map((path) => ({ path: routePath(path), from: null }));
  const page = await ctx.newPage();
  try { while (queue.length && seen.size < max) {
    const { path, from } = queue.shift(); const t = template(path);
    if (visited.has(path)) continue;
    visited.add(path);
    if (seen.has(t)) { onSkip({ page: path, reason: `同路由模板已抽样：${t}` }); continue; }
    const res = await page.goto(new URL(path, base).href).catch((e) => { onSkip({ page: path, reason: `页面发现失败：${e.message}` }); return null; });
    await settle(page, 300);
    if (new URL(page.url()).origin !== new URL(base).origin) { onSkip({ page: path, reason: "跳转到了应用来源之外" }); continue; }
    const finalPath = routePath(page.url());
    // 跳转（比如 / → /analysis）只记落地页
    if (finalPath !== path) { if (!seen.has(template(finalPath))) queue.unshift({ path: finalPath, from }); continue; }
    seen.set(t, { path, status: res?.status() ?? 0 });
    onPage({ path, status: res?.status() ?? 0, from });
    const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href)).catch(() => []);
    for (const href of links) {
      const u = new URL(href, base);
      if (u.origin !== new URL(base).origin || /\.(csv|xlsx?|pdf|zip|png|jpe?g|svg)$/i.test(u.pathname)) continue;
      const target = routePath(u.href);
      if (!visited.has(target)) queue.push({ path: target, from: path });
    }
  }
  if (queue.length) onSkip({ reason: `达到页面上限 ${max}，还有 ${queue.length} 个候选入口未检查` });
  return [...seen.values()].map((p) => p.path);
  } finally { await page.close(); }
}
