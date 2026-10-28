import test from "node:test";
import assert from "node:assert/strict";
import { fixture, html } from "./helpers/browser.mjs";

test("workflow configuration rejects unknown actions and external entry points", async () => {
  const { validateScenarios } = await import("../src/scenarios.mjs");
  assert.throws(() => validateScenarios([{ name: "bad", steps: [{ action: "evaluate", code: "anything" }] }]), /action|动作/);
  assert.throws(() => validateScenarios([{ name: "bad", start: "https://example.com", steps: [{ action: "reload" }] }]), /本机|路径|start/);
  assert.throws(() => validateScenarios([{ name: "bad", steps: [{ action: "upload", selector: "input", file: { name: "x", size: 1e10 } }] }]), /size|大小/);
});

test("workflow assertions test pagination, upload rejection and download contents", async () => {
  const { runScenarios } = await import("../src/scenarios.mjs");
  const f = await fixture({ "/": html('<p id="page">Page 1</p><button id="next" onclick="p.textContent=\'Page 2\'">Next</button><label>File<input type="file" id="file"></label><p role="status" id="status"></p><a href="/file" download="test.txt">Download</a>', "const p=document.getElementById('page');file.onchange=()=>document.getElementById('status').textContent='Rejected type'") , "/file": (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("fixture"); } });
  try {
    const findings = await runScenarios(f.ctx, f.url, [{ name: "files and pagination", steps: [
      { action: "click", selector: "#next" }, { action: "expect", kind: "text", selector: "#page", value: "Page 2" },
      { action: "upload", selector: "#file", file: { name: "bad.exe", mimeType: "application/octet-stream", text: "test" } },
      { action: "expect", kind: "text", selector: "#status", value: "Rejected type" },
      { action: "click", selector: "a" }, { action: "expect", kind: "download", filename: "test.txt", minBytes: 1 },
    ] }]);
    assert.deepEqual(findings, []);
  } finally { await f.close(); }
});

test("failed workflow assertions and skipped actions cannot look like a clean check", async () => {
  const { runScenarios } = await import("../src/scenarios.mjs");
  const f = await fixture({ "/": html('<button>Logout</button>') }); const skipped = [];
  try {
    const findings = await runScenarios(f.ctx, f.url, [{ name: "missing state", steps: [{ action: "expect", kind: "visible", selector: "#missing", timeout: 100 }] }]);
    assert.equal(findings[0].rule, "scenario-failed");
    await runScenarios(f.ctx, f.url, [{ name: "logout", steps: [{ action: "click", selector: "button" }] }], { skip: /logout/i, onSkip: (x) => skipped.push(x) });
    assert(skipped.some((x) => /skipClick/.test(x.reason)));
    await runScenarios(f.ctx, f.url, [{ name: "readonly", steps: [{ action: "click", selector: "button" }] }], { readOnly: true, onSkip: (x) => skipped.push(x) });
    assert(skipped.some((x) => /readOnly/.test(x.reason)));
  } finally { await f.close(); }
});

test("state exploration reaches nested UI states and checks each reached state", async () => {
  const { exploreStates } = await import("../src/explore.mjs");
  const f = await fixture({ "/": html('<button id="menu" onclick="panel.hidden=false">Menu</button><section id="panel" hidden><button id="nested" onclick="document.getElementById(\'result\').hidden=false">Details</button></section><p id="result" hidden>Reached nested state</p>') });
  try {
    const seen = [];
    await exploreStates(f.ctx, f.url, { limits: { depth: 2, states: 8, controls: 8 }, onState: async (page) => { seen.push(await page.locator("#result").isVisible()); return []; } });
    assert(seen.includes(true));
  } finally { await f.close(); }
});

test("component checks flag broken ARIA tabs and ignore functional native selections", async () => {
  const { componentChecks } = await import("../src/checks/components.mjs");
  const f = await fixture({ "/": html('<div role="tablist" aria-label="View"><button role="tab" aria-selected="true" aria-controls="p1">One</button><button role="tab" aria-selected="false" aria-controls="p2">Two</button></div><section id="p1" role="tabpanel">First</section><section id="p2" role="tabpanel" hidden>Second</section>') });
  try {
    assert((await componentChecks(f.ctx, f.url)).some((x) => x.rule === "tab-no-switch"));
  } finally { await f.close(); }
});

test("ARIA switches with mouse-only activation fail keyboard operation", async () => {
  const { componentChecks } = await import("../src/checks/components.mjs");
  const f = await fixture({ "/": html('<div role="switch" tabindex="0" aria-checked="false" onclick="this.setAttribute(\'aria-checked\',String(this.getAttribute(\'aria-checked\')!==\'true\'))">Switch</div>') });
  try { assert((await componentChecks(f.ctx, f.url)).some((i) => i.rule === "keyboard-activation")); }
  finally { await f.close(); }
});

test("unexpected exploration-check exceptions become probe errors", async () => {
  const { exploreStates } = await import("../src/explore.mjs");
  const f = await fixture({ "/": html('<button onclick="this.textContent=\'Changed\'">Open</button>') });
  try {
    const result = await exploreStates(f.ctx, f.url, { onState: async () => { throw new Error("fixture checker error"); } });
    assert(result.some((i) => i.rule === "probe-error"));
  } finally { await f.close(); }
});

test("post-state behavior checks run after the original context is closed and reset", async () => {
  const { exploreStates } = await import("../src/explore.mjs"); let sourceContext; let postChecked = false; let dirty = false;
  const f = await fixture({ "/": html('<button onclick="document.getElementById(\'child\').hidden=false">Open</button><button id="child" hidden>Child</button>') });
  try {
    await exploreStates(f.ctx, f.url, { limits: { depth: 1, states: 3 }, reset: async () => { dirty = false; }, onState: async (page) => { sourceContext = page.context(); dirty = true; return []; }, afterState: async () => { assert.equal(sourceContext.pages().length, 0); assert.equal(dirty, false); postChecked = true; return []; } });
    assert.equal(postChecked, true);
  } finally { await f.close(); }
});
