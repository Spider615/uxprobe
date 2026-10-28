import test from "node:test";
import assert from "node:assert/strict";
import { fixture, html } from "./helpers/browser.mjs";
import { newContext } from "../src/browser.mjs";
import { openProbe } from "../src/actions.mjs";
import { staticChecks } from "../src/checks/static.mjs";
import { runScenarios, validateScenarios } from "../src/scenarios.mjs";
import { componentChecks } from "../src/checks/components.mjs";
import { interactionChecks } from "../src/checks/interactions.mjs";

test("a failed axe analysis is a probe error rather than an empty result", async () => {
  const f = await fixture({ "/": html('<a href="/">Home</a>') });
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url);
    assert((await staticChecks(page, "desktop", { axe: ["invalid-rule-name"] })).some((i) => i.rule === "probe-error"));
  } finally { await f.close(); }
});

test("read-only browser contexts block native write requests", async () => {
  const f = await fixture({ "/": html('<p>Read only</p>', "fetch('/api',{method:'POST'}).catch(()=>{})"), "/api": (_req, res) => res.end("written") });
  try {
    const ctx = await newContext(f.browser, "desktop", undefined, { readOnly: true });
    const page = await ctx.newPage(); await page.goto(f.url); await page.waitForTimeout(100);
    assert(!f.requests.some((r) => r.method === "POST")); await ctx.close();
  } finally { await f.close(); }
});

test("independent probes do not share mutated browser storage", async () => {
  const f = await fixture({ "/": html('<button onclick="localStorage.setItem(\'value\',\'changed\')">Save locally</button>') });
  try {
    const one = await openProbe(f.ctx, f.url); await one.page.locator("button").click(); await one.close();
    const two = await openProbe(f.ctx, f.url);
    assert.equal(await two.page.evaluate(() => localStorage.getItem("value")), null); await two.close();
  } finally { await f.close(); }
});

test("functional tabs, switches and native selects are healthy controls", async () => {
  const f = await fixture({ "/": html('<div role="tablist" aria-label="Views"><button role="tab" aria-selected="true" aria-controls="one">One</button><button id="two-tab" role="tab" aria-selected="false" aria-controls="two">Two</button></div><section id="one" role="tabpanel">One</section><section id="two" role="tabpanel" hidden>Two</section><button role="switch" aria-checked="false" onclick="this.setAttribute(\'aria-checked\',String(this.getAttribute(\'aria-checked\')!==\'true\'))">Notifications</button><label>Sort<select><option value="a">A</option><option value="b">B</option></select></label>', "const tabs=[...document.querySelectorAll('[role=tab]')];tabs.forEach((tab,i)=>{tab.onclick=()=>{tabs.forEach(t=>{const selected=t===tab;t.setAttribute('aria-selected',String(selected));document.getElementById(t.getAttribute('aria-controls')).hidden=!selected})};tab.onkeydown=e=>{if(e.key==='ArrowRight'){e.preventDefault();tabs[(i+1)%tabs.length].focus()}}})") });
  try { assert.deepEqual(await componentChecks(f.ctx, f.url), []); }
  finally { await f.close(); }
});

test("empty downloaded files are reported", async () => {
  const f = await fixture({ "/": html('<a href="/empty" download="empty.txt">Download</a>'), "/empty": (_req, res) => { res.setHeader("content-type", "text/plain"); res.end(""); } });
  try { assert((await componentChecks(f.ctx, f.url)).some((i) => i.rule === "download-empty")); }
  finally { await f.close(); }
});

test("configured upload failures can be retried after clearing a fault", async () => {
  const f = await fixture({ "/": html('<label>File<input id="file" type="file"></label><button id="retry" onclick="upload()">Retry upload</button><p id="result" role="status"></p>', "async function upload(){try{const r=await fetch('/upload',{method:'POST',body:document.getElementById('file').files[0]});document.getElementById('result').textContent=r.ok?'Upload complete':'Upload failed'}catch{document.getElementById('result').textContent='Upload failed'}}document.getElementById('file').onchange=upload;"), "/upload": (_req, res) => res.end("ok") });
  try {
    assert.deepEqual(await runScenarios(f.ctx, f.url, [{ name: "upload retry", steps: [
      { action: "fault", match: "/upload", method: "POST", mode: "offline" },
      { action: "upload", selector: "#file", file: { name: "large.txt", size: 1024, mimeType: "text/plain" } },
      { action: "expect", kind: "text", selector: "#result", value: "Upload failed" },
      { action: "clearFaults" }, { action: "click", selector: "#retry" },
      { action: "expect", kind: "text", selector: "#result", value: "Upload complete" },
    ] }]), []);
  } finally { await f.close(); }
});

test("configured scrolling verifies infinite-list growth", async () => {
  const f = await fixture({ "/": html('<div class="row">First</div>', "addEventListener('scroll',()=>{if(scrollY>100&&!document.getElementById('more')){const e=document.createElement('div');e.id='more';e.className='row';e.textContent='Second';document.querySelector('main').append(e)}})", "body{min-height:2000px}") });
  try {
    assert.deepEqual(await runScenarios(f.ctx, f.url, [{ name: "infinite scroll", steps: [{ action: "scroll", y: 600 }, { action: "expect", kind: "count", selector: ".row", value: 2 }] }]), []);
  } finally { await f.close(); }
});

test("dynamic feedback without live semantics is reported", async () => {
  const f = await fixture({ "/": html('<button onclick="document.getElementById(\'result\').textContent=\'Saved successfully\'">Save</button><p id="result"></p>') });
  try { assert((await interactionChecks(f.ctx, f.url)).some((i) => i.rule === "live-status-missing")); }
  finally { await f.close(); }
});

test("status changes conveyed only by color are reported", async () => {
  const f = await fixture({ "/": html('<button onclick="document.getElementById(\'result\').style.backgroundColor=\'red\'">Check</button><span id="result" role="status" style="display:block;width:24px;height:24px;background:green"></span>') });
  try { assert((await interactionChecks(f.ctx, f.url)).some((i) => i.rule === "color-only-status")); }
  finally { await f.close(); }
});

test("custom ARIA buttons that respond only to a mouse are reported", async () => {
  const f = await fixture({ "/": html('<div role="button" tabindex="0" onclick="document.getElementById(\'result\').textContent=\'Opened\'">Open</div><p id="result"></p>') });
  try { assert((await componentChecks(f.ctx, f.url)).some((i) => i.rule === "keyboard-activation")); }
  finally { await f.close(); }
});

test("invalid workflow step shapes fail validation before a browser opens", () => {
  assert.throws(() => validateScenarios([{ name: "bad key", steps: [{ action: "press" }] }]), /key/);
  assert.throws(() => validateScenarios([{ name: "bad count", steps: [{ action: "expect", kind: "count", selector: "p", value: -1 }] }]), /count|value/);
});

test("unfinished downloads have a bounded wait", async () => {
  const { completedDownload } = await import("../src/actions.mjs");
  const f = await fixture({ "/": html('<a href="/slow" download="slow.txt">Download</a>'), "/slow": (_req, res) => { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="slow.txt"' }); res.write(Buffer.alloc(65536, 120)); setTimeout(() => res.end("last"), 500); } });
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url);
    const pending = page.waitForEvent("download"); await page.locator("a").click();
    const result = await completedDownload(await pending, 50);
    assert.match(result.failure, /超时/);
  } finally { await f.close(); }
});

test("popup writes are tracked on the whole isolated context", async () => {
  const f = await fixture({ "/": html('<button onclick="window.open(\'/popup\')">Popup</button>'), "/popup": html('<p>Popup</p>', "fetch('/write',{method:'POST'})"), "/write": (_req, res) => res.end("ok") });
  let dirty = 0;
  try {
    const probe = await openProbe(f.ctx, f.url, { markDirty: () => dirty++ });
    const popup = probe.page.waitForEvent("popup"); await probe.page.locator("button").click();
    await (await popup).waitForLoadState("networkidle");
    assert(dirty > 0); await probe.close();
  } finally { await f.close(); }
});

test("selector-free Enter still respects skipClick on the focused control", async () => {
  const f = await fixture({ "/": html('<button id="logout" autofocus onclick="document.body.dataset.loggedOut=\'yes\'">Logout</button>') }); const skipped = [];
  try {
    await runScenarios(f.ctx, f.url, [{ name: "keyboard skip", steps: [{ action: "press", key: "Enter" }] }], { skip: /logout/i, onSkip: (s) => skipped.push(s) });
    assert(skipped.some((s) => /skipClick/.test(s.reason)));
  } finally { await f.close(); }
});

test("missing controls cannot satisfy unchecked or empty-text assertions", async () => {
  const f = await fixture({ "/": html('<p>Content</p>') });
  try {
    for (const expectation of [{ kind: "checked", value: false }, { kind: "text", value: "" }]) {
      const result = await runScenarios(f.ctx, f.url, [{ name: "missing control", steps: [{ action: "expect", selector: "#missing", timeout: 100, ...expectation }] }]);
      assert(result.some((i) => i.rule === "scenario-failed"));
    }
  } finally { await f.close(); }
});

test("form negatives respect a blocked native submit input value", async () => {
  const { formChecks } = await import("../src/checks/forms.mjs");
  const f = await fixture({ "/": html('<form novalidate><label>Name<input required></label><input type="submit" value="Logout"></form>', "document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/write',{method:'POST'})}"), "/write": (_req, res) => res.end("ok") });
  const skipped = [];
  try {
    await formChecks(f.ctx, f.url, { onSkip: (s) => skipped.push(s) });
    assert(!f.requests.some((r) => r.method === "POST"));
    assert(skipped.some((s) => /skipClick/.test(s.reason)));
  } finally { await f.close(); }
});
