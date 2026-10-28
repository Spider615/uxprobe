import test from "node:test";
import assert from "node:assert/strict";
import { fixture, html } from "./helpers/browser.mjs";
import * as conditions from "../src/checks/conditions.mjs";

test("condition transformations cover detail objects and preserve identifiers", () => {
  assert.equal(typeof conditions.transform, "function");
  const item = { id: 1, name: "Short English title", details: { description: "Detail" }, tags: ["hello"] };
  const nulled = conditions.transform(item, "null");
  assert.equal(nulled.id, 1); assert.equal(nulled.name, null);
  assert(conditions.transform(item, "long").name.length > item.name.length);
});

test("GraphQL read POSTs receive condition faults", async () => {
  const f = await fixture({ "/": html('<p id="result">Loading</p><a href="/">Home</a>', "fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query Items { items { name } }'})}).then(r=>{if(!r.ok)throw Error();return r.json()}).then(d=>document.getElementById('result').textContent=d.items.length?d.items[0].name:'No data').catch(()=>document.getElementById('result').textContent='No data')"), "/graphql": (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"items":[{"id":1,"name":"Example"}]}'); } });
  try {
    const findings = await conditions.conditionChecks(f.ctx, f.ctx, f.url, async () => undefined, { faultModes: [], partial: false });
    assert(findings.some((x) => x.rule === "error-as-empty"));
  } finally { await f.close(); }
});

test("partial endpoint faults expose missing read-error feedback", async () => {
  const f = await fixture({ "/": html('<p id="a">Loading</p><p id="b">Loading</p><a href="/">Home</a>', "for(const id of ['a','b'])fetch('/api/'+id).then(r=>r.json()).then(d=>document.getElementById(id).textContent=d.name??'No data').catch(()=>{})"), "/api/a": (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"name":"First"}'); }, "/api/b": (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"name":"Second"}'); } });
  try {
    const findings = await conditions.conditionChecks(f.ctx, f.ctx, f.url, async () => undefined, { faultModes: [401], partial: true });
    assert(findings.some((x) => x.rule === "read-error-silent"));
  } finally { await f.close(); }
});

test("injected authentication failure cannot clear the baseline browser session", async () => {
  const f = await fixture({ "/": html('<p id="result">Loading</p><a href="/">Home</a>', "const token=localStorage.getItem('token');if(!token)document.getElementById('result').textContent='Login';else fetch('/api').then(r=>{if(r.status===401){localStorage.removeItem('token');document.getElementById('result').textContent='Login';return null}if(!r.ok)throw Error('Failed');return r.json()}).then(d=>{if(d)document.getElementById('result').textContent=d.items.length?d.items[0].name:'No data'}).catch(()=>document.getElementById('result').textContent='Failed, retry')"), "/api": (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"items":[{"id":1,"name":"Item"}]}'); } });
  try {
    const seed = await f.ctx.newPage(); await seed.goto(f.url); await seed.evaluate(() => localStorage.setItem("token", "fixture-token")); await seed.close();
    await conditions.conditionChecks(f.ctx, f.ctx, f.url, async () => undefined, { faultModes: [401], partial: false });
    const verify = await f.ctx.newPage(); await verify.goto(f.url);
    assert.equal(await verify.evaluate(() => localStorage.getItem("token")), "fixture-token");
  } finally { await f.close(); }
});

test("fault injection preserves normal prerequisites in a multi-step state path", async () => {
  const f = await fixture({ "/": html('<button id="open" onclick="openMenu()">Menu</button><div id="menu"></div><p id="result">Ready</p>', "async function openMenu(){const r=await fetch('/menu');if(!r.ok){document.getElementById('result').textContent='Failed, retry';return}await r.json();document.getElementById('menu').innerHTML='<button id=details onclick=loadDetails()>Details</button>'}async function loadDetails(){try{const r=await fetch('/data');if(!r.ok)throw Error();const d=await r.json();document.getElementById('result').textContent=d.items.length?(d.items[0].name??'Unknown'):'No data'}catch{document.getElementById('result').textContent='Failed, retry'}}"), "/menu": (_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); }, "/data": (_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"items":[{"id":1,"name":"Item"}]}'); } });
  try {
    await assert.doesNotReject(conditions.conditionChecks(f.ctx, f.ctx, f.url, async () => undefined, { faultModes: [401], partial: false, replay: [{ selector: "#open", label: "Menu" }, { selector: "#details", label: "Details" }] }));
  } finally { await f.close(); }
});

test("each condition mode closes its browser context before resetting server state", async () => {
  let count = 0; let resets = 0;
  const f = await fixture({ "/": html('<p id="result">Loading</p>', "fetch('/api').then(r=>r.json()).then(d=>document.getElementById('result').textContent=d.items.length?(d.items[0].name??'Unknown'):'No data').catch(()=>document.getElementById('result').textContent='Failed, retry')"), "/api": (_req, res) => { count++; assert.equal(count, 1); res.setHeader("content-type", "application/json"); res.end('{"items":[{"id":1,"name":"Item"}]}'); } });
  try {
    await conditions.conditionChecks(f.ctx, f.ctx, f.url, async () => undefined, { faultModes: [], partial: false, reset: async () => { assert.equal(f.browser.contexts().length, 1); resets++; count = 0; } });
    assert(resets >= 7);
  } finally { await f.close(); }
});
