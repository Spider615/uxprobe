import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { validateScenarios } from "./scenarios.mjs";

// uxprobe.config.json 字段：
//   start       启动被测应用的命令（在沙箱里执行）
//   url         应用地址，可用 {port.<name>} 占位
//   env         覆盖给应用的环境变量，可用 {port.<name>} / {data.<name>} / {sandbox} 占位
//   envFile     应用从文件读配置时（.env、.dev.vars），把 env 里的覆盖项改写进沙箱里这份文件（需要 copyProject）
//   watch       只做指纹、不复制的原始路径（比如仓库里的本地数据库目录），跑前跑后必须一致
//   data        需要复制进沙箱的数据：{ 名字: 项目内或绝对路径 }。应用只会看到副本
//   copyProject 应用把状态写在仓库里时设为 true，整个仓库克隆进沙箱再启动
//   exclude     copyProject 时额外不复制的顶层目录（.git 总是排除）。node_modules 默认会复制：原生模块要跟着走，APFS 下复制几乎不占空间
//   reset       "files"（直接换数据文件）或 "restart"（停应用→换数据→再启动，默认）
//   guards      额外的只读校验命令，跑前跑后输出必须一致，例如 MySQL binlog 位置
//   pages       起始页，默认 ["/"]，从这些页面沿链接自动发现其他页面
//   login       { path, fill: { 选择器: 值 }, submit: "Enter" | 选择器 }，值可用 {env.X} 或 {envfile.X}（从原项目的 envFile 读）
//   skipClick   不点的按钮（正则），匹配按钮的可见文字、aria-label、title 拼在一起的字符串。默认 退出/登出/logout
//   readOnly    true 时不点任何按钮、不输入，只做页面检查和接口注入。数据没法复制进沙箱时（远程库、超大库）用它
//   viewports   desktop / mobile（默认二者）/ compact / landscape
//   checks      按族开关；未写的族默认开启，见 validateOptions
//   limits      控件 / 输入 / 表单 / 状态 / 深度等抽样上限；触顶写入覆盖记录
//   readFaults  额外读取故障，默认 [401,403,429,"offline","timeout"]
//   performance 本机诊断阈值 { lcpMs, cls, longTaskMs, interactionMs }
//   navigation  产品明确要求的 preserveForms / preserveScroll / dirtyWarning，默认关闭
//   scenarios   有明确预期的声明式多步工作流，完整例子见 README
//
// 配置文件查找顺序：--config 指定的 → 项目根目录 uxprobe.config.json → ~/.uxprobe/configs/<项目目录名>.json
// 沙箱和报告放在 ~/.uxprobe/<项目名>-<路径哈希>/，不放进项目目录：
// 否则项目自己的 dev server 会监听到沙箱里的文件变化，副本里的密钥文件也可能被误提交
export function loadConfig(projectDir, configFile) {
  const file = configFile ? resolve(configFile) : [join(projectDir, "uxprobe.config.json"), join(homedir(), ".uxprobe", "configs", `${basename(projectDir)}.json`)].find(existsSync);
  if (!file || !existsSync(file)) throw new Error(`没找到配置。放在 ${join(projectDir, "uxprobe.config.json")} 或 ${join(homedir(), ".uxprobe", "configs", basename(projectDir) + ".json")}，或用 --config 指定`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!raw.start || !raw.url) throw new Error("配置里必须有 start 和 url");
  const additions = validateOptions(raw);
  const abs = (p) => { p = p.replace(/^~(?=\/)/, homedir()); return isAbsolute(p) ? p : resolve(projectDir, p); };
  const data = Object.fromEntries(Object.entries(raw.data ?? {}).map(([k, p]) => [k, abs(p)]));
  return {
    projectDir, home: join(homedir(), ".uxprobe", `${basename(projectDir)}-${createHash("sha256").update(projectDir).digest("hex").slice(0, 8)}`),
    start: raw.start, url: raw.url, env: raw.env ?? {}, data, copyProject: !!raw.copyProject,
    envFile: raw.envFile ?? null, watch: (raw.watch ?? []).map(abs),
    exclude: [...new Set([".git", ".uxprobe", ...(raw.exclude ?? [])])], reset: raw.reset ?? "restart", guards: raw.guards ?? [],
    pages: raw.pages ?? ["/"], maxPages: raw.maxPages ?? 40, login: raw.login ?? null,
    skipClick: new RegExp(raw.skipClick ?? "退出|登出|注销|logout|sign ?out", "i"),
    readyTimeout: raw.readyTimeout ?? 90000, readOnly: !!raw.readOnly, configFile: file, ...additions,
  };
}

const CHECKS = ["static", "conditions", "interactions", "keyboard", "forms", "recovery", "navigation", "components", "explore", "performance", "mobile", "scenarios"];
const PROFILES = ["desktop", "mobile", "compact", "landscape"];
export function validateOptions(raw) {
  const target = new URL(raw.url.replace(/\{port\.\w+\}/g, "47100"));
  if (!["http:", "https:"].includes(target.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) throw new Error("url 必须是本机 local HTTP(S) 地址");
  const viewports = raw.viewports ?? ["desktop", "mobile"];
  if (!Array.isArray(viewports) || !viewports.length || viewports.some((v) => !PROFILES.includes(v))) throw new Error(`viewports 必须选自 ${PROFILES.join(", ")}`);
  const checks = Object.fromEntries(CHECKS.map((k) => [k, true]));
  for (const [k, v] of Object.entries(raw.checks ?? {})) {
    if (!CHECKS.includes(k) || typeof v !== "boolean") throw new Error(`无效的 checks.${k}`);
    checks[k] = v;
  }
  const limits = { controls: 25, inputs: 6, states: 8, depth: 2, forms: 4, recoveryControls: 2, tabStops: 80, scenarios: 20, navigation: 4, readEndpoints: 3 };
  for (const [k, v] of Object.entries(raw.limits ?? {})) {
    if (!(k in limits) || !Number.isInteger(v) || v < 1 || v > 500) throw new Error(`limits.${k} 必须是 1–500 的整数`);
    limits[k] = v;
  }
  if (raw.maxPages !== undefined && (!Number.isInteger(raw.maxPages) || raw.maxPages < 1 || raw.maxPages > 500)) throw new Error("maxPages 必须是 1–500 的整数");
  const performance = { lcpMs: 2500, cls: 0.1, longTaskMs: 200, interactionMs: 200, ...(raw.performance ?? {}) };
  for (const [k, v] of Object.entries(performance)) if (!["lcpMs", "cls", "longTaskMs", "interactionMs"].includes(k) || typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`无效的 performance.${k}`);
  const scenarios = raw.scenarios ?? [];
  if (!Array.isArray(scenarios) || scenarios.length > limits.scenarios) throw new Error(`scenarios 必须是数组，最多 ${limits.scenarios} 个`);
  validateScenarios(scenarios);
  const readFaults = raw.readFaults ?? [401, 403, 429, "offline", "timeout"];
  if (!Array.isArray(readFaults) || readFaults.some((f) => ![401, 403, 422, 429, 500, "offline", "timeout"].includes(f))) throw new Error("readFaults 包含不支持的故障类型");
  for (const [key, value] of Object.entries(raw.navigation ?? {})) if (!["preserveForms", "preserveScroll", "dirtyWarning"].includes(key) || typeof value !== "boolean") throw new Error(`无效的 navigation.${key}`);
  return { viewports: [...new Set(viewports)], checks, limits, performance, scenarios, navigation: raw.navigation ?? {}, readFaults };
}

export function portNames(config) {
  const names = new Set();
  for (const s of [config.url, ...Object.values(config.env), config.start]) for (const m of String(s).matchAll(/\{port\.(\w+)\}/g)) names.add(m[1]);
  return [...names];
}

export async function freePort(from) {
  for (let port = from; port < from + 500; port++) {
    const ok = await new Promise((done) => { const s = createServer().once("error", () => done(false)).once("listening", () => s.close(() => done(true))); s.listen(port, "127.0.0.1"); });
    if (ok) return port;
  }
  throw new Error(`从 ${from} 开始找不到空闲端口`);
}

export function fill(template, vars) {
  return String(template).replace(/\{(port|data|env|envfile)\.(\w+)\}|\{sandbox\}/g, (all, kind, name) => {
    if (all === "{sandbox}") return vars.sandbox;
    const v = kind === "env" ? process.env[name] : kind === "envfile" ? vars.envfile?.[name] : vars[kind]?.[name];
    if (v === undefined) throw new Error(`占位符 ${all} 没有值`);
    return String(v);
  });
}

// 读 KEY=VALUE 格式的环境文件（.env / .dev.vars），忽略注释和空行
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/); if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
