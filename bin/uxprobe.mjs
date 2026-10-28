#!/usr/bin/env node
// uxprobe run [项目目录] [--config 配置文件] [--page /a --page /b] [--json]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { run } from "../src/run.mjs";

const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-v") {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(`uxprobe ${version}（Node ${process.versions.node}）`); process.exit(0);
}
if (args[0] === "--node-path") { console.log(process.execPath); process.exit(0); }
if (args[0] === "--root") { console.log(new URL("..", import.meta.url).pathname.replace(/\/$/, "")); process.exit(0); }
const cmd = args[0] && !args[0].startsWith("-") ? args.shift() : "run";
const dir = resolve(args[0] && !args[0].startsWith("-") ? args.shift() : ".");
const only = []; let json = false; let configFile;
for (let i = 0; i < args.length; i++) { if (args[i] === "--page") only.push(args[++i]); if (args[i] === "--json") json = true; if (args[i] === "--config") configFile = args[++i]; }

if (cmd !== "run") { console.error(`未知命令 ${cmd}。用法：uxprobe run [项目目录] [--config 文件] [--page /path] [--json]`); process.exit(2); }
try {
  const config = loadConfig(dir, configFile);
  const { report, outDir } = await run(config, { only: only.length ? only : undefined, log: json ? () => {} : console.log });
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`\n${report.issues.length} 个问题，用时 ${report.seconds}s。${report.isolation}`);
    for (const i of report.issues) console.log(`- [${i.cat}] ${i.rule}  ${i.msg}  (${i.pages.length} 页: ${i.pages.slice(0, 3).join(", ")}${i.pages.length > 3 ? "…" : ""})`);
    console.log(`\n报告：${outDir}/index.html\n数据：${outDir}/report.json`);
    console.log(`覆盖：已完成 ${report.coverage.summary.checked}，跳过 ${report.coverage.summary.skipped}，检查失败 ${report.coverage.summary.error}`);
  }
  process.exit(report.coverage.summary.error ? 2 : report.issues.length ? 1 : 0);
} catch (e) {
  console.error(e.code === "ISOLATION" ? `\n隔离校验失败：${e.message}` : `\n运行失败：${e.message}`);
  process.exit(e.code === "ISOLATION" ? 3 : 2);
}
