// 沙箱：应用只连数据副本，原数据从头到尾不被打开。
// 跑前跑后给原数据做指纹，任何变化都立即中止并报警。
import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fill, freePort, parseEnvFile, portNames } from "./config.mjs";

function clone(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  if (process.platform === "darwin") {
    // APFS 写时复制：秒级完成、不额外占空间
    try { execSync(`cp -c -R ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { stdio: "ignore" }); return; } catch {}
  }
  cpSync(src, dest, { recursive: true, preserveTimestamps: true });
}

function fingerprint(path) {
  const h = createHash("sha256");
  if (!existsSync(path)) return "missing";
  const walk = (p) => {
    const s = statSync(p);
    if (s.isDirectory()) { for (const n of readdirSync(p).sort()) walk(join(p, n)); return; }
    h.update(`${p}\0${s.size}\0${s.mtimeMs}\n`);
  };
  walk(path);
  return h.digest("hex").slice(0, 16);
}

export class Sandbox {
  constructor(config, log = console.log) {
    this.config = config; this.log = log;
    this.root = join(config.home, "sandbox");
    this.child = null; this.dirty = false;
  }

  originals() {
    const out = Object.entries(this.config.data).map(([name, p]) => [`data:${name}`, fingerprint(p)]);
    for (const p of this.config.watch) out.push([`watch:${p}`, fingerprint(p)]);
    for (const g of this.config.guards) {
      let v; try { v = execSync(g.cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim(); } catch (e) { v = `ERROR ${e.status}`; }
      out.push([`guard:${g.name}`, v]);
    }
    return Object.fromEntries(out);
  }

  verify(stage) {
    const now = this.originals();
    const changed = Object.keys(this.before).filter((k) => this.before[k] !== now[k]);
    if (changed.length) {
      const err = new Error(`原数据在测试期间发生了变化（${stage}）：${changed.join("、")}。可能是你自己正在用的服务写入了，也可能是隔离失效，已中止`);
      err.code = "ISOLATION"; throw err;
    }
  }

  async prepare() {
    this.before = this.originals();
    mkdirSync(this.root, { recursive: true });
    this.pristine = join(this.root, "pristine"); this.work = join(this.root, "work");
    rmSync(this.pristine, { recursive: true, force: true }); mkdirSync(this.pristine, { recursive: true });
    for (const [name, p] of Object.entries(this.config.data)) {
      if (!existsSync(p)) throw new Error(`数据路径不存在：${name} → ${p}`);
      clone(p, join(this.pristine, name));
    }
    if (this.config.copyProject) {
      this.appDir = join(this.root, "app"); rmSync(this.appDir, { recursive: true, force: true }); mkdirSync(this.appDir);
      for (const n of readdirSync(this.config.projectDir)) {
        if (n === ".uxprobe" || this.config.exclude.includes(n)) continue;
        clone(join(this.config.projectDir, n), join(this.appDir, n));
      }
    } else this.appDir = this.config.projectDir;
    // 仓库里的数据（比如 .wrangler/state）：重置时直接换掉应用副本里的那一份
    this.inApp = Object.fromEntries(Object.entries(this.config.data).flatMap(([name, p]) => {
      const rel = relative(this.config.projectDir, p);
      return this.config.copyProject && !rel.startsWith("..") ? [[name, join(this.appDir, rel)]] : [];
    }));
    this.resetData();
    this.ports = {}; let next = 47100;
    for (const name of portNames(this.config)) { this.ports[name] = await freePort(next); next = this.ports[name] + 1; }
    const envSrc = this.config.envFile && join(this.config.projectDir, this.config.envFile);
    this.vars = { port: this.ports, data: Object.fromEntries(Object.keys(this.config.data).map((n) => [n, join(this.work, n)])), sandbox: this.root,
      envfile: envSrc && existsSync(envSrc) ? parseEnvFile(readFileSync(envSrc, "utf8")) : {} };
    if (this.config.envFile) {
      if (!this.config.copyProject) throw new Error("envFile 需要 copyProject: true，不能改写原项目里的配置文件");
      // 原文件里被覆盖的键整行删掉，覆盖项追加到末尾
      const target = join(this.appDir, this.config.envFile);
      const keys = new Set(Object.keys(this.config.env));
      const kept = existsSync(target) ? readFileSync(target, "utf8").split(/\r?\n/).filter((l) => { const m = l.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/); return !(m && keys.has(m[1])); }) : [];
      const added = Object.entries(this.config.env).map(([k, v]) => `${k}=${fill(v, this.vars)}`);
      writeFileSync(target, [...kept, "# --- uxprobe sandbox overrides ---", ...added, ""].join("\n"));
    }
    this.url = fill(this.config.url, this.vars).replace(/\/$/, "");
  }

  resetData() {
    rmSync(this.work, { recursive: true, force: true }); mkdirSync(this.work, { recursive: true });
    for (const name of Object.keys(this.config.data)) clone(join(this.pristine, name), join(this.work, name));
    for (const [name, target] of Object.entries(this.inApp)) clone(join(this.pristine, name), target);
    this.dirty = false;
  }

  async start() {
    const env = { ...process.env };
    for (const [k, v] of Object.entries(this.config.env)) env[k] = fill(v, this.vars);
    this.output = "";
    this.child = spawn(fill(this.config.start, this.vars), { cwd: this.appDir, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const s of [this.child.stdout, this.child.stderr]) s.on("data", (d) => { this.output = (this.output + d).slice(-4000); });
    const exited = new Promise((r) => this.child.once("exit", (code) => r(code)));
    const deadline = Date.now() + this.config.readyTimeout;
    while (Date.now() < deadline) {
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 500))]);
      if (code !== undefined) throw new Error(`应用启动后退出了（code ${code}）：\n${this.output.slice(-1500)}`);
      try { const r = await fetch(this.url + "/", { redirect: "manual" }); if (r.status < 500) return; } catch {}
    }
    throw new Error(`应用 ${this.config.readyTimeout / 1000}s 内没有响应 ${this.url}：\n${this.output.slice(-1500)}`);
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    const exited = new Promise((r) => this.child.once("exit", r));
    try { process.kill(-this.child.pid, "SIGTERM"); } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    try { process.kill(-this.child.pid, "SIGKILL"); } catch {}
    this.child = null;
  }

  // 有写操作之后才重置；重置前后都核对原数据
  async reset() {
    if (!this.dirty) return;
    this.verify("重置前");
    if (this.config.reset === "files") this.resetData();
    else { await this.stop(); this.resetData(); await this.start(); }
  }

  async dispose() {
    await this.stop();
    this.verify("结束时");
  }

  // 每页开始前确认应用还活着，挂了就中止，不在浏览器错误页上继续检查
  async alive() {
    if (!this.child || this.child.exitCode !== null) throw new Error(`应用中途退出了：\n${this.output.slice(-1500)}`);
    try { const r = await fetch(this.url + "/", { redirect: "manual" }); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); }
    catch (e) { throw new Error(`应用不再响应（${e.message}）：\n${this.output.slice(-1500)}`); }
  }

  describe() { return `${basename(this.appDir)} @ ${this.url}，数据副本 ${this.work}`; }
}
