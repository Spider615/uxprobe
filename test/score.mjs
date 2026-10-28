// 埋雷验收：分别对「有雷」和「雷全修好」两个版本跑一次，算检出率和误报。
//   检出：/m/<雷> 上报出了答案里的任意一条规则
//   误报：/ok/* 对照页上报了任何问题，或者修好版上还报（说明规则修好也不会变绿）
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { run } from "../src/run.mjs";

const here = new URL("./minefield/", import.meta.url).pathname;
const key = JSON.parse(readFileSync(join(here, "answer-key.json"), "utf8"));
const only = process.argv.slice(2);

async function once(fixed) {
  const config = loadConfig(here);
  // 25 个原始埋雷验证旧规则的兼容性；扩展检查在 *.test.mjs 中用独立正反例验收。
  // 可访问性结果仍计入本基准，不再从统计中排除。
  for (const name of ["keyboard", "mobile", "forms", "recovery", "navigation", "components", "explore", "performance", "scenarios"]) config.checks[name] = false;
  config.readFaults = [];
  if (fixed) config.start = "FIXED=1 " + config.start;
  if (only.length) config.pages = only;
  const before = readFileSync(join(here, "data", "db.json"), "utf8");
  const progress = process.env.UXPROBE_SCORE_PROGRESS ? (message) => console.log(`[${fixed ? "修好" : "有雷"}] ${message}`) : () => {};
  const { report } = await run(config, { log: progress, only: only.length ? only : undefined });
  if (readFileSync(join(here, "data", "db.json"), "utf8") !== before) throw new Error("原数据被改动了！");
  return report;
}

const rulesOn = (report, page) => report.issues.filter((i) => i.pages.includes(page)).map((i) => i.rule);
const bad = await once(false); const good = await once(true);
let hit = 0; const rows = [];
for (const [page, want] of Object.entries(key)) {
  if (only.length && !only.includes(page)) continue;
  const got = rulesOn(bad, page); const ok = want.some((r) => got.includes(r));
  const stillAfterFix = rulesOn(good, page).filter((r) => want.includes(r));
  if (ok) hit++;
  rows.push(`${ok ? "✓" : "✗"} ${page.padEnd(18)} 期望 ${want[0].padEnd(20)} 实际 ${[...new Set(got)].join(",") || "—"}${stillAfterFix.length ? `   修好后仍报 ${stillAfterFix.join(",")}` : ""}`);
}
const fpOk = bad.issues.flatMap((i) => i.pages.filter((p) => p.startsWith("/ok/") || p === "/").map((p) => `${p} ${i.rule} ${i.msg}`));
const fpFixed = good.issues.flatMap((i) => i.pages.map((p) => `${p} ${i.rule} ${i.msg}`));
const total = rows.length;
console.log(rows.join("\n"));
console.log(`\n检出 ${hit}/${total}（${Math.round((hit / total) * 100)}%）`);
console.log(`对照页误报 ${fpOk.length} 条${fpOk.length ? "：\n  " + fpOk.join("\n  ") : ""}`);
console.log(`修好版残留 ${fpFixed.length} 条${fpFixed.length ? "：\n  " + fpFixed.join("\n  ") : ""}`);
console.log(`用时：有雷 ${bad.seconds}s，修好 ${good.seconds}s`);
writeFileSync(new URL("./last-score.txt", import.meta.url), rows.join("\n") + `\n检出 ${hit}/${total}\n误报 ${fpOk.length}\n残留 ${fpFixed.length}\n`);
if (hit !== total || fpOk.length || fpFixed.length || bad.coverage.summary.error || good.coverage.summary.error) process.exitCode = 1;
