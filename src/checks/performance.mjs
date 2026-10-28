// 只输出本次实验室采样，不把短时自动化采样称为真实用户 INP。
export async function installPerformance(page) {
  await page.addInitScript(() => {
    window.__uxPerformance = { lcp: 0, shifts: [], longTasks: [], interactions: [], supported: [] };
    const record = window.__uxPerformance;
    for (const type of ["largest-contentful-paint", "layout-shift", "longtask", "event"]) {
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) continue;
      record.supported.push(type);
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (type === "largest-contentful-paint") record.lcp = entry.startTime;
          else if (type === "layout-shift" && !entry.hadRecentInput) record.shifts.push({ value: entry.value, time: entry.startTime });
          else if (type === "longtask") record.longTasks.push(entry.duration);
          else if (type === "event" && entry.interactionId) record.interactions.push(entry.duration);
        }
      });
      observer.observe({ type, buffered: true, ...(type === "event" ? { durationThreshold: 16 } : {}) });
    }
  });
}

export async function performanceChecks(page, { thresholds = {}, onSkip = () => {} } = {}) {
  const limits = { lcpMs: 2500, cls: .1, longTaskMs: 200, interactionMs: 200, ...thresholds };
  const metrics = await page.evaluate(() => window.__uxPerformance);
  if (!metrics) { onSkip({ reason: "性能观察器没有在导航前安装" }); return []; }
  for (const type of ["largest-contentful-paint", "layout-shift", "longtask", "event"]) if (!metrics.supported.includes(type)) onSkip({ reason: `浏览器不支持性能观察项 ${type}` });
  let cls = 0; let windowSum = 0; let first = 0; let last = 0;
  for (const shift of metrics.shifts) {
    if (shift.time - last > 1000 || shift.time - first > 5000) { first = shift.time; windowSum = 0; }
    windowSum += shift.value; last = shift.time; cls = Math.max(cls, windowSum);
  }
  const out = []; const add = (rule, msg) => out.push({ rule, cat: "性能", severity: "warning", confidence: "diagnostic", msg: `${msg}（本机实验室采样，需结合真实设备 / 用户数据复核）` });
  if (metrics.lcp > limits.lcpMs) add("slow-lcp", `主要内容 ${Math.round(metrics.lcp)}ms 才呈现，超过 ${limits.lcpMs}ms`);
  if (cls > limits.cls) add("layout-shift", `加载期间布局偏移 ${cls.toFixed(3)}，超过 ${limits.cls}，可能导致内容跳动和误点`);
  const longest = Math.max(0, ...metrics.longTasks);
  if (longest > limits.longTaskMs) add("long-task", `主线程最长阻塞 ${Math.round(longest)}ms，超过 ${limits.longTaskMs}ms`);
  const interaction = Math.max(0, ...metrics.interactions);
  if (interaction > limits.interactionMs) add("slow-interaction", `已采样操作的响应时长 ${Math.round(interaction)}ms，超过 ${limits.interactionMs}ms`);
  return out;
}
