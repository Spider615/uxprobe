import { addFinding } from "../actions.mjs";

export async function mobileChecks(page, { shoot, onSkip = () => {} } = {}) {
  const out = []; const viewport = page.viewportSize();
  if (!viewport) { onSkip({ reason: "没有可调整的 viewport" }); return out; }
  const original = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  try {
    for (const size of [{ width: 320, height: 640 }, { width: 760, height: 375 }]) {
      await page.setViewportSize(size); await page.waitForTimeout(40);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) await addFinding(out, { rule: "mobile-reflow", cat: "呈现", msg: `${size.width}×${size.height} 视口下横向溢出 ${overflow}px（紧凑宽度 / 横屏检查）` }, page, shoot);
    }
    const input = page.locator('input:not([type=hidden]):visible,textarea:visible').first();
    if (await input.count()) {
      await page.setViewportSize({ width: Math.min(viewport.width, 375), height: 360 });
      await input.focus(); await page.waitForTimeout(40);
      const problems = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('input:not([type=hidden]),textarea,button,[role=button]')) {
          const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
          if (!r.width || !r.height || s.visibility === "hidden" || el.disabled) continue;
          let p = el.parentElement; let clipped = false;
          while (p && p !== document.body) {
            const q = p.getBoundingClientRect(); const ps = getComputedStyle(p);
            if (["hidden", "clip"].includes(ps.overflowY) && (r.top < q.top || r.bottom > q.bottom || r.bottom > innerHeight)) clipped = true;
            p = p.parentElement;
          }
          if (clipped || (s.position === "fixed" && (r.bottom > innerHeight || r.top < 0))) out.push((el.getAttribute("aria-label") || el.innerText || el.getAttribute("name") || el.tagName).trim().slice(0, 30));
        }
        return out;
      });
      if (problems.length) await addFinding(out, { rule: "mobile-obstructed", cat: "操作", severity: "warning", confidence: "heuristic", msg: `缩短可见高度以模拟软键盘后，「${problems.slice(0, 3).join("」「")}」被不可滚动区域裁切；需在真实手机复核` }, page, shoot);
    }
  } finally {
    await page.setViewportSize(viewport);
    await page.evaluate((p) => scrollTo(p.x, p.y), original).catch(() => {});
  }
  return out;
}
