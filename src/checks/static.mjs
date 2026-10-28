// 静态检查：页面加载完、不做任何操作时就能看出来的呈现类和操作类问题。
import AxeBuilder from "@axe-core/playwright";

// 在页面里执行。返回 [{rule, cat, msg, uxp}]，uxp 是给问题元素打的标记，用于截图圈出
function inPage({ mobile, minTarget }) {
  const out = []; let n = 0;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && !el.closest("[aria-hidden=true],[inert]"); };
  const label = (el) => (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("alt") || el.tagName.toLowerCase()).trim().replace(/\s+/g, " ").slice(0, 40);
  const mark = (el) => { if (!el.dataset.uxp) el.dataset.uxp = String(++n); return el.dataset.uxp; };
  const add = (rule, cat, msg, el) => out.push({ rule, cat, msg, uxp: el ? mark(el) : undefined });
  // 元素实际露在外面的区域：和视口、所有会裁剪它的祖先求交集
  const shownRect = (el) => {
    let r = el.getBoundingClientRect(); let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p); if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const q = p.getBoundingClientRect(); box = { l: Math.max(box.l, q.left), t: Math.max(box.t, q.top), r: Math.min(box.r, q.right), b: Math.min(box.b, q.bottom) };
    }
    box = { l: Math.max(box.l, 0), t: Math.max(box.t, 0), r: Math.min(box.r, innerWidth), b: Math.min(box.b, innerHeight) };
    return box.r - box.l >= 2 && box.b - box.t >= 2 ? box : null;
  };
  const INTERACTIVE = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[role=switch],[tabindex]:not([tabindex='-1'])";
  const all = [...document.body.querySelectorAll("*")];
  // 以小目标中心画直径 minTarget 的圆，圆里碰到别的可点元素才算挤（WCAG 2.5.8 的间距例外）
  const crowded = (el, r) => { const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = minTarget / 2;
    return [...document.querySelectorAll(INTERACTIVE)].some((o) => { if (o === el || o.contains(el) || el.contains(o) || !visible(o)) return false; const q = o.getBoundingClientRect();
      const dx = Math.max(q.left - cx, 0, cx - q.right), dy = Math.max(q.top - cy, 0, cy - q.bottom); return dx * dx + dy * dy < rad * rad; }); };

  // 呈现：页面横向溢出，找出最外层的越界元素
  const doc = document.documentElement; const W = doc.clientWidth;
  if (doc.scrollWidth > W + 1) {
    // 只取最外层的越界元素：父元素没越界、它自己越界了
    const culprits = all.filter((el) => visible(el) && el.getBoundingClientRect().right > W + 1
      && !(el.parentElement && el.parentElement !== document.body && el.parentElement.getBoundingClientRect().right > W + 1));
    add("horizontal-overflow", "呈现", `页面横向溢出 ${doc.scrollWidth - W}px${culprits[0] ? `，越界的是「${label(culprits[0])}」` : ""}`, culprits[0]);
  }
  // 呈现：文字被截断，又没有 title 或 aria-label 能看到全文
  for (const el of all) {
    if (!visible(el) || !el.innerText?.trim() || el.querySelector("p,div,li,ul,table")) continue;
    const s = getComputedStyle(el);
    if (/^(PRE|CODE|TEXTAREA|INPUT|SELECT)$/.test(el.tagName) || ["auto", "scroll"].includes(s.overflowX) || ["auto", "scroll"].includes(s.overflowY)) continue;
    const clipX = (s.textOverflow === "ellipsis" || s.overflowX === "hidden" || s.overflowX === "clip") && el.scrollWidth > el.clientWidth + 1;
    const clipY = s.webkitLineClamp && s.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 1;
    if ((clipX || clipY) && !el.closest("[title]") && !el.getAttribute("aria-label")) add("truncated", "呈现", `文字被截断且没有办法看全文：「${label(el).slice(0, 24)}…」`, el);
  }
  for (const img of document.images) if (visible(img) && img.complete && img.naturalWidth === 0) add("broken-image", "呈现", `图片加载失败：${img.getAttribute("src")}`, img);
  const leaks = [...new Set(document.body.innerText.match(/(?<![\w./:-])(undefined|NaN|null|\[object Object\])(?![\w./:-])/g) ?? [])];
  if (leaks.length) add("raw-value", "呈现", `页面上直接显示了 ${leaks.join(" / ")}`);

  const controls = all.filter((el) => el.matches(INTERACTIVE) && visible(el));
  for (const el of controls) {
    const box = shownRect(el); if (!box) continue;
    const r = el.getBoundingClientRect();
    // 操作：点击区域太小（行内文字链接除外）
    const inlineLink = el.tagName === "A" && getComputedStyle(el).display === "inline" && (el.parentElement?.innerText.trim().length ?? 0) > el.innerText.trim().length + 4;
    if (!inlineLink && !["checkbox", "radio"].includes(el.type) && (r.width < minTarget - 0.5 || r.height < minTarget - 0.5) && (mobile || crowded(el, r))) add("small-target", "操作", `「${label(el)}」点击区域 ${Math.round(r.width)}×${Math.round(r.height)}px，小于 ${minTarget}px`, el);
    // 操作：被别的元素盖住。先滚到可见位置再判断，避免把滚动容器里没露出来的项当成被盖住
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const b2 = shownRect(el); if (!b2) continue;
    const hit = document.elementFromPoint((b2.l + b2.r) / 2, (b2.t + b2.b) / 2);
    if (hit && !el.contains(hit) && !hit.contains(el) && !(el.labels && [...el.labels].some((l) => l.contains(hit))))
      add("occluded", "操作", `「${label(el)}」被「${label(hit)}」盖住，点不到`, el);
  }
  scrollTo(0, 0);
  // 操作：看起来能点（手型光标）却不是按钮或链接，键盘和读屏都用不了
  for (const el of all) {
    if (!visible(el) || getComputedStyle(el).cursor !== "pointer" || el.matches(INTERACTIVE) || el.closest(INTERACTIVE) || el.querySelector(INTERACTIVE) || /^(LABEL|OPTION)$/.test(el.tagName)) continue;
    if (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer") continue;
    if (el.innerText?.trim()) add("not-a-button", "操作", `「${label(el)}」看起来能点，但不是按钮或链接，键盘操作不了`, el);
  }
  // 流程：页面上没有任何能去别处的入口
  const here = location.pathname;
  const exits = controls.filter((el) => (el.tagName === "A" && new URL(el.href, location.href).pathname !== here) || el.matches("button,[role=button],[role=link]"));
  if (!exits.length) add("dead-end", "流程", "页面上没有任何链接或按钮，进来以后只能靠浏览器后退");
  return out;
}

// 只在悬停时才出现的操作，手机上没有悬停，等于不存在
async function hoverOnly(page) {
  const handles = await page.$$("button,a[href],[role=button]");
  const found = [];
  for (const h of handles) {
    const hidden = await h.evaluate((el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && s.display !== "none" && (Number(s.opacity) < 0.1 || s.visibility === "hidden"); }).catch(() => false);
    if (!hidden) continue;
    const parent = await h.evaluateHandle((el) => el.parentElement);
    await parent.asElement()?.hover({ force: true, timeout: 1000 }).catch(() => {});
    const shown = await h.evaluate((el) => { const s = getComputedStyle(el); return Number(s.opacity) > 0.5 && s.visibility !== "hidden"; }).catch(() => false);
    if (shown) { const uxp = await h.evaluate((el) => (el.dataset.uxp ||= "h" + Math.random().toString(36).slice(2, 6))); found.push({ rule: "hover-only", cat: "操作", msg: `「${(await h.innerText().catch(() => "")).trim() || (await h.getAttribute("aria-label")) || "按钮"}」只在鼠标悬停时出现，手机上用不了`, uxp }); }
  }
  await page.mouse.move(0, 0);
  return found;
}

export async function staticChecks(page, viewport, { axe = ["button-name", "link-name", "label", "image-alt"] } = {}) {
  const mobile = viewport === "mobile";
  const list = await page.evaluate(inPage, { mobile, minTarget: mobile ? 32 : 24 }).catch((e) => [{ rule: "probe-error", cat: "工具", msg: String(e.message).slice(0, 120) }]);
  if (mobile) list.push(...(await hoverOnly(page)));
  if (axe.length) {
    const res = await new AxeBuilder({ page }).withRules(axe).analyze().catch(() => ({ violations: [] }));
    for (const v of res.violations) list.push({ rule: `a11y:${v.id}`, cat: "理解", msg: `${v.help}（${v.nodes.length} 处，如 ${v.nodes[0].target.join(" ").slice(0, 50)}）` });
  }
  return list;
}
