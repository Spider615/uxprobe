import test from "node:test";
import assert from "node:assert/strict";
import { fixture, html } from "./helpers/browser.mjs";
import { staticChecks } from "../src/checks/static.mjs";

test("keyboard traversal detects a semantic button that cannot receive focus", async () => {
  const { keyboardChecks } = await import("../src/checks/keyboard.mjs");
  const f = await fixture({ "/": html('<button tabindex="-1">Save</button><a href="/">Home</a>') });
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url);
    assert((await keyboardChecks(page)).some((x) => x.rule === "keyboard-unreachable"));
  } finally { await f.close(); }
});

test("keyboard checks accept native controls and a native modal", async () => {
  const { keyboardChecks } = await import("../src/checks/keyboard.mjs");
  const f = await fixture({ "/": html('<button id="open" onclick="dlg.showModal()">Open</button><dialog id="dlg" aria-label="Rules"><button onclick="dlg.close()">Close</button></dialog>') });
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url);
    assert.deepEqual(await keyboardChecks(page), []);
    await page.locator("#open").click();
    assert.deepEqual(await keyboardChecks(page, { opener: "#open" }), []);
  } finally { await f.close(); }
});

test("custom modal reports missing focus entry, escape dismissal and return", async () => {
  const { keyboardChecks } = await import("../src/checks/keyboard.mjs");
  const f = await fixture({ "/": html('<button id="open" onclick="dlg.hidden=false">Open</button><div id="dlg" role="dialog" aria-modal="true" aria-label="Rules" hidden><button>Close</button></div>') });
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url); await page.locator("#open").click();
    const rules = (await keyboardChecks(page, { opener: "#open" })).map((x) => x.rule);
    assert(rules.includes("modal-focus")); assert(rules.includes("modal-escape"));
  } finally { await f.close(); }
});

test("invisible focus is reported while native focus indicators are accepted", async () => {
  const { keyboardChecks } = await import("../src/checks/keyboard.mjs");
  const f = await fixture({ "/": html('<button>Save</button>', "", '*:focus,*:focus-visible{outline:none!important;box-shadow:none!important}') });
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url);
    assert((await keyboardChecks(page)).some((x) => x.rule === "focus-invisible"));
  } finally { await f.close(); }
});

test("default accessibility checks include contrast", async () => {
  const f = await fixture({ "/": html('<a href="/">Home</a><p style="color:#eee;background:white">Unreadable text</p>') });
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url);
    assert((await staticChecks(page, "desktop")).some((x) => x.rule === "a11y:color-contrast"));
  } finally { await f.close(); }
});

test("mobile checks restore viewport and identify reduced-height modal obstruction", async () => {
  const { mobileChecks } = await import("../src/checks/mobile.mjs");
  const f = await fixture({ "/": html('<div role="dialog" aria-modal="true" aria-label="Editor" style="position:fixed;inset:0;overflow:hidden"><label>Name<input id="name"></label><button style="position:absolute;top:650px">Save</button></div>') }, { viewport: "mobile" });
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url);
    const before = page.viewportSize();
    const findings = await mobileChecks(page);
    assert(findings.some((x) => x.rule === "mobile-obstructed"));
    assert.deepEqual(page.viewportSize(), before);
  } finally { await f.close(); }
});

test("a truncated Tab traversal does not report unreached controls as inaccessible", async () => {
  const { keyboardChecks } = await import("../src/checks/keyboard.mjs");
  const f = await fixture({ "/": html('<button>Second in tab order</button><button tabindex="1">First in tab order</button>') }); const skipped = [];
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url);
    assert(!(await keyboardChecks(page, { limits: { tabStops: 1 }, onSkip: (s) => skipped.push(s) })).some((i) => i.rule === "keyboard-unreachable"));
    assert(skipped.length > 0);
  } finally { await f.close(); }
});

test("a healthy native non-modal dialog is not required to trap focus or close on Escape", async () => {
  const { keyboardChecks } = await import("../src/checks/keyboard.mjs");
  const f = await fixture({ "/": html('<button id="open" onclick="dlg.show()">Open</button><dialog id="dlg" aria-label="Information"><p>Info</p><button onclick="dlg.close()">Close</button></dialog><button>Background action</button>') });
  try {
    const page = await f.ctx.newPage(); await page.goto(f.url); await page.locator("#open").click();
    assert(!(await keyboardChecks(page)).some((i) => i.rule.startsWith("modal-")));
  } finally { await f.close(); }
});
