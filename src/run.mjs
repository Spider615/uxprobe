// 一次完整运行：建沙箱 → 启动应用 → 登录 → 发现页面 → 逐页检查 → 去重 → 出报告 → 核对原数据。
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { launch, newContext, settle, watch, isWrite } from "./browser.mjs";
import { Sandbox } from "./sandbox.mjs";
import { discover, template, routePath } from "./discover.mjs";
import { staticChecks } from "./checks/static.mjs";
import { conditionChecks } from "./checks/conditions.mjs";
import { interactionChecks } from "./checks/interactions.mjs";
import { fill } from "./config.mjs";
import { writeHtml } from "./report.mjs";
import { createCoverage } from "./coverage.mjs";
import { keyboardChecks } from "./checks/keyboard.mjs";
import { mobileChecks } from "./checks/mobile.mjs";
import { formChecks } from "./checks/forms.mjs";
import { recoveryChecks } from "./checks/recovery.mjs";
import { navigationChecks } from "./checks/navigation.mjs";
import { componentChecks } from "./checks/components.mjs";
import { installPerformance, performanceChecks } from "./checks/performance.mjs";
import { exploreStates } from "./explore.mjs";
import { runScenarios } from "./scenarios.mjs";

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
  const started = Date.now(); const findings = []; const coverage = createCoverage();
  const profiles = config.viewports ?? ["desktop", "mobile"]; const checks = config.checks ?? {}; const limits = config.limits ?? {};
  const actionChecks = new Set(["keyboard", "mobile", "interactions", "forms", "recovery", "navigation", "components", "explore", "scenarios"]);
  let browser; let failed; let pages = []; let browserVersion;
  const enabled = (name) => checks[name] !== false;
  const runCheck = async (name, details, fn) => {
    if (!enabled(name) || (config.readOnly && actionChecks.has(name))) { coverage.skip(name, { ...details, reason: config.readOnly && actionChecks.has(name) ? "readOnly：未执行操作检查" : "配置禁用" }); return []; }
    return coverage.run(name, details, fn);
  };
  const skipFor = (name, details) => (entry) => coverage.skip(name, { ...details, ...entry });
  try {
    log("准备沙箱：复制数据、分配端口…"); await sandbox.prepare();
    log("启动应用：" + sandbox.describe()); await sandbox.start();
    await new Promise((r) => setTimeout(r, 3000)); sandbox.checkLeaks("启动时");
    browser = await launch(headless);
    browserVersion = browser.version();
    const auth = await login(browser, sandbox, config, outDir);
    const ctxs = {};
    for (const vp of new Set([...profiles, ...(enabled("conditions") ? ["desktop", "mobile"] : [])])) {
      ctxs[vp] = await newContext(browser, vp, auth, { readOnly: config.readOnly });
      ctxs[vp].on("request", (req) => { if (isWrite(req)) sandbox.dirty = true; });
    }
    pages = await discover(ctxs.desktop ?? ctxs[profiles[0]], sandbox.url, config.pages, config.maxPages, { onSkip: skipFor("discovery", {}), onPage: ({ path, status, from }) => { if (from && status >= 400) findings.push({ rule: "broken-navigation", cat: "流程", msg: `${from} 的链接指向 ${path}，返回 HTTP ${status}`, page: path, template: template(path), vp: profiles[0] }); } });
    coverage.records.push({ check: "discovery", status: "checked", reason: `发现 ${pages.length} 个路由状态` });
    if (only) pages = pages.filter((p) => only.some((o) => p === o || template(p) === template(o)));
    log(`发现 ${pages.length} 个页面`);
    let shotNo = 0;
    const shoot = async (page, rule) => {
      const file = `shots/${String(++shotNo).padStart(3, "0")}-${slug(rule)}.png`;
      const style = await page.addStyleTag({ content: "[data-uxp]{outline:3px solid #e5484d!important;outline-offset:2px}" });
      try { await page.screenshot({ path: join(outDir, file) }); }
      finally { await style.evaluate((el) => el.remove()).catch(() => {}); }
      return file;
    };
    for (const [i, path] of pages.entries()) {
      await sandbox.alive(); sandbox.checkLeaks("运行中");
      const url = new URL(path, sandbox.url).href; const t0 = Date.now(); const here = [];
      const markDirty = () => (sandbox.dirty = true); const reset = () => sandbox.reset();
      for (const vp of profiles) {
        const details = { page: path, vp }; const collect = (list) => { for (const f of list) here.push({ ...f, vp }); };
        const options = (name) => ({ vp, skip: config.skipClick, limits, markDirty, reset, shoot, readOnly: config.readOnly, onSkip: skipFor(name, details) });
        const page = await ctxs[vp].newPage(); const l = watch(page);
        if (enabled("performance")) await installPerformance(page);
        try {
        const res = await page.goto(url).catch((e) => e);
        if (res instanceof Error) throw new Error(`打不开 ${path}：${res.message.split("\n")[0]}`);
        await settle(page);
        for (const e of l.errors) here.push({ rule: e.startsWith("console:") ? "console-error" : "uncaught", cat: "反馈", msg: `打开页面时报错：${e}`, vp });
        for (const h of l.http) here.push({ rule: "http-error", cat: "反馈", msg: `打开页面时请求失败：${h}`, vp });
        collect(await runCheck("performance", details, () => performanceChecks(page, { thresholds: config.performance, onSkip: skipFor("performance", details) })));
        const list = await runCheck("static", details, () => staticChecks(page, vp));
        const shot = list.length ? await shoot(page, `${slug(path)}-${vp}`) : undefined;
        for (const f of list) here.push({ ...f, vp, shot });
        if (vp !== "desktop") collect(await runCheck("mobile", details, () => mobileChecks(page, options("mobile"))));
        collect(await runCheck("keyboard", details, () => keyboardChecks(page, options("keyboard"))));
        } finally { await page.close(); await reset(); }
        const writes = [];
        collect(await runCheck("interactions", details, () => interactionChecks(ctxs[vp], url, { ...options("interactions"), onWrite: (c) => writes.push(c), performance: enabled("performance") ? config.performance ?? {} : undefined })));
        collect(await runCheck("forms", details, () => formChecks(ctxs[vp], url, options("forms"))));
        collect(await runCheck("recovery", details, () => recoveryChecks(ctxs[vp], url, { ...options("recovery"), ...(writes.length ? { targets: writes } : {}) })));
        collect(await runCheck("navigation", details, () => navigationChecks(ctxs[vp], url, { ...options("navigation"), navigation: config.navigation })));
        collect(await runCheck("components", details, () => componentChecks(ctxs[vp], url, options("components"))));
        collect(await runCheck("explore", details, () => exploreStates(ctxs[vp], url, { ...options("explore"), onState: async (statePage, state) => {
          const stateName = state.chain.map((c) => c.label).join(" → "); const stateDetails = { ...details, state: stateName };
          const found = [];
          // 从菜单 / 弹窗里发现的新入口加入同一受限队列，仍受 --page 约束。
          const hrefs = await statePage.locator("a[href]").evaluateAll((links) => links.map((a) => a.href));
          for (const href of [statePage.url(), ...hrefs]) {
            const u = new URL(href); const next = routePath(href);
            if (u.origin !== new URL(sandbox.url).origin || /\.(pdf|zip|csv|xlsx?|png|jpe?g|svg)$/i.test(u.pathname) || pages.some((p) => template(p) === template(next))) continue;
            if (only && !only.some((o) => template(o) === template(next))) continue;
            if (pages.length < config.maxPages) pages.push(next); else coverage.skip("discovery", { page: next, reason: "动态入口达到 maxPages 上限" });
          }
          found.push(...await runCheck("static", stateDetails, () => staticChecks(statePage, vp)));
          if (vp !== "desktop") found.push(...await runCheck("mobile", stateDetails, () => mobileChecks(statePage, options("mobile"))));
          found.push(...await runCheck("keyboard", stateDetails, () => keyboardChecks(statePage, { ...options("keyboard"), opener: state.opener })));
          return found;
        }, afterState: async (state) => {
          const stateDetails = { ...details, state: state.chain.map((c) => c.label).join(" → ") }; const found = [];
          // 选择器相同也可能切换校验或提交逻辑，因此检查当前状态的相关控件（仍受 limits 限制）。
          const newControls = state.controls.map((c) => c.selector); const newInputs = state.inputs.map((c) => c.selector);
          const stateOptions = (name) => ({ ...options(name), replay: state.chain, onSkip: skipFor(name, stateDetails) });
          if (newControls.length || newInputs.length) {
            const stateWrites = [];
            found.push(...await runCheck("interactions", stateDetails, () => interactionChecks(ctxs[vp], url, { ...stateOptions("interactions"), onlySelectors: newControls, onlyInputs: newInputs, onWrite: (c) => stateWrites.push(c), performance: enabled("performance") ? config.performance ?? {} : undefined })));
            found.push(...await runCheck("forms", stateDetails, () => formChecks(ctxs[vp], url, { ...stateOptions("forms"), onlySelectors: [...newControls, ...newInputs] })));
            found.push(...await runCheck("recovery", stateDetails, () => recoveryChecks(ctxs[vp], url, { ...stateOptions("recovery"), onlySelectors: newControls, ...(stateWrites.length ? { targets: stateWrites } : {}) })));
            found.push(...await runCheck("components", stateDetails, () => componentChecks(ctxs[vp], url, { ...stateOptions("components"), onlySelectors: newControls })));
          }
          if (state.newLinks.length) found.push(...await runCheck("navigation", stateDetails, () => navigationChecks(ctxs[vp], url, { ...stateOptions("navigation"), onlySelectors: state.newLinks.map((c) => c.selector), navigation: config.navigation })));
          if (vp === profiles[0] && state.newRequests.some((r) => r.read)) {
            if (state.newRequests.some((r) => !r.read)) coverage.skip("conditions", { ...stateDetails, reason: "展开路径包含写入，请配置工作流以定义该路径的读取故障预期" });
            else found.push(...await runCheck("conditions", stateDetails, () => conditionChecks(ctxs.desktop, ctxs.mobile, url, shoot, { ...stateOptions("conditions"), faultModes: config.readFaults })));
          }
          return found;
        } })));
      }
      for (const f of await runCheck("conditions", { page: path, vp: "desktop" }, () => conditionChecks(ctxs.desktop, ctxs.mobile, url, shoot, { limits, faultModes: config.readFaults, markDirty, reset, readOnly: config.readOnly, onSkip: skipFor("conditions", { page: path }) }))) here.push({ ...f, vp: f.rule === "long-text-overflow" ? "mobile" : "desktop" });
      await sandbox.reset();
      for (const f of here) findings.push({ ...f, page: path, template: template(path) });
      log(`[${i + 1}/${pages.length}] ${path}  ${here.length} 条  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    for (const vp of profiles) {
      const details = { vp, page: "工作流" };
      if (!config.scenarios?.length) coverage.skip("scenarios", { ...details, reason: "未配置业务工作流；上传限制、分页结果、自动保存等需明确预期" });
      else for (const f of await runCheck("scenarios", details, () => runScenarios(ctxs[vp], sandbox.url, config.scenarios, { vp, skip: config.skipClick, readOnly: config.readOnly, markDirty: () => (sandbox.dirty = true), reset: () => sandbox.reset(), shoot, onSkip: skipFor("scenarios", details), performance: enabled("performance") ? config.performance ?? {} : undefined }))) findings.push({ ...f, vp, page: "工作流", template: "工作流" });
    }
    for (const c of Object.values(ctxs)) await c.close();
  } catch (e) { failed = e; throw e; } finally {
    await browser?.close().catch(() => {});
    await sandbox.dispose(failed);
  }
  const report = {
    project: basename(config.projectDir), finishedAt: new Date().toISOString(), app: sandbox.url, browser: browserVersion,
    seconds: Math.round((Date.now() - started) / 1000), isolation: "原数据在运行前后一致", scannedPages: pages,
    coverage: { summary: coverage.summary(), records: coverage.records }, issues: group(findings),
    limitations: ["紧凑宽度、横屏和缩短视口为浏览器模拟，未验证真实手机软键盘和设备性能。", "axe 和焦点检查不等同于读屏实测或完整 WCAG 合规认证；仅靠颜色、文案理解和流程合理性仍需人工判断。", "性能结果是本机实验室诊断，不能当作真实用户 INP 或线上 Web Vitals。", "通用规则只验证声明的表单约束；上传限制、无限滚动、草稿 / 筛选保留等业务预期请配置 scenarios / navigation。", "WebSocket 消息、原生 EventSource 和服务端渲染数据不能自动进行 JSON 条件变形；认证角色、取消等专属流程需配置工作流。"],
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeHtml(report, join(outDir, "index.html"));
  return { report, outDir };
}

// 去重：同一个问题在多个页面出现（共用的侧栏、导航），合并成一条，列出出现在哪些页面
// 逐元素的规则（小目标、截断、遮挡…）在同一页同一宽度下合并成一条，列出例子
const PER_ELEMENT = new Set(["small-target", "truncated", "occluded", "not-a-button", "hover-only"]);
function collapse(findings) {
  const out = []; const buckets = new Map();
  for (const f of findings) {
    if (!PER_ELEMENT.has(f.rule)) { out.push(f); continue; }
    const k = `${f.rule}\u0000${f.template}\u0000${f.vp}\u0000${f.state ?? ""}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)).push(f);
  }
  for (const list of buckets.values()) {
    if (list.length <= 2) { out.push(...list); continue; }
    const ex = list.slice(0, 2).map((f) => f.msg.match(/「([^」]{0,20})/)?.[1] ?? "").filter(Boolean);
    const what = { "small-target": "个元素点击区域太小", truncated: "处文字被截断且看不到全文", occluded: "个元素被盖住点不到", "not-a-button": "个元素看起来能点但不是按钮", "hover-only": "个操作只在悬停时出现" }[list[0].rule];
    out.push({ ...list[0], msg: `${list.length} ${what}（${list[0].vp === "mobile" ? "手机" : "桌面"}），如「${ex.join("」「")}」` });
  }
  return out;
}

function group(findings) {
  findings = collapse(findings);
  const map = new Map();
  for (const f of findings) {
    const key = `${f.rule}\u0000${f.msg}\u0000${f.severity ?? "error"}\u0000${f.confidence ?? "confirmed"}`;
    const g = map.get(key) ?? { rule: f.rule, cat: f.cat, msg: f.msg, pages: [], viewports: [], states: [], shot: f.shot, ...(f.severity ? { severity: f.severity } : {}), ...(f.confidence ? { confidence: f.confidence } : {}) };
    if (!g.pages.includes(f.page)) g.pages.push(f.page);
    if (!g.viewports.includes(f.vp)) g.viewports.push(f.vp);
    if (f.state && !g.states.includes(f.state)) g.states.push(f.state);
    if (!g.shot && f.shot) g.shot = f.shot;
    map.set(key, g);
  }
  const order = { 反馈: 0, 状态: 1, 流程: 2, 操作: 3, 呈现: 4, 理解: 5, 性能: 6, 工具: 7 };
  return [...map.values()].sort((a, b) => order[a.cat] - order[b.cat] || b.pages.length - a.pages.length);
}
