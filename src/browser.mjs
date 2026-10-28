// 浏览器公共能力：只放行本机请求、收集报错、等页面稳定、读页面文字。
import { chromium } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 760 } };
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Playwright 自带浏览器版本不匹配时，用本机已有的 Chromium
function findChromium() {
  if (process.env.UXPROBE_CHROME) return process.env.UXPROBE_CHROME;
  try { const p = chromium.executablePath(); if (existsSync(p)) return undefined; } catch {}
  const cache = join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const d of readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
    for (const sub of ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const p = join(cache, d, sub); if (existsSync(p)) return p;
    }
  }
  return undefined;
}

export async function launch(headless = true) {
  return chromium.launch({ headless, executablePath: findChromium() });
}

export async function newContext(browser, viewport, storageState) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[viewport], ...(viewport === "mobile" ? { isMobile: true, hasTouch: true } : {}), ...(storageState ? { storageState } : {}), acceptDownloads: true });
  await ctx.route("**/*", (route) => (LOCAL.has(new URL(route.request().url()).hostname) ? route.continue() : route.abort()));
  return ctx;
}

const isStatic = (url) => /\/@vite\/|\/@fs\/|\/@id\/|\/node_modules\/|\/_next\/static\/|\/__vite|\.(js|mjs|css|map|woff2?|ttf|png|jpe?g|gif|svg|ico|webp)(\?|$)/.test(new URL(url).pathname) || new URL(url).searchParams.has("_rsc");
export const isApi = (req) => ["fetch", "xhr"].includes(req.resourceType()) && !isStatic(req.url()) && LOCAL.has(new URL(req.url()).hostname);
export const isWrite = (req) => isApi(req) && req.method() !== "GET" && req.method() !== "HEAD";

// 收集页面上的报错，供各项检查使用
export function watch(page) {
  const log = { errors: [], http: [], api: [] };
  page.on("pageerror", (e) => log.errors.push(String(e.message).split("\n")[0].slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|React DevTools|\[vite\]|\[HMR\]/.test(m.text())) log.errors.push(`console: ${m.text().slice(0, 200)}`); });
  page.on("response", (r) => {
    const req = r.request(); const u = new URL(r.url()); if (!LOCAL.has(u.hostname) || u.pathname === "/favicon.ico") return;
    if (isApi(req)) log.api.push({ method: req.method(), path: u.pathname, status: r.status() });
    const asset = ["document", "script", "stylesheet", "image", "font"].includes(req.resourceType());
    if ((asset && r.status() >= 400) || r.status() >= 500) log.http.push(`${req.method()} ${u.pathname} → ${r.status()}`);
  });
  return log;
}

export async function settle(page, extra = 600) {
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(extra);
}

// 页面可见文字，按行切开、去掉空行。用来比较不同条件下页面长得是否一样。
export async function lines(page) {
  return page.evaluate(() => document.body.innerText.split("\n").map((s) => s.trim()).filter(Boolean)).catch(() => []);
}
export const sameLines = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export const minus = (a, b) => { const s = new Set(b); return a.filter((x) => !s.has(x)); };

// 在页面里记录 DOM 变化次数，用来判断操作后有没有任何视觉反馈
export async function startMutationLog(page) {
  await page.evaluate(() => {
    window.__uxpMut = []; window.__uxpObs?.disconnect();
    window.__uxpObs = new MutationObserver((list) => { for (const m of list) window.__uxpMut.push(performance.now()); });
    window.__uxpObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }).catch(() => {});
}
export async function mutationsSince(page, t0 = 0) {
  return page.evaluate((t0) => (window.__uxpMut ?? []).filter((t) => t >= t0).length, t0).catch(() => -1);
}
export const now = (page) => page.evaluate(() => performance.now()).catch(() => 0);
