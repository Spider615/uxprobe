import test from "node:test";
import assert from "node:assert/strict";
import { fixture, html } from "./helpers/browser.mjs";
import { componentChecks } from "../src/checks/components.mjs";

function tabs({ native = false, activation = "manual", keys = ["Enter", " "], arrows = true, vertical = false, gated = false } = {}) {
  const tag = native ? "button" : "div";
  return html(`${gated ? '<button id="show" onclick="document.getElementById(\'tabs\').hidden=false">Show views</button>' : ""}
    <div id="tabs" role="tablist" aria-label="Views"${vertical ? ' aria-orientation="vertical"' : ""}${gated ? " hidden" : ""}>
      <${tag} id="one-tab" role="tab" tabindex="0" aria-selected="true" aria-controls="one">One</${tag}>
      <${tag} id="two-tab" role="tab" tabindex="-1" aria-selected="false" aria-controls="two">Two</${tag}>
    </div>
    <section id="one" role="tabpanel">First view</section>
    <section id="two" role="tabpanel" hidden>Second view</section>`, `
    const tabs = [...document.querySelectorAll('[role=tab]')];
    const activate = (tab) => tabs.forEach((other) => {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute('aria-controls')).hidden = !selected;
    });
    tabs.forEach((tab, index) => {
      tab.onclick = () => activate(tab);
      tab.onkeydown = (event) => {
        if (${arrows} && event.key === ${JSON.stringify(vertical ? "ArrowDown" : "ArrowRight")}) {
          event.preventDefault();
          const next = tabs[(index + 1) % tabs.length];
          tabs.forEach((other) => { other.tabIndex = other === next ? 0 : -1; });
          next.focus();
          if (${JSON.stringify(activation)} === 'automatic') activate(next);
        } else if (!${native} && ${JSON.stringify(keys)}.includes(event.key)) {
          event.preventDefault();
          activate(tab);
        }
      };
    });`, '[role=tab]{display:inline-block;padding:8px;min-width:44px;cursor:pointer}');
}

test("manual mouse-only tabs report Enter and Space activation after replay", async () => {
  const f = await fixture({ "/": tabs({ keys: [], gated: true }) }); const resets = [];
  try {
    const findings = await componentChecks(f.ctx, f.url, {
      replay: [{ selector: "#show", label: "Show views" }], onlySelectors: ["#one-tab"],
      reset: async () => { assert.equal(f.browser.contexts().length, 1, "reset must wait for probe contexts to close"); resets.push(true); },
    });
    const keyboard = findings.filter((finding) => ["tab-keyboard", "keyboard-activation"].includes(finding.rule));
    assert(keyboard.some((finding) => /Enter/.test(finding.msg)), "manual tab needs an Enter activation finding");
    assert(keyboard.some((finding) => /空格|Space/.test(finding.msg)), "manual tab needs a Space activation finding");
    assert(!findings.some((finding) => finding.rule === "tab-no-switch"));
    assert.equal(resets.length, 2);
  } finally { await f.close(); }
});

for (const [keys, missing] of [[["Enter"], /空格|Space/], [[" "], /Enter/]]) {
  test(`manual tabs check ${keys[0] === "Enter" ? "Space independently of Enter" : "Enter independently of Space"}`, async () => {
    const f = await fixture({ "/": tabs({ keys }) });
    try {
      const findings = await componentChecks(f.ctx, f.url, { onlySelectors: ["#one-tab"] });
      const keyboard = findings.filter((finding) => ["tab-keyboard", "keyboard-activation"].includes(finding.rule));
      assert.equal(keyboard.length, 1);
      assert.match(keyboard[0].msg, missing);
    } finally { await f.close(); }
  });
}

test("initially selected native tabs still receive arrow keyboard checks", async () => {
  const f = await fixture({ "/": tabs({ native: true, arrows: false }) });
  try {
    const findings = await componentChecks(f.ctx, f.url, { onlySelectors: ["#one-tab"] });
    assert(findings.some((finding) => finding.rule === "tab-keyboard" && /ArrowRight/.test(finding.msg)));
  } finally { await f.close(); }
});

for (const [name, options] of [
  ["native manual activation", { native: true }],
  ["custom manual activation", { vertical: true }],
  ["automatic activation", { activation: "automatic", keys: [] }],
]) {
  test(`tabs accept healthy ${name}`, async () => {
    const f = await fixture({ "/": tabs(options) });
    try { assert.deepEqual(await componentChecks(f.ctx, f.url), []); }
    finally { await f.close(); }
  });
}
