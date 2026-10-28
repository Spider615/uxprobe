// 从起始页沿同源链接发现页面。路径里像 ID 的段（数字、UUID、长哈希）折叠成一类，每类只测一个。
import { settle } from "./browser.mjs";

export const template = (path) => path.split("/").map((seg) => {
  const s = decodeURIComponent(seg);
  return /^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) || /^[\w-]*:[\w-]{8,}$/.test(s) ? ":id" : seg;
}).join("/");

export async function discover(ctx, base, seeds, max) {
  const seen = new Map(); const queue = [...seeds];
  const page = await ctx.newPage();
  while (queue.length && seen.size < max) {
    const path = queue.shift(); const t = template(path);
    if (seen.has(t)) continue;
    const res = await page.goto(base + path).catch(() => null);
    await settle(page, 300);
    const finalPath = new URL(page.url()).pathname;
    // 跳转（比如 / → /analysis）只记落地页
    if (finalPath !== path) { if (!seen.has(template(finalPath))) queue.unshift(finalPath); if (!seen.has(t)) seen.set(t, null); continue; }
    seen.set(t, { path, status: res?.status() ?? 0 });
    const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href)).catch(() => []);
    for (const href of links) {
      const u = new URL(href, base);
      if (u.origin !== new URL(base).origin || /\.(csv|xlsx?|pdf|zip|png|jpe?g|svg)$/i.test(u.pathname)) continue;
      if (!seen.has(template(u.pathname))) queue.push(u.pathname);
    }
  }
  await page.close();
  return [...seen.values()].filter(Boolean).filter((p) => p.status < 400 || p.status === 0).map((p) => p.path);
}
