import { addFinding, controls, fillValid, openProbe, quiet, DEFAULT_SKIP } from "../actions.mjs";
import { routePath } from "../discover.mjs";

async function editDirtyField(page) {
  for (const candidate of await controls(page, "input,textarea,select")) {
    const field = page.locator(candidate.selector);
    const edit = await field.evaluate((f) => {
      if (f.matches(":disabled") || f.readOnly || /^(hidden|submit|button|reset|file|image)$/.test(f.type)) return null;
      const property = ["checkbox", "radio"].includes(f.type) ? "checked" : "value";
      const before = f[property]; let value;
      if (f.tagName === "SELECT") value = [...f.options].find((o) => o.value !== before && !o.disabled && !o.closest("optgroup[disabled]"))?.value;
      else if (property === "checked") { if (f.type === "radio" && before) return null; value = !before; }
      else if (["number", "range"].includes(f.type)) {
        const step = Number(f.step) > 0 ? Number(f.step) : 1;
        const current = Number.isFinite(f.valueAsNumber) ? f.valueAsNumber : Number(f.min || 0);
        value = [current + step, current - step].find((n) => (f.min === "" || n >= Number(f.min)) && (f.max === "" || n <= Number(f.max)) && String(n) !== before);
      } else {
        const samples = { date: ["2026-01-01", "2026-01-02"], time: ["12:00", "13:00"], "datetime-local": ["2026-01-01T12:00", "2026-01-02T12:00"], month: ["2026-01", "2026-02"], week: ["2026-W01", "2026-W02"], color: ["#112233", "#334455"] };
        if (samples[f.type]) value = samples[f.type].find((v) => v !== before);
        else {
          if (f.maxLength === 0) return null;
          value = before ? `${before}x` : f.type === "email" ? "uxprobe@example.com" : f.type === "url" ? "https://example.com" : "Uxprobe123test";
          if (f.maxLength > 0) value = value.slice(0, f.maxLength);
          if (value === before) value = (before[0] === "x" ? "y" : "x") + before.slice(1);
        }
      }
      if (value === undefined || value === before) return null;
      const prototype = f.tagName === "SELECT" ? HTMLSelectElement.prototype : f.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      f.focus(); Object.getOwnPropertyDescriptor(prototype, property).set.call(f, value);
      f.dispatchEvent(new Event("input", { bubbles: true, composed: true })); f.dispatchEvent(new Event("change", { bubbles: true })); f.blur();
      return { property, before };
    }).catch(() => null);
    if (!edit) continue;
    await quiet(page);
    if (await field.evaluate((f, edit) => f[edit.property] !== edit.before, edit).catch(() => false)) return true;
  }
  return false;
}

async function newVisibleDialog(page, remember = false) {
  return page.evaluate((remember) => {
    const visible = [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"]')].filter((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth || el.closest("[hidden],[inert],[aria-hidden=true]")) return false;
      for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.visibility === "hidden" || s.visibility === "collapse" || Number(s.opacity) <= 0.1) return false; }
      return true;
    });
    if (remember) { window.__uxpNavigationDialogs = new WeakSet(visible); return false; }
    return !!window.__uxpNavigationDialogs && visible.some((el) => !window.__uxpNavigationDialogs.has(el));
  }, remember);
}

export async function navigationChecks(ctx, url, { vp = "desktop", skip = DEFAULT_SKIP, limits = {}, navigation = {}, replay = [], onlySelectors, markDirty = () => {}, reset = async () => {}, onSkip = () => {}, shoot } = {}) {
  const out = []; const first = await openProbe(ctx, url, { vp, markDirty, replay, skip }); let links;
  try {
    const source = first.page.url();
    const candidates = await controls(first.page, "a[href]:not([download]):not([target=_blank])");
    links = [];
    for (const c of candidates) {
      const href = await first.page.locator(c.selector).getAttribute("href"); const target = new URL(href, source);
      if ((!onlySelectors || onlySelectors.includes(c.selector)) && target.origin === new URL(source).origin && routePath(target.href) !== routePath(source) && !/\.(pdf|zip|csv|xlsx?|png|jpe?g|svg)$/i.test(target.pathname)) links.push({ ...c, target: target.href });
    }
  } finally { await first.close(); await reset(); }
  const cap = limits.navigation ?? 4;
  if (links.length > cap) onSkip({ reason: `导航最多抽查 ${cap} 个入口，其他链接仍由页面发现检查` });
  for (const link of links.slice(0, cap)) {
    if (skip.test(link.skipText)) { onSkip({ reason: `skipClick：导航「${link.label}」` }); continue; }
    const probe = await openProbe(ctx, url, { vp, markDirty, replay, skip }); const { page } = probe;
    try {
      const source = page.url();
      if (navigation.preserveForms) {
        const forms = await page.locator("form").count(); if (forms) await fillValid(page);
      }
      const edited = navigation.dirtyWarning && await editDirtyField(page);
      if (navigation.dirtyWarning && !edited) onSkip({ reason: `未保存输入保护检查未执行：点击「${link.label}」前没有可编辑的可见字段，或未能产生有效输入变化` });
      const fields = await page.locator("input:not([type=hidden]),textarea,select").evaluateAll((fs) => fs.map((f, i) => ({ key: f.id || f.name || String(i), value: f.value, checked: ["checkbox", "radio"].includes(f.type) ? f.checked : undefined, selection: f.tagName === "SELECT" ? [...f.selectedOptions].map((o) => o.value) : undefined })));
      await page.locator(link.selector).scrollIntoViewIfNeeded();
      const position = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
      if (edited) await newVisibleDialog(page, true);
      let warned = false; page.on("dialog", (d) => { if (["beforeunload", "confirm"].includes(d.type())) warned = true; });
      let status = 0; page.on("response", (r) => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) status = r.status(); });
      await page.locator(link.selector).click({ timeout: 2500 }); await quiet(page);
      if (edited && !warned && routePath(page.url()) === routePath(source)) warned = await newVisibleDialog(page);
      if (edited && !warned) await addFinding(out, { rule: "draft-leave-unprotected", cat: "状态", msg: `按配置要求应保护未保存输入，但点击「${link.label}」离开时没有确认提示` }, page, shoot);
      if (warned && routePath(page.url()) === routePath(source)) continue;
      const landed = page.url();
      if (status >= 400) { await addFinding(out, { rule: "broken-navigation", cat: "流程", msg: `点击「${link.label}」到达 ${routePath(landed)}，页面返回 HTTP ${status}` }, page, shoot); continue; }
      if (new URL(landed).origin !== new URL(source).origin) { onSkip({ reason: "导航跳到其他来源，未继续检查" }); continue; }
      if (routePath(landed) === routePath(source)) { onSkip({ reason: `「${link.label}」没有改变 URL，可能展开了内部状态，交由状态探索检查` }); continue; }
      const direct = await openProbe(ctx, landed, { vp, markDirty, skip });
      try {
        if (direct.response?.status() >= 400 || direct.log.errors.some((e) => !e.startsWith("console:"))) await addFinding(out, { rule: "deep-link-broken", cat: "流程", msg: `「${link.label}」在站内可以进入，但直接打开 ${routePath(landed)} 返回错误或崩溃` }, direct.page, shoot);
        const reloaded = await direct.page.reload({ timeout: 15000 }); await quiet(direct.page);
        if (reloaded?.status() >= 400) await addFinding(out, { rule: "reload-broken", cat: "流程", msg: `刷新 ${routePath(landed)} 返回 HTTP ${reloaded.status()}` }, direct.page, shoot);
      } finally { await direct.close(); }
      await page.goBack({ timeout: 15000 }); await quiet(page);
      if (routePath(page.url()) !== routePath(source)) await addFinding(out, { rule: "history-back-broken", cat: "流程", msg: `从「${link.label}」后退没有回到原页面 ${routePath(source)}` }, page, shoot);
      else {
        if (navigation.preserveForms) {
          const restored = await page.locator("input:not([type=hidden]),textarea,select").evaluateAll((fs) => fs.map((f, i) => ({ key: f.id || f.name || String(i), value: f.value, checked: ["checkbox", "radio"].includes(f.type) ? f.checked : undefined, selection: f.tagName === "SELECT" ? [...f.selectedOptions].map((o) => o.value) : undefined })));
          if (fields.some((f) => (f.value || f.checked || f.selection?.length) && !restored.some((r) => r.key === f.key && r.value === f.value && r.checked === f.checked && JSON.stringify(r.selection) === JSON.stringify(f.selection)))) await addFinding(out, { rule: "history-input-lost", cat: "状态", msg: "后退时输入或筛选条件丢失，违反配置中的 preserveForms 要求" }, page, shoot);
        }
        if (navigation.preserveScroll) {
          const y = await page.evaluate(() => scrollY);
          if (Math.abs(y - position.y) > 50) await addFinding(out, { rule: "history-scroll-lost", cat: "状态", msg: `后退后滚动位置从 ${position.y}px 变成 ${y}px，违反 preserveScroll 要求` }, page, shoot);
        }
        await page.goForward({ timeout: 15000 }); await quiet(page);
        if (routePath(page.url()) !== routePath(landed)) await addFinding(out, { rule: "history-forward-broken", cat: "流程", msg: `前进没有恢复 ${routePath(landed)} 的导航状态` }, page, shoot);
      }
    } finally { await probe.close(); await reset(); }
  }
  return out;
}
