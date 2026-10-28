import test from "node:test";
import assert from "node:assert/strict";
import { fixture, html } from "./helpers/browser.mjs";

const api = (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); };
const options = { modes: [500], targets: [{ selector: "button", label: "Save" }] };

test("declared form constraints reject invalid values before a write", async () => {
  const { formChecks } = await import("../src/checks/forms.mjs");
  const f = await fixture({ "/": html('<form id="form" novalidate><label>Email<input id="email" type="email" required></label><button>Save</button><p role="status" id="result"></p></form>', "document.getElementById('form').onsubmit=e=>{e.preventDefault();fetch('/api',{method:'POST'}).then(()=>document.getElementById('result').textContent='Saved')}") , "/api": api });
  try { assert((await formChecks(f.ctx, f.url)).some((x) => x.rule === "invalid-accepted")); }
  finally { await f.close(); }
});

test("healthy native validation does not require invented business constraints", async () => {
  const { formChecks } = await import("../src/checks/forms.mjs");
  const f = await fixture({ "/": html('<form><label>Email<input type="email" required></label><label>Optional<input></label><button>Save</button></form>') });
  try { assert.deepEqual(await formChecks(f.ctx, f.url), []); }
  finally { await f.close(); }
});

test("submission failure flags false success and lost values", async () => {
  const { recoveryChecks } = await import("../src/checks/recovery.mjs");
  const f = await fixture({ "/": html('<form id="form"><label>Name<input id="name" required></label><button>Save</button><p role="status" id="result"></p></form>', "document.getElementById('form').onsubmit=async e=>{e.preventDefault();await fetch('/api',{method:'POST'});document.getElementById('name').value='';document.getElementById('result').textContent='Saved successfully'}"), "/api": api });
  try {
    const rules = (await recoveryChecks(f.ctx, f.url, options)).map((x) => x.rule);
    assert(rules.includes("write-false-success")); assert(rules.includes("write-input-lost"));
  } finally { await f.close(); }
});

test("healthy error feedback retains values and supports retry", async () => {
  const { recoveryChecks } = await import("../src/checks/recovery.mjs");
  const f = await fixture({ "/": html('<form id="form"><label>Name<input id="name" required></label><button id="save">Save</button><p role="status" id="result"></p></form>', "document.getElementById('form').onsubmit=async e=>{e.preventDefault();const b=document.getElementById('save');b.disabled=true;try{const r=await fetch('/api',{method:'POST'});document.getElementById('result').textContent=r.ok?'Saved successfully':'Failed, retry'}catch{document.getElementById('result').textContent='Failed, retry'}finally{b.disabled=false}}"), "/api": api });
  try { assert.deepEqual(await recoveryChecks(f.ctx, f.url, { ...options, modes: [500, 401, 403, 422, 429, "offline", "timeout"] }), []); }
  finally { await f.close(); }
});

test("failed submit exposes permanently disabled retry controls", async () => {
  const { recoveryChecks } = await import("../src/checks/recovery.mjs");
  const f = await fixture({ "/": html('<form id="form"><label>Name<input required></label><button id="save">Save</button><p role="status" id="result"></p></form>', "document.getElementById('form').onsubmit=async e=>{e.preventDefault();document.getElementById('save').disabled=true;const r=await fetch('/api',{method:'POST'});document.getElementById('result').textContent=r.ok?'Saved':'Failed, retry'}"), "/api": api });
  try { assert((await recoveryChecks(f.ctx, f.url, options)).some((x) => x.rule === "write-stuck-control")); }
  finally { await f.close(); }
});

test("expanded forms receive negative validation and write-failure injection", async () => {
  const { formChecks } = await import("../src/checks/forms.mjs"); const { recoveryChecks } = await import("../src/checks/recovery.mjs");
  const f = await fixture({ "/": html('<button id="open" onclick="document.getElementById(\'editor\').hidden=false">Edit</button><section id="editor" hidden><form id="form" novalidate><label>Email<input type="email" required></label><button id="save">Save</button><p id="result" role="status"></p></form></section>', "document.getElementById('form').onsubmit=async e=>{e.preventDefault();await fetch('/api',{method:'POST'});document.getElementById('result').textContent='Saved successfully'}"), "/api": api });
  const replay = [{ selector: "#open", label: "Edit" }];
  try {
    assert((await formChecks(f.ctx, f.url, { replay })).some((i) => i.rule === "invalid-accepted"));
    assert((await recoveryChecks(f.ctx, f.url, { replay, modes: [500], targets: [{ selector: "#save", label: "Save" }] })).some((i) => i.rule === "write-false-success"));
  } finally { await f.close(); }
});

test("required checkboxes and radio groups are negatively validated", async () => {
  const { formChecks } = await import("../src/checks/forms.mjs");
  const f = await fixture({ "/": html('<form novalidate><label>Agree<input type="checkbox" required></label><label>Choice<input type="radio" name="choice" value="one" required></label><button>Save</button></form>', "document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/api',{method:'POST'})}"), "/api": api });
  try { assert((await formChecks(f.ctx, f.url)).filter((i) => i.rule === "invalid-accepted").length >= 2); }
  finally { await f.close(); }
});

test("failed submissions detect changed nonempty defaults and selection loss", async () => {
  const { recoveryChecks } = await import("../src/checks/recovery.mjs");
  const f = await fixture({ "/": html('<form><label>Name<input id="name" value="Edited value"></label><label>Sort<select id="sort"><option value="a">A</option><option value="b">B</option></select></label><button>Save</button><p role="status" id="result"></p></form>', "document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/api',{method:'POST'});document.getElementById('name').value='Default value';document.getElementById('sort').value='b';document.getElementById('result').textContent='Failed, retry'}"), "/api": api });
  try { assert((await recoveryChecks(f.ctx, f.url, options)).some((i) => i.rule === "write-input-lost")); }
  finally { await f.close(); }
});

test("prefilled edit forms are actually changed before testing reset-on-failure", async () => {
  const { recoveryChecks } = await import("../src/checks/recovery.mjs");
  const f = await fixture({ "/": html('<form><label>Name<input value="Original"></label><button>Save</button><p id="result" role="status"></p></form>', "document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/api',{method:'POST'});e.target.reset();document.getElementById('result').textContent='Failed, retry'}"), "/api": api });
  try { assert((await recoveryChecks(f.ctx, f.url, options)).some((i) => i.rule === "write-input-lost")); }
  finally { await f.close(); }
});

test("a constrained optional date cannot silently turn into an untested empty draft", async () => {
  const { recoveryChecks } = await import("../src/checks/recovery.mjs"); const skipped = [];
  const f = await fixture({ "/": html('<form><label>Date<input type="date" value="2026-11-01" min="2026-11-01" max="2026-11-01"></label><button>Save</button><p id="result" role="status"></p></form>', "document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/api',{method:'POST'});e.target.reset();document.getElementById('result').textContent='Failed, retry'}"), "/api": api });
  try {
    await recoveryChecks(f.ctx, f.url, { ...options, onSkip: (s) => skipped.push(s) });
    assert(skipped.some((s) => /非默认编辑|草稿/.test(s.reason)));
  } finally { await f.close(); }
});

test("explicit negated success feedback is treated as failure feedback", async () => {
  const { recoveryChecks } = await import("../src/checks/recovery.mjs");
  const f = await fixture({ "/": html('<form><label>Name<input required></label><button>Save</button><p id="result" role="status"></p></form>', "document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/api',{method:'POST'});document.getElementById('result').textContent=r.ok?'Saved successfully':'Not saved'}"), "/api": api });
  try { assert.deepEqual(await recoveryChecks(f.ctx, f.url, options), []); }
  finally { await f.close(); }
});
