// 条件对比：同一页面在 正常 / 空数据 / 接口失败 / 接口慢 / 字段为空 / 超长文本 下各渲染一次，
// 比较渲染出来的文字。不需要知道页面的业务含义：比如「失败时」和「空数据时」长得一模一样，
// 就说明失败被显示成了没有数据。
import { isApi, lines, minus, sameLines, settle, watch } from "../browser.mjs";

const ID_KEY = /^(id|key|uuid|slug)$|Id$|_id$|Key$/;
const ERROR_WORD = /失败|错误|出错|异常|重试|不可用|error|failed|retry/i;
const LONG = "超长文本测试".repeat(12);

// 对接口返回的 JSON 做通用变形，只改列表里的对象
function transform(value, mode, inList = false) {
  if (Array.isArray(value)) return mode === "empty" ? [] : value.map((v) => transform(v, mode, true));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      if (inList && !ID_KEY.test(k)) {
        if (mode === "null" && (typeof v === "string" || Array.isArray(v) || (v && typeof v === "object"))) return [k, null];
        if (mode === "long" && typeof v === "string" && v.length < 200 && !/^\d{4}-\d\d-\d\d|^https?:|^[\w-]+$/.test(v)) return [k, v + LONG];
      }
      return [k, transform(v, mode, inList)];
    }));
  }
  return value;
}

async function render(ctx, url, mode) {
  const page = await ctx.newPage(); const log = watch(page); let hits = 0;
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (!isApi(req) || req.method() !== "GET" || mode === "normal") return route.fallback();
    hits++;
    if (mode === "500") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error" }) });
    if (mode === "slow") { await new Promise((r) => setTimeout(r, 3000)); return route.fallback(); }
    const res = await route.fetch().catch(() => null); if (!res) return route.abort();
    let body; try { body = await res.json(); } catch { return route.fulfill({ response: res }); }
    return route.fulfill({ response: res, json: transform(body, mode) });
  });
  let apiCalls = 0; page.on("request", (r) => { if (isApi(r) && r.method() === "GET") apiCalls++; });
  if (mode === "slow") { await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {}); await page.waitForTimeout(1200); }
  else { await page.goto(url).catch(() => {}); await settle(page, 800); }
  const text = await lines(page);
  const extra = await page.evaluate(() => ({
    busy: !!document.querySelector("[aria-busy=true],[role=progressbar],.animate-spin,.animate-pulse,[class*=skeleton i],[class*=spinner i],[class*=loading i]"),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  })).catch(() => ({ busy: false, overflow: 0 }));
  return { page, text, log, apiCalls, hits, ...extra };
}

export async function conditionChecks(desktop, mobile, url, shoot) {
  const out = [];
  const N = await render(desktop, url, "normal");
  if (!N.apiCalls) { await N.page.close(); return out; }
  await N.page.close();
  const R = {};
  for (const mode of ["empty", "500", "slow", "null"]) R[mode] = await render(desktop, url, mode);
  R.long = await render(mobile, url, "long");
  const LN = await render(mobile, url, "normal");
  const { empty: E, 500: F, slow: S, null: U, long: L } = R;
  const usesData = !sameLines(N.text, E.text);
  const add = async (rule, cat, msg, from) => out.push({ rule, cat, msg, shot: await shoot(from.page, rule) });

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

  for (const r of [...Object.values(R), LN]) await r.page.close();
  return out;
}
