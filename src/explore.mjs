import { controls, openProbe, quiet, DEFAULT_SKIP } from "./actions.mjs";

export async function exploreStates(ctx, url, { limits = {}, vp = "desktop", skip = DEFAULT_SKIP, onState = async () => [], afterState = async () => [], onSkip = () => {}, markDirty = () => {}, reset = async () => {} } = {}) {
  const out = []; const maxDepth = limits.depth ?? 2; const maxStates = limits.states ?? 8; const maxControls = limits.controls ?? 25;
  const queue = [[]]; const visited = new Set(); let states = 0; let initialControls = new Set(); let initialInputs = new Set(); let initialLinks = new Set();
  while (queue.length && states < maxStates) {
    const chain = queue.shift(); const probe = await openProbe(ctx, url, { vp, markDirty }); const { page } = probe; let snapshot;
    try {
      let replayed = true; const apiBefore = probe.log.api.length;
      for (const action of chain) {
        const el = page.locator(action.selector);
        if (!await el.count() || !await el.isVisible() || !await el.isEnabled()) { onSkip({ reason: `状态路径无法重放：${action.label}` }); replayed = false; break; }
        await el.click({ timeout: 1500 }); await quiet(page, 30);
        if (new URL(page.url()).origin !== new URL(url).origin) { onSkip({ reason: "操作跳转到了其他来源，未继续遍历" }); replayed = false; break; }
      }
      if (!replayed) continue;
      const signature = await page.evaluate(() => JSON.stringify({
        url: location.href, text: document.body.innerText.slice(0, 8000),
        widgets: [...document.querySelectorAll('[aria-expanded],[aria-selected],[aria-checked],dialog[open]')].map((e) => [e.id, e.getAttribute("aria-expanded"), e.getAttribute("aria-selected"), e.getAttribute("aria-checked"), e.open]),
        fields: [...document.querySelectorAll('form,input:not([type=hidden]),textarea,select')].map((e) => [e.id, e.type, e.required, e.noValidate, e.min, e.max, e.minLength, e.maxLength, e.pattern, e.disabled, e.readOnly, e.value, e.checked]),
        controls: [...document.querySelectorAll('button,[role=button],[role=tab],summary,a[href]')].filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && Number(s.opacity) > .1; }).map((e) => [e.id, e.getAttribute("role"), e.getAttribute("href"), e.getAttribute("aria-label")]),
      }));
      if (visited.has(signature)) continue;
      visited.add(signature); states++;
      // 先收集后继，再调用会移动焦点 / 关闭弹窗的检查器。
      const candidates = await controls(page);
      const inputs = await controls(page, 'input:not([type=hidden]),textarea');
      const links = await controls(page, 'a[href]');
      if (!chain.length) { initialControls = new Set(candidates.map((c) => c.selector)); initialInputs = new Set(inputs.map((c) => c.selector)); initialLinks = new Set(links.map((c) => c.selector + c.href)); }
      const next = candidates.filter((c) => !skip.test(c.skipText) && !(c.form && ["submit", "reset"].includes(c.type)) && c.type !== "file");
      if (chain.length < maxDepth) {
        for (const action of next.slice(0, maxControls)) queue.push([...chain, action]);
        if (next.length > maxControls) onSkip({ reason: `状态内控件超过 ${maxControls} 个上限` });
      } else if (next.some((c) => !chain.some((p) => p.selector === c.selector))) onSkip({ reason: `状态探索达到深度 ${maxDepth} 上限` });
      if (chain.length) {
        const state = { chain, depth: chain.length, opener: chain.at(-1).selector, controls: candidates, inputs, newControls: candidates.filter((c) => !initialControls.has(c.selector)), newInputs: inputs.filter((c) => !initialInputs.has(c.selector)), newLinks: links.filter((c) => !initialLinks.has(c.selector + c.href)), newRequests: probe.log.api.slice(apiBefore) };
        for (const f of await onState(page, state)) out.push({ ...f, state: chain.map((x) => x.label).join(" → ") });
        snapshot = state;
      }
    } catch (e) {
      if (e.code === "ISOLATION") throw e;
      out.push({ rule: "probe-error", cat: "工具", severity: "warning", msg: `状态检查未完成：${chain.map((x) => x.label).join(" → ") || "初始页"}：${e.message.split("\n")[0]}` });
    } finally { await probe.close(); await reset(); }
    if (snapshot) {
      try { for (const f of await afterState(snapshot)) out.push({ ...f, state: chain.map((x) => x.label).join(" → ") }); }
      catch (e) { if (e.code === "ISOLATION") throw e; out.push({ rule: "probe-error", cat: "工具", severity: "warning", msg: `状态行为检查未完成：${e.message.split("\n")[0]}` }); }
      finally { await reset(); }
    }
  }
  if (queue.length) onSkip({ reason: `状态探索达到 ${maxStates} 个状态上限，还有 ${queue.length} 条路径未检查` });
  return out;
}
