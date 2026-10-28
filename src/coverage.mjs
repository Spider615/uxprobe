// “没有发现问题”和“没有完成检查”必须是两种不同结果。
export function createCoverage() {
  const records = [];
  return {
    records,
    skip(check, details = {}) { records.push({ check, status: "skipped", ...details }); },
    async run(check, details, fn) {
      try {
        const findings = await fn();
        const errors = findings.filter((f) => f.rule === "probe-error");
        records.push({ check, ...details, status: errors.length ? "error" : "checked", ...(errors.length ? { reason: errors.map((f) => f.msg).join("; ") } : {}) });
        return findings;
      } catch (e) {
        if (e.code === "ISOLATION") throw e;
        records.push({ check, ...details, status: "error", reason: e.message });
        return [{ rule: "probe-error", cat: "工具", severity: "warning", msg: `${check} 检查未完成：${e.message}` }];
      }
    },
    summary() {
      const counts = { checked: 0, skipped: 0, error: 0 };
      for (const r of records) counts[r.status]++;
      return counts;
    },
  };
}
