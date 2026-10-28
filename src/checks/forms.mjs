import { addFinding, controls, fillValid, openProbe, quiet, DEFAULT_SKIP } from "../actions.mjs";
import { isWrite } from "../browser.mjs";

export async function formChecks(ctx, url, { limits = {}, skip = DEFAULT_SKIP, vp = "desktop", markDirty = () => {}, reset = async () => {}, onSkip = () => {}, shoot, replay = [], onlySelectors } = {}) {
  const out = []; const first = await openProbe(ctx, url, { vp, markDirty, replay, skip });
  let forms;
  try {
    forms = await controls(first.page, "form");
    if (onlySelectors) { const selected = []; for (const form of forms) if (await first.page.locator(form.selector).evaluate((el, selectors) => selectors.some((s) => el.contains(document.querySelector(s))), onlySelectors)) selected.push(form); forms = selected; }
  } finally { await first.close(); await reset(); }
  if (forms.length > (limits.forms ?? 4)) onSkip({ reason: `表单数超过 ${limits.forms ?? 4} 个上限` });
  for (const form of forms.slice(0, limits.forms ?? 4)) {
    const setup = await openProbe(ctx, url, { vp, markDirty, replay, skip }); let cases;
    try {
      cases = await setup.page.locator(form.selector).evaluate((form) => {
        const cases = [];
        [...form.querySelectorAll("input,textarea,select")].forEach((f, index) => {
          if (f.disabled || f.readOnly || f.type === "hidden" || !f.getBoundingClientRect().width) return;
          if (f.required && !["file", "radio", "checkbox"].includes(f.type)) cases.push({ index, value: "", kind: "required" });
          if (f.required && ["checkbox", "radio", "file"].includes(f.type)) cases.push({ index, value: "", kind: "required", type: f.type });
          if (["email", "url"].includes(f.type)) cases.push({ index, value: "invalid value", kind: f.type });
          if (f.min !== "" && f.min !== undefined && f.type === "number") cases.push({ index, value: String(Number(f.min) - 1), kind: "min" });
          if (f.max !== "" && f.max !== undefined && f.type === "number") cases.push({ index, value: String(Number(f.max) + 1), kind: "max" });
          if (f.minLength > 1) cases.push({ index, value: "x", kind: "minlength" });
          if (f.maxLength > 0 && f.maxLength < 10000) cases.push({ index, value: "x".repeat(f.maxLength + 1), kind: "maxlength" });
          if (f.pattern) cases.push({ index, value: "uxprobe invalid !", kind: "pattern" });
        });
        return cases;
      });
    } finally { await setup.close(); await reset(); }
    if (cases.length > (limits.inputs ?? 6)) onSkip({ reason: `表单负向用例超过 ${limits.inputs ?? 6} 个上限` });
    for (const candidate of cases.slice(0, limits.inputs ?? 6)) {
      const probe = await openProbe(ctx, url, { vp, markDirty, replay, skip }); const { page } = probe;
      try {
        const loc = page.locator(form.selector); await fillValid(page, form.selector);
        const field = loc.locator("input,textarea,select").nth(candidate.index);
        if (["checkbox", "radio"].includes(candidate.type)) await field.evaluate((el) => { const form = el.form; const fields = el.type === "radio" ? [...form.elements].filter((f) => f.type === "radio" && f.name === el.name) : [el]; for (const f of fields) { f.checked = false; f.dispatchEvent(new Event("change", { bubbles: true })); } });
        else if (candidate.type === "file") await field.setInputFiles([]);
        else if (await field.evaluate((el) => el.tagName === "SELECT")) await field.selectOption(candidate.value);
        else await field.fill(candidate.value);
        if (await field.evaluate((el) => el.checkValidity())) { onSkip({ reason: `${candidate.kind} 无效输入被浏览器规范化，未构造越界提交` }); continue; }
        const submit = loc.locator('button:not([type]),button[type=submit],input[type=submit]').first();
        if (!await submit.count()) { onSkip({ reason: `表单 ${form.selector} 没有提交控件` }); continue; }
        const label = await submit.evaluate((el) => [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("value")].join(" "));
        if (skip.test(label)) { onSkip({ reason: `skipClick：表单提交控件被跳过` }); continue; }
        let writes = 0; page.on("request", (req) => { if (isWrite(req)) writes++; });
        await page.evaluate(() => { window.__uxInvalid = 0; document.addEventListener("invalid", () => window.__uxInvalid++, true); });
        const before = await page.locator("body").innerText();
        await submit.click({ timeout: 2000 }); await quiet(page);
        if (writes) await addFinding(out, { rule: "invalid-accepted", cat: "反馈", msg: `表单违反 ${candidate.kind} 约束时仍然发出了写请求` }, page, shoot);
        else {
          const info = await field.evaluate((el) => {
            const refs = [el.getAttribute("aria-describedby"), el.getAttribute("aria-errormessage")].filter(Boolean).join(" ").split(/\s+/);
            return { native: window.__uxInvalid > 0 && !!el.validationMessage, linked: refs.some((id) => document.getElementById(id)?.innerText.trim()) || !!el.getAttribute("aria-errormessage"), invalid: el.getAttribute("aria-invalid") === "true" };
          });
          const after = await page.locator("body").innerText();
          if (!info.native && before === after && !info.invalid) await addFinding(out, { rule: "invalid-no-feedback", cat: "反馈", msg: `表单违反 ${candidate.kind} 约束后提交没有任何校验提示` }, page, shoot);
          else if (!info.native && !info.linked && before !== after) await addFinding(out, { rule: "form-error-unlinked", cat: "理解", severity: "warning", confidence: "heuristic", msg: "表单出现校验信息，但没有通过 aria-describedby / aria-errormessage 关联到出错字段" }, page, shoot);
        }
      } finally { await probe.close(); await reset(); }
    }
  }
  return out;
}
