import { addFinding, controls, openProbe, quiet, DEFAULT_SKIP, completedDownload } from "../actions.mjs";

export async function componentChecks(ctx, url, { limits = {}, vp = "desktop", skip = DEFAULT_SKIP, markDirty = () => {}, reset = async () => {}, onSkip = () => {}, shoot, replay = [], onlySelectors } = {}) {
  const out = []; const first = await openProbe(ctx, url, { vp, markDirty, replay, skip }); let candidates;
  try { candidates = await controls(first.page, '[role=tab],[role=checkbox],[role=switch],[role=combobox],[role=button]:not(button):not(input),[role=link]:not(a),select,input[type=checkbox],input[type=radio],a[download]'); }
  finally { await first.close(); await reset(); }
  if (onlySelectors) candidates = candidates.filter((c) => onlySelectors.includes(c.selector));
  if (candidates.length > (limits.controls ?? 25)) onSkip({ reason: "复杂控件检查达到控件抽样上限" });
  for (const c of candidates.slice(0, limits.controls ?? 25)) {
    if (skip.test(c.skipText)) { onSkip({ reason: `skipClick：${c.label}` }); continue; }
    if (["button", "link", "checkbox", "switch"].includes(c.role)) out.push(...await customKeyboard(ctx, url, c, { vp, markDirty, reset, shoot, replay, skip }));
    if (["button", "link"].includes(c.role)) continue;
    const probe = await openProbe(ctx, url, { vp, markDirty, replay, skip }); const { page } = probe;
    try {
      const el = page.locator(c.selector); const downloads = [];
      page.on("download", (d) => downloads.push(d));
      const before = await el.evaluate((e) => ({ selected: e.getAttribute("aria-selected"), checked: e.getAttribute("aria-checked"), value: e.value, expanded: e.getAttribute("aria-expanded") }));
      if (c.tag === "SELECT") {
        const values = await el.locator("option").evaluateAll((os) => os.filter((o) => !o.disabled && o.value).map((o) => o.value));
        const other = values.find((v) => v !== before.value); if (!other) continue;
        await el.selectOption(other); await quiet(page, 40);
        if (await el.inputValue() !== other) await addFinding(out, { rule: "select-no-change", cat: "操作", msg: `选择「${c.label}」的新选项后值没有更新` }, page, shoot);
        continue;
      }
      await el.click({ timeout: 2000 }); await quiet(page, 40);
      if (c.role === "tab") {
        const state = await el.evaluate((e) => ({ selected: e.getAttribute("aria-selected"), panel: e.getAttribute("aria-controls") }));
        if (state.selected !== "true") await addFinding(out, { rule: "tab-no-switch", cat: "操作", msg: `点击标签页「${c.label}」后没有切换选中状态` }, page, shoot);
        if (state.panel && !await page.locator(`[id="${state.panel.replaceAll('"', '\\"')}"]`).isVisible()) await addFinding(out, { rule: "tab-panel-hidden", cat: "呈现", msg: `标签页「${c.label}」选中后，对应内容区域仍不可见` }, page, shoot);
        const peers = await el.evaluate((e) => { const list = e.closest('[role=tablist]'); return list && list.getAttribute("aria-multiselectable") !== "true" ? [...list.querySelectorAll('[role=tab][aria-selected=true]')].length : 1; });
        if (peers > 1) await addFinding(out, { rule: "tab-multiple-selected", cat: "操作", msg: `切换「${c.label}」后，同一个单选标签组有多个标签保持选中` }, page, shoot);
        const tabs = await el.evaluate((e) => { const list = e.closest('[role=tablist]'); return list ? [...list.querySelectorAll('[role=tab]')].length : 0; });
        if (tabs > 1) {
          const moved = await el.evaluate((e) => e.closest('[role=tablist]').getAttribute("aria-orientation") === "vertical" ? "ArrowDown" : "ArrowRight");
          const moveFocus = async () => {
            await el.focus(); await el.press(moved); await quiet(page, 30);
            return el.evaluate((e) => { const active = document.activeElement; const list = e.closest('[role=tablist]'); return { moved: active !== e && !!list?.contains(active) && active.getAttribute("role") === "tab", selected: active?.getAttribute("aria-selected"), label: [active?.getAttribute("aria-label"), active?.innerText, active?.getAttribute("title")].filter(Boolean).join(" ") }; });
          };
          let keyState = await moveFocus();
          if (!keyState.moved) await addFinding(out, { rule: "tab-keyboard", cat: "操作", msg: `标签页「${c.label}」按 ${moved} 没有把焦点移到相邻标签` }, page, shoot);
          else if (keyState.selected !== "true") {
            for (const key of ["Enter", "Space"]) {
              if (key === "Space") { await el.click({ timeout: 2000 }); await quiet(page, 40); keyState = await moveFocus(); }
              if (!keyState.moved) break;
              if (skip.test(keyState.label)) { onSkip({ reason: `skipClick：${keyState.label}` }); break; }
              const target = await page.evaluateHandle(() => document.activeElement);
              try {
                await page.keyboard.press(key); await quiet(page, 30);
                if (await target.evaluate((tab) => tab.getAttribute("aria-selected")) !== "true") await addFinding(out, { rule: "tab-keyboard", cat: "操作", msg: `标签页「${keyState.label}」获得焦点后，按 ${key === "Space" ? "空格" : key} 没有切换选中状态` }, page, shoot);
              } finally { await target.dispose(); }
            }
          }
        }
      } else if (["checkbox", "switch"].includes(c.role)) {
        if (await el.getAttribute("aria-checked") === before.checked) await addFinding(out, { rule: "toggle-no-change", cat: "操作", msg: `点击「${c.label}」后开关状态没有改变` }, page, shoot);
      } else if (c.role === "combobox") {
        await el.press("ArrowDown"); await el.press("Enter"); await quiet(page, 40);
        const after = await el.evaluate((e) => ({ value: e.value, expanded: e.getAttribute("aria-expanded") }));
        if (before.value === after.value && before.expanded === after.expanded) onSkip({ reason: `自定义选择器「${c.label}」未发现可选择项，需配置工作流验证` });
        await el.press("Escape");
        if (await el.getAttribute("aria-expanded") === "true") await addFinding(out, { rule: "combobox-escape", cat: "操作", msg: `「${c.label}」按 Escape 后下拉选项仍展开` }, page, shoot);
      }
      for (const d of downloads) {
        const result = await completedDownload(d);
        if (result.failure) await addFinding(out, { rule: "download-failed", cat: "反馈", msg: `「${c.label}」下载失败：${result.failure}` }, page, shoot);
        else if (result.bytes === 0) await addFinding(out, { rule: "download-empty", cat: "反馈", msg: `「${c.label}」下载结果为空文件` }, page, shoot);
      }
      if (c.tag === "A" && !downloads.length) await addFinding(out, { rule: "download-missing", cat: "反馈", msg: `点击下载链接「${c.label}」后没有收到下载文件` }, page, shoot);
    } finally { await probe.close(); await reset(); }
  }
  return out;
}

async function customKeyboard(ctx, url, control, { vp, markDirty, reset, shoot, replay, skip }) {
  const out = [];
  const effect = async (key) => {
    const probe = await openProbe(ctx, url, { vp, markDirty, replay, skip }); let changed = false;
    try {
      const el = probe.page.locator(control.selector);
      await el.focus();
      const before = await probe.page.locator("body").innerText(); const beforeURL = probe.page.url();
      let events = 0; for (const event of ["request", "download", "popup", "filechooser", "dialog"]) probe.page.on(event, () => events++);
      await probe.page.evaluate(() => { window.__uxKeyMutations = 0; new MutationObserver(() => window.__uxKeyMutations++).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true }); });
      if (key) await el.press(key); else await el.click();
      await quiet(probe.page, 40);
      changed = events > 0 || beforeURL !== probe.page.url() || before !== await probe.page.locator("body").innerText() || await probe.page.evaluate(() => window.__uxKeyMutations > 0);
      if (key && !changed) await addFinding(out, { rule: "keyboard-activation", cat: "操作", msg: `「${control.label}」鼠标点击有反应，但按 ${key === "Space" ? "空格" : key} 没有响应` }, probe.page, shoot);
      return changed;
    } finally { await probe.close(); await reset(); }
  };
  if (await effect(null)) {
    if (["button", "link"].includes(control.role)) await effect("Enter");
    if (["button", "checkbox", "switch"].includes(control.role)) await effect("Space");
  }
  return out;
}
