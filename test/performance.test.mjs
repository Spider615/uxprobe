import test from "node:test";
import assert from "node:assert/strict";
import { fixture, html } from "./helpers/browser.mjs";

test("performance observers detect actual layout shifts and long tasks as lab diagnostics", async () => {
  const { installPerformance, performanceChecks } = await import("../src/checks/performance.mjs");
  const f = await fixture({ "/": html('<p>Layout shift target</p>', "setTimeout(()=>{const d=document.createElement('div');d.style.height='400px';document.querySelector('main').prepend(d);const end=performance.now()+230;while(performance.now()<end){}},150)") });
  try {
    const page = await f.ctx.newPage(); await installPerformance(page); await page.goto(f.url); await page.waitForTimeout(600);
    const findings = await performanceChecks(page, { thresholds: { cls: 0.001, longTaskMs: 100, lcpMs: 10000, interactionMs: 200 } });
    assert(findings.some((x) => x.rule === "layout-shift")); assert(findings.some((x) => x.rule === "long-task"));
    assert(findings.every((x) => x.severity === "warning"));
  } finally { await f.close(); }
});

test("healthy stable rendering does not produce performance failures", async () => {
  const { installPerformance, performanceChecks } = await import("../src/checks/performance.mjs");
  const f = await fixture({ "/": html('<button>Save</button>') });
  try {
    const page = await f.ctx.newPage(); await installPerformance(page); await page.goto(f.url); await page.waitForTimeout(200);
    assert.deepEqual(await performanceChecks(page, { thresholds: { cls: .1, longTaskMs: 1000, lcpMs: 10000, interactionMs: 1000 } }), []);
  } finally { await f.close(); }
});

test("configured interactions retain lab performance diagnostics", async () => {
  const { runScenarios } = await import("../src/scenarios.mjs");
  const f = await fixture({ "/": html('<button onclick="const end=performance.now()+260;while(performance.now()<end){};this.textContent=\'Done\'">Run</button>') });
  try {
    const findings = await runScenarios(f.ctx, f.url, [{ name: "interaction timing", steps: [{ action: "click", selector: "button" }, { action: "expect", kind: "text", selector: "button", value: "Done" }] }], { performance: { lcpMs: 10000, cls: 1, longTaskMs: 100, interactionMs: 100 } });
    assert(findings.some((f) => f.rule === "slow-interaction" || f.rule === "long-task"));
    assert(findings.every((f) => f.confidence === "diagnostic"));
  } finally { await f.close(); }
});
