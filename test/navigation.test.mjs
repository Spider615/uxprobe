import test from "node:test";
import assert from "node:assert/strict";
import { fixture, html } from "./helpers/browser.mjs";

test("client-side navigation that cannot be opened directly is reported", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({ "/": html('<a href="/detail" id="detail">Detail</a><p id="result">Home</p>', "document.getElementById('detail').onclick=e=>{e.preventDefault();history.pushState({},'','/detail');document.getElementById('result').textContent='Detail content'}") });
  try { assert((await navigationChecks(f.ctx, f.url)).some((x) => x.rule === "deep-link-broken")); }
  finally { await f.close(); }
});

test("ordinary query/hash navigation supports reload, back and forward", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({ "/": html('<a href="/?tab=2#details">Details</a><p>Content</p>') });
  try { assert.deepEqual(await navigationChecks(f.ctx, f.url), []); }
  finally { await f.close(); }
});

test("dirty warning checks edit a prefilled form before testing native leave protection", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({
    "/": html('<form><label>Name<input id="name" value="Original"></label></form><a href="/detail">Details</a>', `
      const name = document.getElementById('name');
      let dirty = false;
      name.addEventListener('input', () => { dirty = name.value !== name.defaultValue; });
      window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
    `),
    "/detail": html('<p>Details</p>'),
  });
  const skipped = [];
  try {
    assert.deepEqual(await navigationChecks(f.ctx, f.url, { navigation: { dirtyWarning: true }, onSkip: (item) => skipped.push(item) }), []);
    assert.deepEqual(skipped, []);
  } finally { await f.close(); }
});

test("a visible in-app leave confirmation protects edits to a prefilled form", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({
    "/": html('<form><label>Name<textarea id="name">Original</textarea></label></form><a id="detail" href="/detail">Details</a><div role="alertdialog" aria-label="Unsaved changes" id="leave" hidden><p>Leave without saving your changes?</p><button>Stay</button><button>Leave without saving</button></div>', `
      const name = document.getElementById('name');
      let dirty = false;
      name.addEventListener('input', () => { dirty = name.value !== name.defaultValue; });
      document.getElementById('detail').onclick = event => { if (dirty) { event.preventDefault(); document.getElementById('leave').hidden = false; } };
    `),
    "/detail": html('<p>Details</p>'),
  });
  const skipped = [];
  try {
    assert.deepEqual(await navigationChecks(f.ctx, f.url, { navigation: { dirtyWarning: true }, onSkip: (item) => skipped.push(item) }), []);
    assert.deepEqual(skipped, []);
  } finally { await f.close(); }
});

test("native confirm protects a changed prefilled select outside a form", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({
    "/": html('<label>Plan<select id="plan"><option value="basic" selected>Basic</option><option value="pro">Pro</option></select></label><a id="detail" href="/detail">Details</a>', `
      const plan = document.getElementById('plan');
      let dirty = false;
      plan.addEventListener('change', () => { dirty = plan.value !== 'basic'; });
      document.getElementById('detail').onclick = event => { if (dirty && !confirm('Leave without saving changes?')) event.preventDefault(); };
    `),
    "/detail": html('<p>Details</p>'),
  });
  const skipped = [];
  try {
    assert.deepEqual(await navigationChecks(f.ctx, f.url, { navigation: { dirtyWarning: true }, onSkip: (item) => skipped.push(item) }), []);
    assert.deepEqual(skipped, []);
  } finally { await f.close(); }
});

test("an edited prefilled form without leave protection is reported", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({
    "/": html('<form><label>Name<input id="name" value="Original"></label></form><a id="detail" href="/detail">Details</a><div role="dialog">Preferences</div><div role="alertdialog" hidden>Leave without saving changes? <button>Stay</button><button>Leave</button></div>', `
      document.getElementById('detail').onclick = event => {
        event.preventDefault();
        location.href = '/detail?name=' + encodeURIComponent(document.getElementById('name').value);
      };
    `),
    "/detail": html('<p>Details</p><div role="dialog">Preferences</div>'),
  });
  try {
    const findings = await navigationChecks(f.ctx, f.url, { navigation: { dirtyWarning: true } });
    assert.equal(findings.filter((item) => item.rule === "draft-leave-unprotected").length, 1);
    const leaves = f.requests.filter((request) => request.url.startsWith('/detail?name='));
    assert(leaves.length > 0);
    assert(leaves.every((request) => new URL(request.url, f.url).searchParams.get('name') !== 'Original'));
  } finally { await f.close(); }
});

test("dirty warning checks explicitly skip pages with no editable visible field", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({
    "/": html('<form><input value="Locked" readonly><input value="Disabled" disabled><input value="Hidden" hidden></form><a href="/detail">Details</a>'),
    "/detail": html('<p>Details</p>'),
  });
  const skipped = [];
  try {
    assert.deepEqual(await navigationChecks(f.ctx, f.url, { navigation: { dirtyWarning: true }, onSkip: (item) => skipped.push(item) }), []);
    assert(skipped.some((item) => /未保存|dirtyWarning/.test(item.reason)));
  } finally { await f.close(); }
});

test("dirty warning checks explicitly skip an edit reverted by the application", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({
    "/": html('<form><input id="name" value="Original"></form><a href="/detail">Details</a>', `
      const name = document.getElementById('name');
      name.addEventListener('input', () => { name.value = name.defaultValue; });
    `),
    "/detail": html('<p>Details</p>'),
  });
  const skipped = [];
  try {
    assert.deepEqual(await navigationChecks(f.ctx, f.url, { navigation: { dirtyWarning: true }, onSkip: (item) => skipped.push(item) }), []);
    assert(skipped.some((item) => /未保存|dirtyWarning/.test(item.reason)));
  } finally { await f.close(); }
});

test("navigation checks replay expanded-state links and open their target directly", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({
    "/": html('<button id="open">Edit</button><section id="editor" hidden><input id="name" value="Original"><a id="detail" href="/detail">Details</a></section>', `
      document.getElementById('open').onclick = () => { document.getElementById('editor').hidden = false; };
    `),
    "/detail": html('<p>Details</p>'),
  });
  try {
    const findings = await navigationChecks(f.ctx, f.url, { replay: [{ selector: "#open", label: "Edit" }], navigation: { dirtyWarning: true } });
    assert.equal(findings.filter((item) => item.rule === "draft-leave-unprotected").length, 1);
    assert.equal(findings.filter((item) => item.rule === "deep-link-broken").length, 0);
    assert(f.requests.some((request) => request.url === '/detail'));
  } finally { await f.close(); }
});

test("navigation checks restrict original-page links before applying the sample cap", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({
    "/": html('<a id="home" href="/home">Home</a><a id="detail" href="/detail">Details</a>'),
    "/home": html('<p>Home</p>'),
    "/detail": html('<p>Details</p>'),
  });
  try {
    assert.deepEqual(await navigationChecks(f.ctx, f.url, { onlySelectors: ["#detail"], limits: { navigation: 1 } }), []);
    assert(f.requests.some((request) => request.url === '/detail'));
    assert(!f.requests.some((request) => request.url === '/home'));
  } finally { await f.close(); }
});

test("navigation uses the replayed route for relative links and history", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const editor = '<section id="editor"><a href="detail">Details</a><a href="../">Home</a></section>';
  const f = await fixture({
    "/": html('<button id="open">Edit</button>' + editor.replace('<section id="editor">', '<section id="editor" hidden>'), `
      document.getElementById('open').onclick = () => {
        history.pushState({}, '', '/editor/');
        document.getElementById('editor').hidden = false;
      };
    `),
    "/editor/": html(editor),
    "/editor/detail": html('<p>Details</p>'),
  });
  try {
    assert.deepEqual(await navigationChecks(f.ctx, f.url, { replay: [{ selector: "#open", label: "Edit" }] }), []);
    assert(f.requests.some((request) => request.url === '/editor/detail'));
    assert(f.requests.filter((request) => request.url === '/').length >= 5, 'the relative Home link must be checked from /editor/');
  } finally { await f.close(); }
});

test("preserveForms detects checkbox state lost after back navigation", async () => {
  const { navigationChecks } = await import("../src/checks/navigation.mjs");
  const f = await fixture({ "/": html('<form><label>Remember<input id="remember" type="checkbox" required></label></form><a href="/detail">Details</a>', "addEventListener('pageshow',()=>setTimeout(()=>document.getElementById('remember').checked=false,0))"), "/detail": html('<p>Details</p>') });
  try { assert((await navigationChecks(f.ctx, f.url, { navigation: { preserveForms: true } })).some((i) => i.rule === "history-input-lost")); }
  finally { await f.close(); }
});
