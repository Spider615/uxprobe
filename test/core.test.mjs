import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as browser from "../src/browser.mjs";
import { discover, template } from "../src/discover.mjs";
import { loadConfig } from "../src/config.mjs";

const request = (method, body, url = "http://127.0.0.1/api") => ({
  method: () => method, resourceType: () => "fetch", url: () => url,
  postData: () => body ? JSON.stringify(body) : null,
});

test("GraphQL read POSTs can be perturbed without treating them as writes", () => {
  assert.equal(typeof browser.isRead, "function");
  assert.equal(browser.isRead(request("POST", { query: "query Items { items { id } }" })), true);
  assert.equal(browser.isWrite(request("POST", { query: "{ items { id } }" })), false);
  assert.equal(browser.isWrite(request("POST", { query: "mutation Create { createItem { id } }" })), true);
  assert.equal(browser.isWrite(request("POST", { title: "test" })), true);
  assert.equal(browser.isRead(request("GET", null, "https://example.com/api")), false);
  assert.equal(browser.isRead(request("POST", { query: "query Read { items { id } } mutation Write { remove }", operationName: "Write" })), false);
  assert.equal(browser.isRead(request("POST", [{ query: "{ items { id } }" }, { query: "mutation Write { remove }" }])), false);
  const stream = request("GET"); stream.headers = () => ({ accept: "text/event-stream" });
  assert.equal(browser.isRead(stream), false);
  assert.equal(browser.isRead(request("POST", { query: 'query Read { items { id } }\n# "\nmutation Write { remove }\n# "', operationName: "Write" })), false);
  assert.equal(browser.isRead(request("POST", { query: "query Read { items { id } }\n# comment\rmutation Write { remove }", operationName: "Write" })), false);
});

test("discovery retains query and hash states and reports broken linked pages", async () => {
  let current; const skipped = [];
  const base = "http://127.0.0.1:1234";
  const routes = {
    "/": { links: ["/?tab=one", "/?tab=two", "/#/settings", "/missing", "https://example.com/", "/item/1", "/item/2"] },
    "/?tab=one": {}, "/?tab=two": {}, "/#/settings": {}, "/missing": { status: 404 },
    "/item/1": {}, "/item/2": {},
  };
  const page = {
    goto: async (url) => { current = new URL(url); return { status: () => (routes[current.pathname + current.search + current.hash]?.status ?? 200) }; },
    url: () => current.href, waitForLoadState: async () => {}, waitForTimeout: async () => {},
    evaluate: async () => (routes[current.pathname + current.search + current.hash]?.links ?? []).map((p) => new URL(p, base).href),
    close: async () => {},
  };
  const paths = await discover({ newPage: async () => page }, base, ["/"], 20, { onSkip: (r) => skipped.push(r) });
  assert(paths.includes("/?tab=one")); assert(paths.includes("/?tab=two")); assert(paths.includes("/#/settings"));
  assert(paths.includes("/missing")); assert.equal(paths.filter((p) => p.startsWith("/item/")).length, 1);
  assert.equal(template("/item/123?tab=2#/part"), "/item/:id?tab=2#/part");
});

test("configuration validates limits and supports explicit checks and viewport profiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "uxprobe-config-"));
  try {
    const file = join(dir, "uxprobe.config.json");
    writeFileSync(file, JSON.stringify({ start: "node server.mjs", url: "http://127.0.0.1:{port.web}", limits: { states: 0 } }));
    assert.throws(() => loadConfig(dir), /states|limits/);
    writeFileSync(file, JSON.stringify({ start: "node server.mjs", url: "http://127.0.0.1:{port.web}", viewports: ["mobile", "compact"], checks: { recovery: false } }));
    const config = loadConfig(dir);
    assert.deepEqual(config.viewports, ["mobile", "compact"]); assert.equal(config.checks.recovery, false);
    assert(config.limits.depth > 0); assert(Array.isArray(config.scenarios));
    writeFileSync(file, JSON.stringify({ start: "node server.mjs", url: "https://example.com" }));
    assert.throws(() => loadConfig(dir), /本机|local/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coverage distinguishes errors, skips, and successful checks", async () => {
  const { createCoverage } = await import("../src/coverage.mjs");
  const coverage = createCoverage();
  assert.deepEqual(await coverage.run("static", { page: "/", vp: "desktop" }, async () => []), []);
  const findings = await coverage.run("keyboard", { page: "/" }, async () => { throw new Error("fixture failed"); });
  assert.equal(findings[0].rule, "probe-error");
  coverage.skip("recovery", { page: "/", reason: "readOnly" });
  assert.deepEqual(coverage.summary(), { checked: 1, skipped: 1, error: 1 });
  await assert.rejects(coverage.run("sandbox", {}, async () => { const e = new Error("leak"); e.code = "ISOLATION"; throw e; }), /leak/);
});
