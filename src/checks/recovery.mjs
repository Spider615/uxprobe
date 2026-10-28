import { addFinding, controls, fillValid, editValid, openProbe, quiet, DEFAULT_SKIP, VISIBLE_CLICKABLE } from "../actions.mjs";
import { isWrite, lines, minus } from "../browser.mjs";

const ERROR = /失败|错误|异常|重试|登录|权限|限流|稍后|(?:未|没有|尚未)(?:成功)?(?:保存|提交|创建)|(?:保存|提交|创建)(?:未|没有|尚未)成功|not\s+(?:saved|submitted|created|successful)|unsuccessful|error|fail|retry|sign.?in|log.?in|unauthor|forbidden|invalid|rate.?limit|offline|timed.?out|timeout|try.again/i;
const SUCCESS = /保存成功|已保存|提交成功|已提交|创建成功|已创建|successfully|\bsaved\b|\bsubmitted\b|\bcreated\b|\bsuccess\b/i;
const fieldValues = (page, scope = "body") => page.locator(scope).locator("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]),textarea,select").evaluateAll((fields) => fields.filter((f) => f.getBoundingClientRect().width > 0 && !f.disabled).map((f, i) => ({ key: f.id || `${f.name}:${f.type}:${i}`, value: f.value, checked: ["checkbox", "radio"].includes(f.type) ? f.checked : undefined, type: f.type })));

export async function recoveryChecks(ctx, url, { targets, modes = [500, 401, 403, 422, 429, "offline", "timeout"], limits = {}, vp = "desktop", skip = DEFAULT_SKIP, markDirty = () => {}, reset = async () => {}, onSkip = () => {}, shoot, replay = [], onlySelectors } = {}) {
  const out = [];
  if (!targets) {
    targets = []; const first = await openProbe(ctx, url, { vp, markDirty, replay, skip }); let candidates;
    try { candidates = await controls(first.page); } finally { await first.close(); await reset(); }
    if (onlySelectors) candidates = candidates.filter((c) => onlySelectors.includes(c.selector));
    for (const c of candidates.slice(0, limits.controls ?? 25)) {
      if (skip.test(c.skipText)) continue;
      const probe = await openProbe(ctx, url, { vp, markDirty, replay, skip }); let wrote = false;
      try {
        probe.page.on("request", (req) => { if (isWrite(req)) wrote = true; });
        const el = probe.page.locator(c.selector);
        if (c.form) { const form = await el.evaluate((e) => { e.closest("form").dataset.uxRecovery = "1"; return "[data-ux-recovery]"; }); await fillValid(probe.page, form); }
        await el.click({ timeout: 2000 }); await quiet(probe.page);
        if (wrote) targets.push(c);
      } finally { await probe.close(); await reset(); }
      if (targets.length >= (limits.recoveryControls ?? 2)) break;
    }
  }
  if (!targets.length) onSkip({ reason: "没有实际触发可写控件，未执行提交故障注入；需要时请配置工作流" });
  if (targets.length > (limits.recoveryControls ?? 2)) onSkip({ reason: `失败恢复最多抽查 ${limits.recoveryControls ?? 2} 个写入控件` });
  for (const target of targets.slice(0, limits.recoveryControls ?? 2)) for (const mode of modes) {
    const probe = await openProbe(ctx, url, { vp, markDirty, replay, skip }); const { page } = probe;
    let injected = 0; let fail = true; let successfulRetry = false;
    const route = async (r) => {
      if (!fail || !isWrite(r.request())) return r.fallback();
      injected++;
      if (typeof mode === "string") return r.abort(mode === "timeout" ? "timedout" : "internetdisconnected");
      return r.fulfill({ status: mode, contentType: "application/json", body: JSON.stringify({ error: `uxprobe ${mode}` }) });
    };
    try {
      const el = target.selector ? page.locator(target.selector) : page.locator(VISIBLE_CLICKABLE).nth(target.index);
      if (!await el.count()) { onSkip({ reason: `写入控件「${target.label}」没有重现` }); continue; }
      const label = await el.evaluate((e) => [e.innerText, e.getAttribute("aria-label"), e.getAttribute("title")].join(" "));
      if (skip.test(label)) { onSkip({ reason: `skipClick：${target.label}` }); continue; }
      const formSelector = await el.evaluate((e) => { const f = e.closest("form"); if (!f) return null; f.dataset.uxRecovery = "1"; return "[data-ux-recovery]"; });
      if (formSelector) await fillValid(page, formSelector);
      if (formSelector && !await editValid(page, formSelector)) onSkip({ reason: `「${target.label}」无法构造有效的非默认编辑，未验证草稿重置丢失` });
      const beforeFields = await fieldValues(page, formSelector ?? "body"); const before = await lines(page);
      await page.route("**/*", route);
      await el.click({ timeout: 2000 }); await quiet(page, 120);
      if (!injected) { onSkip({ reason: `「${target.label}」在 ${mode} 试验中没有发出写请求` }); continue; }
      const after = await lines(page); const fresh = minus(after, before).join("\n");
      const report = (rule, msg, warning = false) => addFinding(out, { rule, cat: "反馈", msg: `「${target.label}」请求 ${mode} 时${msg}`, ...(warning ? { severity: "warning", confidence: "heuristic" } : {}) }, page, shoot);
      if (SUCCESS.test(fresh) && !ERROR.test(fresh)) await report("write-false-success", "接口没有成功，但页面提示了成功");
      else if (!ERROR.test(fresh) && !await page.locator('[aria-invalid=true],[role=alert]:visible').count()) await report("write-error-silent", "没有可识别的失败或恢复提示，请核对自定义文案", true);
      const afterFields = await fieldValues(page, formSelector ?? "body");
      if (beforeFields.some((f) => (f.value || f.checked) && afterFields.some((a) => a.key === f.key && (a.value !== f.value || a.checked !== f.checked)))) await report("write-input-lost", "提交失败后清空或重置了用户输入 / 选择状态");
      else if (beforeFields.some((f) => (f.value || f.checked) && !afterFields.some((a) => a.key === f.key))) await report("write-input-lost", "提交失败后输入字段消失，请核对是否仍能恢复草稿", true);
      const exists = await el.count(); const visible = exists && await el.isVisible();
      if (visible && await el.isDisabled()) await report("write-stuck-control", "提交失败后按钮仍禁用，无法重新提交");
      else if (visible) {
        fail = false;
        page.on("response", (response) => { if (isWrite(response.request()) && response.status() >= 200 && response.status() < 300) successfulRetry = true; });
        await el.click({ timeout: 2000 }); await quiet(page);
        if (!successfulRetry) await report("write-retry-failed", "解除故障后重试没有完成成功的写请求，请核对恢复入口", true);
      } else onSkip({ reason: `「${target.label}」在 ${mode} 后离开原状态，自动重试未验证；可配置工作流` });
    } finally { await probe.close(); await reset(); }
  }
  return out;
}
