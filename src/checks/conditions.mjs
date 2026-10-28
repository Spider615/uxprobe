// 条件对比：同一页面在 正常 / 空数据 / 接口失败 / 接口慢 / 字段为空 / 超长文本 下各渲染一次，
// 比较渲染出来的文字。不需要知道页面的业务含义：比如「失败时」和「空数据时」长得一模一样，
// 就说明失败被显示成了没有数据。
import { isRead, isWrite, lines, minus, sameLines, settle, watch, newContext } from "../browser.mjs";
import { replayActions } from "../actions.mjs";

const ID_KEY = /^(id|key|uuid|slug)$|Id$|_id$|Key$/;
const ERROR_WORD = /失败|错误|出错|异常|重试|不可用|error|failed|retry/i;
const LONG = "超长文本测试".repeat(12);

// 对列表和详情对象做通用变形，保留标识符。
export function transform(value, mode, inList = false) {
  if (Array.isArray(value)) return mode === "empty" ? [] : value.map((v) => transform(v, mode, true));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      if (!ID_KEY.test(k)) {
        if (mode === "null" && (typeof v === "string" || (inList && (Array.isArray(v) || (v && typeof v === "object"))))) return [k, null];
        if (mode === "long" && typeof v === "string" && v.length < 200 && !/^\d{4}-\d\d-\d\d|^https?:/.test(v)) return [k, v + LONG];
      }
      return [k, transform(v, mode, inList)];
    }));
  }
  return value;
}

async function render(ctx, url, mode, endpoint, { replay = [], vp = "desktop", markDirty = () => {}, readOnly = false } = {}) {
  const isolated = await newContext(ctx.browser(), vp, await ctx.storageState({ indexedDB: true }), { readOnly });
  isolated.on("request", (r) => { if (isWrite(r)) markDirty(); });
  isolated.on("page", (p) => p.on("dialog", (d) => d.dismiss().catch(() => {})));
  const page = await isolated.newPage(); const log = watch(page); let hits = 0; let active = !replay.length;
  try {
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (!active || !isRead(req) || mode === "normal" || (endpoint && (new URL(req.url()).pathname !== endpoint.path || req.method() !== endpoint.method))) return route.fallback();
    hits++;
    if (/^\d{3}$/.test(String(mode))) return route.fulfill({ status: Number(mode), contentType: "application/json", body: JSON.stringify({ error: `uxprobe HTTP ${mode}` }) });
    if (mode === "offline" || mode === "timeout") return route.abort(mode === "timeout" ? "timedout" : "internetdisconnected");
    if (mode === "slow") { await new Promise((r) => setTimeout(r, 3000)); return route.fallback(); }
    const res = await route.fetch().catch(() => null); if (!res) return route.abort();
    let body; try { body = await res.json(); } catch { return route.fulfill({ response: res }); }
    return route.fulfill({ response: res, json: transform(body, mode) });
  });
  let apiCalls = 0; page.on("request", (r) => { if (active && isRead(r)) apiCalls++; });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (replay.length) { await settle(page, 100); await replayActions(page, replay.slice(0, -1)); active = true; log.api.length = 0; await replayActions(page, replay.slice(-1), { waitLast: false }); }
  if (mode === "slow") await page.waitForTimeout(1200);
  else await settle(page, 800);
  const text = await lines(page);
  const extra = await page.evaluate(() => ({
    busy: !!document.querySelector("[aria-busy=true],[role=progressbar],.animate-spin,.animate-pulse,[class*=skeleton i],[class*=spinner i],[class*=loading i]"),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  })).catch(() => ({ busy: false, overflow: 0 }));
  return { page, text, log, apiCalls, hits, ...extra, close: () => isolated.close() };
  } catch (e) { await isolated.close(); throw e; }
}

export async function conditionChecks(desktop, mobile, url, shoot = async () => undefined, { faultModes = [401, 403, 429, "offline", "timeout"], partial = true, limits = {}, onSkip = () => {}, replay = [], markDirty = () => {}, readOnly = false, reset = async () => {} } = {}) {
  const out = [];
  const opened = [];
  const renderAt = async (ctx, mode, endpoint, vp = "desktop") => {
    const r = await render(ctx, url, mode, endpoint, { replay, vp, markDirty, readOnly }); opened.push(r);
    try { if (mode !== "normal") r.shot = await shoot(r.page, `condition-${mode}`); }
    finally { await r.close(); await reset(); }
    return r;
  };
  try {
  const N = await renderAt(desktop, "normal");
  if (!N.apiCalls) { await N.close(); onSkip({ reason: "没有发现可注入的 fetch/XHR 读取请求；SSR、流式或缓存状态需配置工作流" }); return out; }
  await N.close();
  const R = {};
  for (const mode of ["empty", "500", "slow", "null"]) R[mode] = await renderAt(desktop, mode);
  R.long = await renderAt(mobile, "long", undefined, "mobile");
  const LN = await renderAt(mobile, "normal", undefined, "mobile");
  const { empty: E, 500: F, slow: S, null: U, long: L } = R;
  const usesData = !sameLines(N.text, E.text);
  const add = async (rule, cat, msg, from) => out.push({ rule, cat, msg, shot: from.shot });

  if (usesData && sameLines(F.text, S.text) && !S.busy === !F.busy && !sameLines(F.text, E.text)) await add("error-stuck-loading", "反馈", "接口失败时页面一直停在加载中，没有报错也没有重试入口", F);
  else if (usesData && sameLines(F.text, E.text)) {
    if (minus(E.text, N.text).some((l) => ERROR_WORD.test(l))) await add("empty-as-error", "反馈", "数据为空时页面显示成了加载失败", E);
    else await add("error-as-empty", "反馈", "接口失败时页面显示成「没有数据」，和真的没有数据一模一样，用户会以为数据丢了", F);
  } else if (usesData && sameLines(F.text, N.text)) await add("silent-error", "反馈", "接口失败时页面没有任何变化和提示", F);

  if (usesData && sameLines(S.text, E.text) && !S.busy) await add("loading-as-empty", "反馈", "加载过程中先显示「没有数据」，等数据回来才变，用户会误以为是空的", S);
  else if (usesData && !S.busy && !sameLines(S.text, N.text) && minus(S.text, N.text).length === 0 && !sameLines(S.text, F.text)) await add("no-loading", "反馈", "接口慢的时候页面没有任何加载提示", S);

  if (usesData && minus(E.text, N.text).length === 0) await add("no-empty-state", "流程", "数据为空时页面上没有任何说明或引导，只剩一块空白", E);

  if (U.log.errors.length) await add("null-crash", "反馈", `列表里有字段为空时页面报错：${U.log.errors[0].split("\n")[0].slice(0, 140)}（疑似：如果接口保证这些字段不为空，可以忽略）`, U);
  else if (usesData && sameLines(U.text, F.text) && !sameLines(F.text, N.text)) await add("null-crash", "反馈", "列表里有字段为空时，整个页面按加载失败处理", U);
  const shownRaw = minus(U.text, N.text).join("\n").match(/(?<![\w./:-])(undefined|null|NaN|\[object Object\])(?![\w./:-])/);
  if (shownRaw) await add("null-shown", "呈现", `字段为空时页面直接显示 ${shownRaw[1]}`, U);

  if (L.overflow > 1 && LN.overflow <= 1) await add("long-text-overflow", "呈现", `文字变长时页面在手机宽度下横向溢出 ${L.overflow}px，布局被撑破`, L);

  const endpoints = [...new Map(N.log.api.filter((a) => a.read).map((a) => [`${a.method} ${a.path}`, a])).values()];
  if (endpoints.length > (limits.readEndpoints ?? 3)) onSkip({ reason: `局部读取故障最多抽查 ${limits.readEndpoints ?? 3} 个端点` });
  const jobs = faultModes.map((mode) => ({ mode }));
  if (partial && endpoints.length > 1) for (const endpoint of endpoints.slice(0, limits.readEndpoints ?? 3)) jobs.push({ mode: 500, endpoint });
  for (const { mode, endpoint } of jobs) {
    const result = await renderAt(desktop, mode, endpoint);
    try {
      if (!result.hits) { onSkip({ reason: `读取故障 ${mode} 未命中请求` }); continue; }
      const fresh = minus(result.text, N.text).join("\n");
      const recoverable = /失败|错误|异常|重试|登录|权限|限流|稍后|error|fail|retry|log.?in|sign.?in|unauthor|forbidden|denied|invalid|rate.?limit|offline|time.?out/i.test(fresh);
      if (result.log.errors.some((e) => !e.startsWith("console:") && !N.log.errors.includes(e))) await add("read-fault-crash", "反馈", `读取请求 ${endpoint ? endpoint.path + " " : ""}${mode} 时页面发生未捕获异常`, result);
      else if (!recoverable) out.push({ rule: "read-error-silent", cat: "反馈", severity: "warning", confidence: "heuristic", msg: `${endpoint ? "局部端点 " + endpoint.path : "读取请求"} ${mode} 时没有可识别的失败或恢复提示，请核对降级文案`, shot: result.shot });
    } finally { await result.close(); }
  }

  return out;
  } finally { for (const r of opened) await r.close(); }
}
