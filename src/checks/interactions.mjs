// 交互检查：真的去点、去输入，看反馈、写入后的状态、重复提交、回车提交、竞态。
// 每个动作都在新打开的页面上做，互不影响；有写入就让沙箱重置数据。
import { isApi, isRead, isWrite, lines, minus, mutationsSince, now, sameLines, settle, startMutationLog } from "../browser.mjs";
import { openProbe, DEFAULT_SKIP, VISIBLE_CLICKABLE, completedDownload, controls as describeControls, fillValid } from "../actions.mjs";
import { installPerformance, performanceChecks } from "./performance.mjs";

const CONTROLS = VISIBLE_CLICKABLE;
const TEXT_INPUT = "input:visible:not([type]), input:visible[type=text], input:visible[type=search], input:visible[type=email], textarea:visible";
const RETRY = /重试|重新加载|刷新|retry|reload/i;
let counter = 0;

// 记录一次动作期间发生的所有事：请求、写入、跳转、下载、选文件、弹窗、新标签页
function track(page) {
  const t = { requests: 0, writes: [], navigated: false, download: false, downloads: [], chooser: false, dialog: false, popup: false, pending: 0, maxPending: 0 };
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) t.navigated = true;
    if (isApi(r) || isWrite(r)) { t.requests++; if (isWrite(r)) { t.pending++; t.maxPending = Math.max(t.maxPending, t.pending); t.writes.push({ method: r.method(), path: new URL(r.url()).pathname, status: 0, request: r }); } }
  });
  page.on("requestfinished", async (r) => { if (!isWrite(r)) return; const res = await r.response().catch(() => null); const w = t.writes.find((x) => x.request === r); if (w) w.status = res?.status() ?? 0; t.pending--; });
  page.on("requestfailed", (r) => { if (isWrite(r)) { t.pending--; } });
  page.on("download", (d) => { t.download = true; t.downloads.push(d); });
  page.on("filechooser", () => (t.chooser = true));
  page.on("dialog", () => (t.dialog = true));
  page.on("popup", () => (t.popup = true));
  return t;
}
async function waitWrites(page, t, max = 8000) {
  const end = Date.now() + max;
  while (t.pending > 0 && Date.now() < end) await page.waitForTimeout(100);
  await settle(page, 800);
}

// 点之前把同一个表单里空着的文本框填上，模拟用户正常输入
async function fillForm(control) {
  const value = `uxprobe测试${++counter}`;
  await control.evaluate((el, value) => {
    const scope = el.closest("form") ?? null; if (!scope) return;
    for (const f of scope.querySelectorAll("input:not([type]),input[type=text],input[type=search],input[type=email],textarea")) {
      if (f.value) continue;
      const setter = Object.getOwnPropertyDescriptor(f.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
      setter.call(f, f.type === "email" ? `uxprobe${Date.now() % 1e6}@example.com` : value);
      f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, value).catch(() => {});
  const form = await control.evaluate((el) => { const form = el.closest("form"); if (!form) return null; form.dataset.uxValidForm = "1"; return "[data-ux-valid-form]"; });
  if (form) await fillValid(control.page(), form);
  return value;
}

async function controlLabels(page, skip, max = 25, onlySelectors) {
  const loc = page.locator(CONTROLS); const n = await loc.count(); const out = []; const descriptions = await describeControls(page, CONTROLS);
  for (let i = 0; i < n; i++) {
    const description = descriptions.find((c) => c.index === i);
    if (onlySelectors && !onlySelectors.includes(description?.selector)) continue;
    const el = loc.nth(i);
    const parts = await el.evaluate((e) => [e.innerText, e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("value")].filter(Boolean).join(" ")).catch(() => "");
    const label = ((await el.getAttribute("aria-label").catch(() => null)) || (await el.innerText().catch(() => "")) || (await el.getAttribute("title").catch(() => null)) || (await el.getAttribute("value").catch(() => null)) || "").trim().replace(/\s+/g, " ").slice(0, 30);
    const usable = await el.evaluate((e) => !e.disabled && Number(getComputedStyle(e).opacity) > 0.1 && !e.closest("dialog:not([open])")).catch(() => false);
    if (label && usable && !skip.test(parts)) out.push({ index: i, label, selector: description?.selector });
    if (out.length >= max) break;
  }
  return out;
}

export async function interactionChecks(ctx, url, { skip = DEFAULT_SKIP, reset = async () => {}, markDirty = () => {}, shoot = async () => undefined, limits = {}, vp = "desktop", onSkip = () => {}, onWrite = () => {}, performance, liveStatus = true, replay = [], onlySelectors, onlyInputs } = {}) {
  const out = [];
  const probes = new Map();
  const open = async () => { const p = await openProbe(ctx, url, { vp, markDirty, replay, skip, ...(performance ? { prepare: installPerformance } : {}) }); probes.set(p.page, p); return p; };
  const closePage = async (page) => { const p = probes.get(page); if (p) { probes.delete(page); await p.close(); } };
  try {
  const add = async (rule, cat, msg, page) => out.push({ rule, cat, msg, shot: page ? await shoot(page, rule) : undefined });
  const first = await open(ctx, url);
  const initial404 = first.log.api.some((a) => a.status === 404);
  const totalControls = onlySelectors?.length ?? await first.page.locator(CONTROLS).count();
  if (totalControls > (limits.controls ?? 25)) onSkip({ reason: `交互控件超过 ${limits.controls ?? 25} 个上限` });
  const controls = await controlLabels(first.page, skip, limits.controls ?? 25, onlySelectors);
  const inputs = (await describeControls(first.page, TEXT_INPUT)).filter((c) => !onlyInputs || onlyInputs.includes(c.selector));
  if (inputs.length > (limits.inputs ?? 6)) onSkip({ reason: `文本输入框超过 ${limits.inputs ?? 6} 个上限` });
  await closePage(first.page); await reset();

  for (const { index, label, selector } of controls) {
    const { page, log } = await open(ctx, url);
    const el = page.locator(CONTROLS).nth(index);
    const value = await fillForm(el);
    const before = await lines(page);
    const statusBefore = await page.locator('[role=status],[role=alert],[data-status]').evaluateAll((nodes) => nodes.map((e) => ({ text: e.innerText, name: e.getAttribute("aria-label"), color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor })));
    await startMutationLog(page); const t0 = await now(page);
    const t = track(page); log.errors.length = 0; const apiBefore = log.api.length;
    const clicked = await el.click({ timeout: 2000 }).then(() => true, () => false);
    if (!clicked) { onSkip({ reason: `「${label}」无法点击，未完成此操作的交互检查` }); await closePage(page); await reset(); continue; }
    await page.waitForTimeout(700); await waitWrites(page, t);
    const changed = await mutationsSince(page, t0);
    const navigated = t.navigated; // 后面会主动刷新，先记下点击本身有没有跳转
    const after = navigated ? [] : await lines(page);
    if (log.errors.length) await add("uncaught", "反馈", `点击「${label}」后报错：${log.errors[0]}`, page);
    const anything = changed > 0 || t.requests > 0 || navigated || t.download || t.chooser || t.dialog || t.popup;
    if (!anything) await add("no-feedback", "反馈", `点击「${label}」后页面没有任何变化，也没有发请求`, page);
    if (initial404 && RETRY.test(label) && log.api.slice(apiBefore).some((a) => a.status === 404))
      await add("retry-on-404", "流程", `内容不存在（404）时给了「${label}」按钮，点了还是 404，应该给返回入口`, page);
    const okWrites = t.writes.filter((w) => w.status >= 200 && w.status < 300);
    if (t.writes.length) onWrite({ index, label, selector });
    if (performance) out.push(...await performanceChecks(page, { thresholds: performance, onSkip }));
    if (liveStatus && !navigated) {
      const feedback = minus(after, before).filter((l) => /已保存|保存成功|提交成功|已提交|失败|错误|已创建|saved|submitted|success|failed|error/i.test(l));
      if (feedback.length && !await page.locator('[role=status]:visible,[role=alert]:visible,[aria-live=polite]:visible,[aria-live=assertive]:visible').count()) out.push({ rule: "live-status-missing", cat: "理解", severity: "warning", confidence: "heuristic", msg: `点击「${label}」后的动态提示缺少可识别的读屏通知语义，请核对焦点是否已承载提示`, shot: await shoot(page, "live-status-missing") });
      const statusAfter = await page.locator('[role=status],[role=alert],[data-status]').evaluateAll((nodes) => nodes.map((e) => ({ text: e.innerText, name: e.getAttribute("aria-label"), color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor })));
      if (statusBefore.some((before, i) => { const after = statusAfter[i]; return after && before.text === after.text && before.name === after.name && (before.color !== after.color || before.background !== after.background); })) out.push({ rule: "color-only-status", cat: "理解", severity: "warning", confidence: "heuristic", msg: `点击「${label}」后声明的状态区域只改变了颜色，文字和可访问名称没有变化`, shot: await shoot(page, "color-only-status") });
    }
    for (const d of t.downloads) {
      const result = await completedDownload(d);
      if (result.failure) await add("download-failed", "反馈", `「${label}」下载失败：${result.failure}`, page);
      else if (result.bytes === 0) await add("download-empty", "反馈", `「${label}」下载结果为空文件`, page);
    }
    if (t.writes.length) markDirty();
    if (okWrites.length && !navigated) {
      if (sameLines(before, after)) await add("write-no-feedback", "反馈", `点击「${label}」后数据已经保存（${okWrites[0].method} ${okWrites[0].path}），但页面上没有任何提示`, page);
      // 写入成功后刷新：刷新后才出现的内容 = 写完没更新页面；刷新后消失的输入 = 没真的存下来
      await page.reload().catch(() => {}); await settle(page);
      const reloaded = await lines(page);
      const appeared = minus(reloaded, after).filter((l) => !/\d+\s*(秒|分钟)前|刚刚|just now/i.test(l));
      const vanished = minus(after, reloaded).filter((l) => l.includes(value));
      if (vanished.length) await add("lost-after-reload", "状态", `点击「${label}」保存后页面显示「${vanished[0].slice(0, 30)}」，刷新后就没了，数据没有真的存下来`, page);
      else if (appeared.length) await add("stale-after-write", "状态", `点击「${label}」写入成功后页面没更新，要刷新才看到「${appeared[0].slice(0, 30)}」`, page);
    }
    await closePage(page);
    // 重复提交：快速点两下，第一次写请求还没返回、第二次就发出去了才算。前一次已经完成再存一次是正常的
    if (okWrites.length && !t.dialog && !navigated) {
      await reset();
      const again = await open(ctx, url); const el2 = again.page.locator(CONTROLS).nth(index);
      await fillForm(el2); const t2 = track(again.page);
      const box = await el2.boundingBox();
      if (box) {
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        await again.page.mouse.click(x, y); await again.page.waitForTimeout(120); await again.page.mouse.click(x, y);
        await waitWrites(again.page, t2);
        if (t2.maxPending > 1) await add("double-submit", "反馈", `快速点两下「${label}」在第一次还没返回时又发出了 ${t2.writes[0].method} ${t2.writes[0].path}，会重复提交`, again.page);
      }
      markDirty(); await closePage(again.page);
    }
    await reset();
  }

  for (const { index: i } of inputs.slice(0, limits.inputs ?? 6)) {
    // 回车提交：输入框不在表单里、旁边有按钮，按回车没反应但点按钮有反应
    {
      const { page } = await open(ctx, url); const input = page.locator(TEXT_INPUT).nth(i);
      const info = await input.evaluate((el) => {
        if (el.tagName === "TEXTAREA" || el.closest("form")) return null;
        for (let p = el.parentElement, d = 0; p && d < 3; p = p.parentElement, d++) {
          const b = [...p.querySelectorAll("button,[role=button]")].find((b) => b.offsetParent); if (b) { b.dataset.uxpPair = "1"; return true; }
        }
        return null;
      }).catch(() => null);
      if (info) {
        await input.fill("uxprobe"); await startMutationLog(page); const t0 = await now(page); const t = track(page);
        await input.press("Enter"); await page.waitForTimeout(700);
        const onEnter = t.requests + (await mutationsSince(page, t0)) + (t.navigated ? 1 : 0);
        if (!onEnter) {
          const t3 = track(page); const t1 = await now(page);
          await page.locator("[data-uxp-pair]").first().click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(700);
          if (t3.requests + (await mutationsSince(page, t1)) + (t3.navigated ? 1 : 0) > 0)
            await add("enter-no-submit", "操作", "在输入框里按回车没有反应，只能用鼠标点按钮", page);
        }
      }
      await closePage(page); await reset();
    }
    // 竞态：先输入一个词（让它的请求晚回来），再清空（请求正常），最终页面应该和没延迟时一样
    {
      const probe = await open(ctx, url); const input = probe.page.locator(TEXT_INPUT).nth(i);
      const t = track(probe.page); await input.fill("zqx").catch(() => {}); await probe.page.waitForTimeout(900);
      const searches = t.requests; await closePage(probe.page); await reset();
      if (!searches) continue;
      const run = async (delayFirst) => {
        const { page } = await open(ctx, url); let delayed = !delayFirst;
        await page.route("**/*", async (route) => {
          if (!delayed && isRead(route.request())) { delayed = true; await new Promise((r) => setTimeout(r, 1500)); }
          return route.fallback();
        });
        const box = page.locator(TEXT_INPUT).nth(i);
        await box.fill("zqx"); await page.waitForTimeout(350); await box.fill(""); await page.waitForTimeout(2600); await settle(page, 300);
        return { page, text: await lines(page) };
      };
      const control = await run(false); const raced = await run(true);
      if (!sameLines(control.text, raced.text)) await add("race", "状态", "连续输入时，先发出的搜索请求晚回来，把后面的结果覆盖了，页面显示的是旧结果", raced.page);
      await closePage(control.page); await closePage(raced.page); await reset();
    }
  }
  return out;
  } finally { for (const p of probes.values()) await p.close(); await reset(); }
}
