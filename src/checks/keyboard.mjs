import { addFinding } from "../actions.mjs";

export async function keyboardChecks(page, { opener, limits = {}, onSkip = () => {}, shoot } = {}) {
  const out = []; const max = limits.tabStops ?? 80;
  const inventory = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && Number(s.opacity) > .1 && !el.disabled && !el.closest("[inert],[aria-hidden=true]"); };
    const modal = [...document.querySelectorAll('dialog:modal,dialog[open][aria-modal="true"],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]')].filter(visible).at(-1);
    let i = 0;
    const style = (el) => { const s = getComputedStyle(el); return [s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join("|"); };
    const items = [...(modal || document).querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[role=option],[role=combobox],[tabindex]')].filter(visible).map((el) => {
      el.dataset.uxk = String(++i);
      const managed = !!el.closest('[role=tablist],[role=listbox],[role=menu],[role=menubar],[role=radiogroup],[role=tree],[role=grid]') || (el.type === "radio" && !!el.name);
      return { id: el.dataset.uxk, label: (el.getAttribute("aria-label") || el.innerText || el.getAttribute("name") || el.tagName).trim().slice(0, 40), managed, before: style(el) };
    });
    if (modal) modal.dataset.uxkModal = "1";
    return { items, modal: !!modal, entered: !modal || modal.contains(document.activeElement), focus: document.activeElement?.dataset.uxk, scroll: { x: scrollX, y: scrollY } };
  });
  const report = (rule, msg, severity) => addFinding(out, { rule, cat: "操作", msg, ...(severity ? { severity, confidence: "heuristic" } : {}) }, page, shoot);
  try {
    if (inventory.modal && !inventory.entered) await report("modal-focus", "弹窗打开后焦点仍停留在背景，键盘用户没有进入弹窗");
    if (inventory.items.length > max) onSkip({ reason: `键盘焦点检查达到 ${max} 个停靠点上限` });
    if (!inventory.modal) await page.evaluate(() => { document.activeElement?.blur(); document.body.setAttribute("data-uxk-tabindex", document.body.getAttribute("tabindex") ?? "absent"); document.body.tabIndex = -1; document.body.focus(); });
    const reached = new Set(); const invisible = new Set(); let escaped = false; let complete = false;
    for (let n = 0; n < Math.min(max, inventory.items.length + 3); n++) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const el = document.activeElement; const s = getComputedStyle(el); const modal = document.querySelector('[data-uxk-modal="1"]');
        return { id: el.dataset.uxk, body: el === document.body, outside: !!modal && el !== document.body && !modal.contains(el), indicator: (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none", style: [s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join("|") };
      });
      if (focus.outside) escaped = true;
      if (focus.id) {
        if (reached.has(focus.id)) { complete = true; break; }
        reached.add(focus.id);
        const original = inventory.items.find((x) => x.id === focus.id);
        if (original && !focus.indicator && original.before === focus.style) invisible.add(focus.id);
      }
    }
    if (escaped) await report("modal-focus-trap", "按 Tab 时焦点离开模态弹窗，落到了背景控件上");
    for (const item of inventory.items.slice(0, max)) {
      if (!item.managed && !reached.has(item.id) && (complete || inventory.items.length <= max)) await report("keyboard-unreachable", `「${item.label}」可用鼠标操作，但 Tab 无法到达`);
    }
    if (invisible.size) await report("focus-invisible", `${invisible.size} 个控件获得键盘焦点后没有可识别的焦点样式，请核对自定义焦点效果`, "warning");
    if (inventory.modal) {
      await page.keyboard.press("Escape"); await page.waitForTimeout(40);
      const modal = page.locator('[data-uxk-modal="1"]');
      if (await modal.isVisible()) await report("modal-escape", "模态弹窗按 Escape 后仍未关闭");
      else if (opener && await page.locator(opener).count()) {
        const returned = await page.locator(opener).evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
        if (!returned) await report("modal-focus-return", "弹窗关闭后焦点没有回到触发控件，请核对是否已移到下一步合理位置", "warning");
      }
    }
  } finally {
    await page.evaluate(({ focus, scroll }) => {
      const old = document.body.getAttribute("data-uxk-tabindex");
      if (old !== null) { if (old === "absent") document.body.removeAttribute("tabindex"); else document.body.setAttribute("tabindex", old); document.body.removeAttribute("data-uxk-tabindex"); }
      if (focus) document.querySelector(`[data-uxk="${focus}"]`)?.focus({ preventScroll: true });
      window.scrollTo(scroll.x, scroll.y);
      document.querySelectorAll("[data-uxk],[data-uxk-modal]").forEach((el) => { delete el.dataset.uxk; delete el.dataset.uxkModal; });
    }, inventory).catch(() => {});
  }
  return out;
}
