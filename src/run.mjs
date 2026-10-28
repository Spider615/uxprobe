// 一次完整运行：建沙箱 → 启动应用 → 登录 → 发现页面 → 逐页检查 → 去重 → 出报告 → 核对原数据。
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launch, newContext, settle, watch, VIEWPORTS } from "./browser.mjs";
import { Sandbox } from "./sandbox.mjs";
import { discover, template } from "./discover.mjs";
import { staticChecks } from "./checks/static.mjs";
import { conditionChecks } from "./checks/conditions.mjs";
import { interactionChecks } from "./checks/interactions.mjs";
import { fill } from "./config.mjs";
import { writeHtml } from "./report.mjs";

const slug = (s) => s.replace(/^\//, "").replace(/[^\w一-龥]+/g, "_").slice(0, 50) || "root";

async function login(browser, sandbox, config, outDir) {
  if (!config.login) return undefined;
  const ctx = await newContext(browser, "desktop"); const page = await ctx.newPage();
  await page.goto(sandbox.url + config.login.path); await settle(page);
  for (const [sel, v] of Object.entries(config.login.fill ?? {})) await page.locator(sel).first().fill(fill(v, sandbox.vars));
  const submit = config.login.submit ?? "Enter";
  if (submit === "Enter") await page.keyboard.press("Enter"); else await page.locator(submit).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith(config.login.path), { timeout: 15000 }).catch(() => {});
  await settle(page);
  if (new URL(page.url()).pathname.startsWith(config.login.path)) throw new Error(`登录失败，停在了 ${page.url()}，检查配置里的 login`);
  const file = join(outDir, "auth.json"); await ctx.storageState({ path: file }); await ctx.close();
  return file;
}

export async function run(config, { only, log = console.log, headless = true } = {}) {
  const outDir = join(config.home, "report");
  rmSync(outDir, { recursive: true, force: true }); mkdirSync(join(outDir, "shots"), { recursive: true });
  const sandbox = new Sandbox(config, log);
  const started = Date.now(); const findings = []; let browser;
  try {
    log("准备沙箱：复制数据、分配端口…"); await sandbox.prepare();
    log("启动应用：" + sandbox.describe()); await sandbox.start();
    browser = await launch(headless);
    const auth = await login(browser, sandbox, config, outDir);
    const ctxs = {}; for (const vp of Object.keys(VIEWPORTS)) ctxs[vp] = await newContext(browser, vp, auth);
    let pages = await discover(ctxs.desktop, sandbox.url, config.pages, config.maxPages);
    if (only) pages = pages.filter((p) => only.some((o) => p === o || template(p) === template(o)));
    log(`发现 ${pages.length} 个页面`);
    let shotNo = 0;
    const shoot = async (page, rule) => {
      const file = `shots/${String(++shotNo).padStart(3, "0")}-${slug(rule)}.png`;
      await page.addStyleTag({ content: "[data-uxp]{outline:3px solid #e5484d!important;outline-offset:2px}" }).catch(() => {});
      await page.screenshot({ path: join(outDir, file) }).catch(() => {});
      return file;
    };
    for (const [i, path] of pages.entries()) {
      await sandbox.alive();
      const url = sandbox.url + path; const t0 = Date.now(); const here = [];
      for (const vp of Object.keys(VIEWPORTS)) {
        const page = await ctxs[vp].newPage(); const l = watch(page);
        const res = await page.goto(url).catch((e) => e);
        if (res instanceof Error) throw new Error(`打不开 ${path}：${res.message.split("\n")[0]}`);
        await settle(page);
        for (const e of l.errors) here.push({ rule: e.startsWith("console:") ? "console-error" : "uncaught", cat: "反馈", msg: `打开页面时报错：${e}`, vp });
        for (const h of l.http) here.push({ rule: "http-error", cat: "反馈", msg: `打开页面时请求失败：${h}`, vp });
        const list = await staticChecks(page, vp);
        const shot = list.length ? await shoot(page, `${slug(path)}-${vp}`) : undefined;
        for (const f of list) here.push({ ...f, vp, shot });
        await page.close();
      }
      for (const f of await conditionChecks(ctxs.desktop, ctxs.mobile, url, shoot)) here.push({ ...f, vp: f.rule === "long-text-overflow" ? "mobile" : "desktop" });
      await sandbox.reset();
      for (const f of await interactionChecks(ctxs.desktop, url, { skip: config.skipClick, shoot, markDirty: () => (sandbox.dirty = true), reset: () => sandbox.reset() })) here.push({ ...f, vp: "desktop" });
      await sandbox.reset();
      for (const f of here) findings.push({ ...f, page: path, template: template(path) });
      log(`[${i + 1}/${pages.length}] ${path}  ${here.length} 条  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    for (const c of Object.values(ctxs)) await c.close();
  } finally {
    await browser?.close().catch(() => {});
    await sandbox.dispose();
  }
  const report = { app: sandbox.url, seconds: Math.round((Date.now() - started) / 1000), isolation: "原数据在运行前后一致", issues: group(findings) };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeHtml(report, join(outDir, "index.html"));
  return { report, outDir };
}

// 去重：同一个问题在多个页面出现（共用的侧栏、导航），合并成一条，列出出现在哪些页面
function group(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = `${f.rule}\u0000${f.msg}`;
    const g = map.get(key) ?? { rule: f.rule, cat: f.cat, msg: f.msg, pages: [], viewports: [], shot: f.shot };
    if (!g.pages.includes(f.page)) g.pages.push(f.page);
    if (!g.viewports.includes(f.vp)) g.viewports.push(f.vp);
    map.set(key, g);
  }
  const order = { 反馈: 0, 状态: 1, 流程: 2, 操作: 3, 呈现: 4, 理解: 5, 工具: 6 };
  return [...map.values()].sort((a, b) => order[a.cat] - order[b.cat] || b.pages.length - a.pages.length);
}
