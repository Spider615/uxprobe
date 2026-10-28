import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

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
//
// 配置文件查找顺序：--config 指定的 → 项目根目录 uxprobe.config.json → ~/.uxprobe/configs/<项目目录名>.json
// 沙箱和报告放在 ~/.uxprobe/<项目名>-<路径哈希>/，不放进项目目录：
// 否则项目自己的 dev server 会监听到沙箱里的文件变化，副本里的密钥文件也可能被误提交
export function loadConfig(projectDir, configFile) {
  const file = configFile ? resolve(configFile) : [join(projectDir, "uxprobe.config.json"), join(homedir(), ".uxprobe", "configs", `${basename(projectDir)}.json`)].find(existsSync);
  if (!file || !existsSync(file)) throw new Error(`没找到配置。放在 ${join(projectDir, "uxprobe.config.json")} 或 ${join(homedir(), ".uxprobe", "configs", basename(projectDir) + ".json")}，或用 --config 指定`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!raw.start || !raw.url) throw new Error("配置里必须有 start 和 url");
  const abs = (p) => { p = p.replace(/^~(?=\/)/, homedir()); return isAbsolute(p) ? p : resolve(projectDir, p); };
  const data = Object.fromEntries(Object.entries(raw.data ?? {}).map(([k, p]) => [k, abs(p)]));
  return {
    projectDir, home: join(homedir(), ".uxprobe", `${basename(projectDir)}-${createHash("sha256").update(projectDir).digest("hex").slice(0, 8)}`),
    start: raw.start, url: raw.url, env: raw.env ?? {}, data, copyProject: !!raw.copyProject,
    envFile: raw.envFile ?? null, watch: (raw.watch ?? []).map(abs),
    exclude: [...new Set([".git", ".uxprobe", ...(raw.exclude ?? [])])], reset: raw.reset ?? "restart", guards: raw.guards ?? [],
    pages: raw.pages ?? ["/"], maxPages: raw.maxPages ?? 40, login: raw.login ?? null,
    skipClick: new RegExp(raw.skipClick ?? "退出|登出|注销|logout|sign ?out", "i"),
    readyTimeout: raw.readyTimeout ?? 90000, readOnly: !!raw.readOnly, configFile: file,
  };
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
