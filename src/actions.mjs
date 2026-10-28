import { isWrite, watch } from "./browser.mjs";
import { stat } from "node:fs/promises";

export const CLICKABLE = "button,[role=button],[role=link],[role=tab],summary,input[type=submit],input[type=button]";
export const VISIBLE_CLICKABLE = CLICKABLE.split(",").map((s) => `${s}:visible`).join(",");
export const ACTIONS = CLICKABLE + ",[role=checkbox],[role=switch],[role=combobox],select,input[type=checkbox],input[type=radio]";
export const DEFAULT_SKIP = /退出|登出|注销|logout|sign ?out/i;

export async function controls(page, selector = ACTIONS) {
  return page.locator(selector).evaluateAll((elements) => {
    const selectorFor = (el) => {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
      const parts = [];
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        const siblings = [...p.parentElement.children].filter((x) => x.tagName === p.tagName);
        parts.unshift(p.tagName.toLowerCase() + `:nth-of-type(${siblings.indexOf(p) + 1})`);
      }
      return "body>" + parts.join(">");
    };
    return elements.filter((el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && Number(s.opacity) > 0.1 && !el.disabled && !el.closest("[inert],[aria-hidden=true]");
    }).map((el) => ({
      index: elements.indexOf(el),
      selector: selectorFor(el), label: (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.getAttribute("value") || el.getAttribute("name") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 60),
      skipText: [el.getAttribute("aria-label"), el.innerText, el.getAttribute("title"), el.getAttribute("value")].filter(Boolean).join(" "),
      tag: el.tagName, type: el.type, role: el.getAttribute("role"), form: !!el.closest("form"),
      href: el.tagName === "A" ? el.href : undefined,
    }));
  });
}

// 每个试验用独立 context，避免 localStorage、IndexedDB、cookie 等客户端状态串用。
export async function openProbe(ctx, url, { markDirty = () => {}, storageState, vp = "desktop", prepare, replay = [], skip = DEFAULT_SKIP } = {}) {
  const { newContext } = await import("./browser.mjs");
  const isolated = await newContext(ctx.browser(), vp, storageState ?? await ctx.storageState({ indexedDB: true }));
  isolated.on("request", (req) => { if (isWrite(req)) markDirty(); });
  isolated.on("page", (p) => p.on("dialog", (dialog) => dialog.dismiss().catch(() => {})));
  const page = await isolated.newPage(); const log = watch(page);
  try {
    if (prepare) await prepare(page);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await quiet(page);
    await replayActions(page, replay, { skip });
    return { page, log, response, close: () => isolated.close() };
  } catch (e) { await isolated.close(); throw e; }
}

export async function replayActions(page, chain, { skip = DEFAULT_SKIP, waitLast = true } = {}) {
  for (const [i, action] of chain.entries()) {
    const el = page.locator(action.selector);
    const label = await el.evaluate((e) => [e.innerText, e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("value")].filter(Boolean).join(" "));
    if (skip.test(label)) throw new Error(`skipClick：无法重放 ${action.label}`);
    await el.click({ timeout: 1500 });
    if (waitLast || i < chain.length - 1) await quiet(page, 30);
  }
}

export async function quiet(page, extra = 80) {
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(extra);
}

export async function fillValid(page, selector = "form") {
  return page.locator(selector).first().evaluate((scope) => {
    const values = [];
    for (const f of scope.querySelectorAll("input,textarea,select")) {
      const r = f.getBoundingClientRect();
      if (f.disabled || f.readOnly || !r.width || !r.height || /^(hidden|submit|button|reset|file)$/.test(f.type)) continue;
      if (f.tagName === "SELECT") { if (!f.value) f.value = [...f.options].find((o) => o.value && !o.disabled)?.value ?? ""; }
      else if (["checkbox", "radio"].includes(f.type)) { if (f.required) f.checked = true; }
      else if (!f.value) {
        const temporal = { date: "2026-01-01", time: "12:00", "datetime-local": "2026-01-01T12:00", month: "2026-01", week: "2026-W01" };
        let value = f.type === "email" ? "uxprobe@example.com" : f.type === "url" ? "https://example.com" : f.type === "number" || f.type === "range" ? (f.min || (f.max !== "" && Number(f.max) < 1 ? f.max : "1")) : temporal[f.type] ? (f.min || f.max || temporal[f.type]) : "Uxprobe123test";
        if (f.minLength > value.length) value += "x".repeat(Math.min(f.minLength - value.length, 1000));
        if (f.maxLength > 0) value = value.slice(0, f.maxLength);
        const prototype = f.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(f, value);
      }
      f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true }));
      values.push({ id: f.id, name: f.name, type: f.type, value: f.value });
    }
    return values;
  });
}

// 构造一个有效、非默认的编辑；受约束字段无法安全改值时由调用方记录未测。
export async function editValid(page, selector = "form") {
  const fields = page.locator(selector).first().locator("input,textarea,select");
  for (let i = 0; i < await fields.count(); i++) {
    const field = fields.nth(i);
    const edit = await field.evaluate((f) => {
      if (f.disabled || f.readOnly || !f.getBoundingClientRect().width || /^(hidden|submit|button|reset|file|image)$/.test(f.type)) return null;
      const checked = ["checkbox", "radio"].includes(f.type); const property = checked ? "checked" : "value"; const before = f[property];
      if (checked ? before !== f.defaultChecked : f.tagName === "SELECT" ? [...f.options].some((o) => o.selected !== o.defaultSelected) && f.selectedIndex !== 0 : before !== f.defaultValue) return { property, before, alreadyEdited: true };
      let candidates;
      if (checked) candidates = [!before];
      else if (f.tagName === "SELECT") candidates = [...f.options].filter((o) => o.value && o.value !== before && !o.disabled).map((o) => o.value);
      else if (["number", "range"].includes(f.type)) { const step = Number(f.step) > 0 ? Number(f.step) : 1; const n = Number(f.value || f.min || 0); candidates = [String(n + step), String(n - step)]; }
      else candidates = [before + "x", "X" + before.slice(1), "Y" + before.slice(1), "uxprobe@example.com"];
      const prototype = f.tagName === "SELECT" ? HTMLSelectElement.prototype : f.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(prototype, property).set;
      for (const raw of candidates) {
        const value = typeof raw === "string" && f.maxLength > 0 ? raw.slice(0, f.maxLength) : raw;
        set.call(f, value);
        if (f[property] !== before && (checked || f[property] !== "") && f.validity.valid) { f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); return { property, before }; }
        set.call(f, before);
      }
      return null;
    });
    if (!edit) continue;
    if (edit.alreadyEdited) return true;
    await quiet(page);
    if (await field.evaluate((f, edit) => f[edit.property] !== edit.before, edit).catch(() => false)) return true;
  }
  return false;
}

export async function addFinding(out, finding, page, shoot) {
  out.push({ ...finding, ...(shoot ? { shot: await shoot(page, finding.rule) } : {}) });
}

export async function completedDownload(download, timeout = 5000) {
  let timer;
  try {
    return await Promise.race([
      (async () => { const failure = await download.failure(); const path = failure ? null : await download.path(); return { failure, bytes: path ? (await stat(path)).size : 0, filename: download.suggestedFilename() }; })(),
      new Promise((resolve) => { timer = setTimeout(() => { download.cancel().catch(() => {}); resolve({ failure: `下载等待超时（${timeout}ms），已取消本次测试下载`, bytes: 0, filename: download.suggestedFilename() }); }, timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}
