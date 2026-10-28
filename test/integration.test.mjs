import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHtml } from "../src/report.mjs";
import { loadConfig } from "../src/config.mjs";
import { run } from "../src/run.mjs";

test("report distinguishes failed checks and skips from a clean result", () => {
  const dir = mkdtempSync(join(tmpdir(), "uxprobe-report-"));
  try {
    const file = join(dir, "index.html");
    writeHtml({ project: "fixture", seconds: 1, isolation: "一致", issues: [], scannedPages: ["/", "/settings"], coverage: { summary: { checked: 2, skipped: 1, error: 1 }, records: [{ check: "keyboard", status: "error", page: "/", reason: "fixture failed" }, { check: "recovery", status: "skipped", reason: "readOnly" }] } }, file);
    const html = readFileSync(file, "utf8");
    assert(html.includes("fixture failed")); assert(html.includes("readOnly"));
    assert(html.includes("检查未完成")); assert(!html.includes('<b>没有发现问题</b>'));
    assert(html.includes("2</b><span>已扫描页面"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function appConfig(documentOverride) {
  const dir = mkdtempSync(join(tmpdir(), "uxprobe-integration-"));
  mkdirSync(join(dir, "data")); writeFileSync(join(dir, "data", "db.json"), '{"writes":0}');
  const document = documentOverride ?? '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture</title><body><main><button id="action" onclick="if(innerWidth>600){document.getElementById(\'result\').textContent=\'Done\'}">Do action</button><p id="result" role="status"></p></main></body></html>';
  writeFileSync(join(dir, "server.mjs"), `import {createServer} from 'node:http';import{readFileSync,writeFileSync}from'node:fs';
  createServer((req,res)=>{if(req.method==='POST'){const p=process.env.DB;const d=JSON.parse(readFileSync(p));d.writes++;writeFileSync(p,JSON.stringify(d));res.end('{}');return}res.setHeader('content-type','text/html');res.end(${JSON.stringify(document)})}).listen(process.env.PORT,'127.0.0.1');`);
  const raw = { start: `${process.execPath} server.mjs`, url: "http://127.0.0.1:{port.web}", data: { db: "data" }, env: { PORT: "{port.web}", DB: "{data.db}/db.json" }, pages: ["/"], viewports: ["desktop", "mobile"], checks: Object.fromEntries(["static", "conditions", "interactions", "keyboard", "forms", "recovery", "navigation", "components", "explore", "performance", "mobile"].map((k) => [k, false])), scenarios: [{ name: "works on mobile", viewports: ["mobile"], steps: [{ action: "click", selector: "#action" }, { action: "expect", kind: "text", selector: "#result", value: "Done", timeout: 100 }] }] };
  writeFileSync(join(dir, "uxprobe.config.json"), JSON.stringify(raw));
  const config = loadConfig(dir); config.home = join(dir, "output");
  // 运行产物放在项目外，否则原目录指纹必然变化。
  config.home = mkdtempSync(join(tmpdir(), "uxprobe-output-"));
  return { dir, config };
}

test("runner executes mobile workflows and preserves original data", async () => {
  const { dir, config } = appConfig();
  try {
    const { report } = await run(config, { log: () => {} });
    assert(report.issues.some((x) => x.rule === "scenario-failed" && x.viewports.includes("mobile")));
    assert.equal(readFileSync(join(dir, "data", "db.json"), "utf8"), '{"writes":0}');
    assert(report.coverage.summary.skipped > 0); assert.deepEqual(report.scannedPages, ["/"]);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(config.home, { recursive: true, force: true }); }
});

test("readOnly disables action checks and workflows with explicit coverage", async () => {
  const { dir, config } = appConfig(); config.readOnly = true;
  try {
    const { report } = await run(config, { log: () => {} });
    assert(!report.issues.some((x) => x.rule === "scenario-failed"));
    assert(report.coverage.records.some((r) => r.check === "scenarios" && r.status === "skipped" && /readOnly/.test(r.reason)));
    assert.equal(readFileSync(join(dir, "data", "db.json"), "utf8"), '{"writes":0}');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(config.home, { recursive: true, force: true }); }
});

test("default families execute real mobile interactions without a custom scenario", async () => {
  const { dir, config } = appConfig();
  config.checks = Object.fromEntries(Object.keys(config.checks).map((key) => [key, true]));
  config.scenarios = []; config.limits.states = 3; config.limits.depth = 1;
  config.performance = { cls: 1, lcpMs: 30000, longTaskMs: 10000, interactionMs: 10000 };
  try {
    const { report } = await run(config, { log: () => {} });
    assert(report.issues.some((i) => i.rule === "no-feedback" && i.viewports.includes("mobile")));
    assert.equal(report.coverage.summary.error, 0);
    for (const name of ["static", "keyboard", "mobile", "interactions", "forms", "recovery", "navigation", "components", "explore", "performance"]) assert(report.coverage.records.some((r) => r.check === name && r.status === "checked"), name);
    assert.equal(readFileSync(join(dir, "data", "db.json"), "utf8"), '{"writes":0}');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(config.home, { recursive: true, force: true }); }
});

test("the runner validates changed constraints on reused form nodes in reached states", async () => {
  const { dir, config } = appConfig('<!doctype html><html lang="en"><title>Fixture</title><body><main><button id="advanced" onclick="document.getElementById(\'form\').noValidate=true;document.getElementById(\'name\').required=true">Advanced</button><form id="form" onsubmit="event.preventDefault();fetch(\'/write\',{method:\'POST\'})"><label>Name<input id="name"></label><button>Save</button></form></main></body></html>');
  config.viewports = ["desktop"]; config.scenarios = []; config.checks.forms = true; config.checks.explore = true;
  config.limits.depth = 1; config.limits.states = 3;
  try {
    const { report } = await run(config, { log: () => {} });
    assert(report.issues.some((i) => i.rule === "invalid-accepted" && i.states.some((s) => s.includes("Advanced"))));
    assert.equal(report.coverage.summary.error, 0);
    assert.equal(readFileSync(join(dir, "data", "db.json"), "utf8"), '{"writes":0}');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(config.home, { recursive: true, force: true }); }
});
