import { openProbe, quiet, DEFAULT_SKIP, addFinding, completedDownload } from "./actions.mjs";
import { isApi } from "./browser.mjs";
import { routePath } from "./discover.mjs";
import { installPerformance, performanceChecks } from "./checks/performance.mjs";

const ACTIONS = new Set(["goto", "click", "fill", "press", "select", "check", "upload", "scroll", "back", "forward", "reload", "wait", "expect", "fault", "clearFaults"]);
const EXPECT = new Set(["visible", "hidden", "text", "value", "url", "count", "checked", "enabled", "disabled", "download"]);
const pathOnly = (p) => typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\");
export function validateScenarios(scenarios) {
  for (const s of scenarios) {
    if (!s || typeof s.name !== "string" || !Array.isArray(s.steps) || !s.steps.length || s.steps.length > 100) throw new Error("scenario 必须有 name 和 1–100 个 steps");
    if (s.start !== undefined && !pathOnly(s.start)) throw new Error("scenario.start 必须是本机应用内的 / 路径");
    if (s.viewports && (!Array.isArray(s.viewports) || !s.viewports.length || s.viewports.some((v) => !["desktop", "mobile", "compact", "landscape"].includes(v)))) throw new Error("无效的 scenario.viewports");
    for (const step of s.steps) {
      if (!step || !ACTIONS.has(step.action)) throw new Error(`未知 scenario action 动作：${step?.action}`);
      if (["click", "fill", "select", "check", "upload"].includes(step.action) && typeof step.selector !== "string") throw new Error(`${step.action} 需要 selector`);
      if (step.action === "goto" && !pathOnly(step.url)) throw new Error("goto.url 必须是应用内路径");
      if (step.action === "press" && (typeof step.key !== "string" || !step.key)) throw new Error("press.key 必须是按键名称");
      if (step.action === "select" && !(typeof step.value === "string" || (Array.isArray(step.value) && step.value.every((v) => typeof v === "string")))) throw new Error("select.value 必须是选项值或值数组");
      if (step.action === "check" && step.value !== undefined && typeof step.value !== "boolean") throw new Error("check.value 必须是 boolean");
      if (step.action === "wait" && step.state !== undefined && !["attached", "detached", "visible", "hidden"].includes(step.state)) throw new Error("无效的 wait.state");
      if (step.action === "expect" && (!EXPECT.has(step.kind) || (!["url", "download"].includes(step.kind) && typeof step.selector !== "string"))) throw new Error("expect 需要支持的 kind 和 selector");
      if (step.action === "expect" && step.kind === "count" && (!Number.isInteger(step.value) || step.value < 0)) throw new Error("expect count.value 必须是非负整数");
      if (step.action === "expect" && ["text", "value", "url"].includes(step.kind) && typeof step.value !== "string") throw new Error("expect.value 必须是字符串");
      if (step.action === "expect" && step.kind === "download" && step.minBytes !== undefined && (!Number.isInteger(step.minBytes) || step.minBytes < 0)) throw new Error("download.minBytes 必须是非负整数");
      if (step.action === "upload" && (!step.file || typeof step.file.name !== "string" || (step.file.size !== undefined && (!Number.isInteger(step.file.size) || step.file.size < 0 || step.file.size > 10 * 1024 * 1024)))) throw new Error("upload.file 的大小 size 必须在 0–10 MiB 之间");
      if (step.action === "fault" && (!pathOnly(step.match) || (step.status !== undefined && (!Number.isInteger(step.status) || step.status < 400 || step.status > 599)) || (step.mode && !["offline", "timeout"].includes(step.mode)))) throw new Error("fault 需要应用内 match 和错误 status 或 mode");
      if (step.timeout !== undefined && (!Number.isInteger(step.timeout) || step.timeout < 1 || step.timeout > 15000)) throw new Error("step.timeout 必须为 1–15000ms");
      if (step.ms !== undefined && (!Number.isInteger(step.ms) || step.ms < 0 || step.ms > 5000)) throw new Error("step.ms 必须为 0–5000ms");
    }
  }
  return scenarios;
}

async function assertion(page, step, downloads) {
  const timeout = step.timeout ?? 2000;
  const loc = step.selector ? page.locator(step.selector) : null;
  if (["visible", "hidden"].includes(step.kind)) return loc.first().waitFor({ state: step.kind, timeout });
  const deadline = Date.now() + timeout;
  do {
    let ok = false;
    if (step.kind === "url") ok = routePath(page.url()) === step.value;
    else if (step.kind === "count") ok = await loc.count() === step.value;
    else if (step.kind === "text") { const text = await loc.first().textContent({ timeout }).catch(() => null); ok = text !== null && (step.exact ? text === step.value : text.includes(String(step.value))); }
    else if (step.kind === "value") ok = await loc.first().inputValue({ timeout }).catch(() => null) === String(step.value);
    else if (step.kind === "checked") { const checked = await loc.first().isChecked({ timeout }).catch(() => null); ok = checked !== null && checked === (step.value ?? true); }
    else if (step.kind === "enabled") ok = await loc.first().isEnabled({ timeout }).catch(() => false);
    else if (step.kind === "disabled") ok = await loc.first().isDisabled({ timeout }).catch(() => false);
    else if (step.kind === "download" && downloads.length) {
      const download = downloads.at(-1);
      const result = await completedDownload(download, Math.max(1, deadline - Date.now()));
      if (result.failure) throw new Error(`下载失败：${result.failure}`);
      ok = (!step.filename || result.filename === step.filename) && result.bytes >= (step.minBytes ?? 1);
    }
    if (ok) return;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`断言未满足：${step.kind} ${step.selector ?? step.value ?? step.filename ?? ""}`);
}

export async function runScenarios(ctx, base, scenarios, { vp = "desktop", readOnly = false, skip = DEFAULT_SKIP, onSkip = () => {}, markDirty = () => {}, reset = async () => {}, shoot, performance } = {}) {
  validateScenarios(scenarios); const out = [];
  for (const scenario of scenarios) {
    if (scenario.viewports && !scenario.viewports.includes(vp)) { onSkip({ scenario: scenario.name, reason: `工作流未配置 ${vp} 视口` }); continue; }
    if (readOnly) { onSkip({ scenario: scenario.name, reason: "readOnly：未执行工作流" }); continue; }
    const probe = await openProbe(ctx, new URL(scenario.start ?? "/", base).href, { vp, markDirty, ...(performance ? { prepare: installPerformance } : {}) });
    const { page } = probe; const downloads = []; let faults = []; let stepNo = 0;
    page.on("download", (d) => downloads.push(d));
    await page.route("**/*", async (route) => {
      const req = route.request(); const fault = faults.find((f) => isApi(req) && new URL(req.url()).pathname.startsWith(f.match) && (!f.method || req.method() === f.method));
      if (!fault) return route.fallback();
      if (fault.once) faults = faults.filter((f) => f !== fault);
      if (fault.mode) return route.abort(fault.mode === "timeout" ? "timedout" : "internetdisconnected");
      return route.fulfill({ status: fault.status ?? 500, contentType: "application/json", body: JSON.stringify(fault.body ?? { error: "uxprobe injected failure" }) });
    });
    try {
      for (const step of scenario.steps) {
        stepNo++; const timeout = step.timeout ?? 2000; const loc = step.selector ? page.locator(step.selector).first() : null;
        if (["click", "check", "select"].includes(step.action) || (step.action === "press" && /(?:^|\+)(Enter|Space| )$/.test(step.key))) {
          const text = (el) => [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("value")].filter(Boolean).join(" ");
          const label = loc ? await loc.evaluate(text, undefined, { timeout }) : await page.evaluate(() => { const el = document.activeElement; return [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("value")].filter(Boolean).join(" "); });
          if (skip.test(label)) { onSkip({ scenario: scenario.name, reason: `skipClick：第 ${stepNo} 步被跳过` }); break; }
        }
        if (step.action === "expect") await assertion(page, step, downloads);
        else if (step.action === "goto") await page.goto(new URL(step.url, base).href, { timeout: 15000 });
        else if (step.action === "click") await loc.click({ timeout });
        else if (step.action === "fill") await loc.fill(String(step.value ?? ""), { timeout });
        else if (step.action === "press") { if (loc) await loc.press(step.key, { timeout }); else await page.keyboard.press(step.key); }
        else if (step.action === "select") await loc.selectOption(step.value, { timeout });
        else if (step.action === "check") await loc.setChecked(step.value ?? true, { timeout });
        else if (step.action === "upload") await loc.setInputFiles({ name: step.file.name, mimeType: step.file.mimeType ?? "text/plain", buffer: step.file.size !== undefined ? Buffer.alloc(step.file.size, 120) : Buffer.from(step.file.text ?? "uxprobe fixture") }, { timeout });
        else if (step.action === "scroll") { if (loc) await loc.evaluate((el, s) => el.scrollBy(s.x ?? 0, s.y ?? 500), step); else await page.evaluate((s) => scrollBy(s.x ?? 0, s.y ?? 500), step); }
        else if (step.action === "back") await page.goBack({ timeout: 15000 });
        else if (step.action === "forward") await page.goForward({ timeout: 15000 });
        else if (step.action === "reload") await page.reload({ timeout: 15000 });
        else if (step.action === "wait") { if (loc) await loc.waitFor({ state: step.state ?? "visible", timeout }); else await page.waitForTimeout(step.ms ?? 100); }
        else if (step.action === "fault") faults.push({ ...step });
        else if (step.action === "clearFaults") faults = [];
        if (!["expect", "fault", "clearFaults", "wait"].includes(step.action)) await quiet(page, 30);
      }
      if (performance) out.push(...await performanceChecks(page, { thresholds: performance, onSkip }));
    } catch (e) {
      if (e.code === "ISOLATION") throw e;
      await addFinding(out, { rule: "scenario-failed", cat: "流程", confidence: "confirmed", msg: `工作流「${scenario.name}」第 ${stepNo} 步失败：${e.message.split("\n")[0]}` }, page, shoot);
    } finally { await probe.close(); await reset(); }
  }
  return out;
}
