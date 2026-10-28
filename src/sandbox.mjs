// 沙箱：应用只连数据副本，原数据从头到尾不被打开。
// 跑前跑后给原数据做指纹，任何变化都立即中止并报警。
import { spawn, execSync, execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fill, freePort, parseEnvFile, portNames } from "./config.mjs";

function clone(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  if (process.platform === "darwin") {
    // APFS 写时复制：秒级完成、不额外占空间
    try { execSync(`cp -c -R ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { stdio: "ignore" }); return; } catch {}
  }
  cpSync(src, dest, { recursive: true, preserveTimestamps: true });
}

function fingerprint(path, skip = () => false) {
  const h = createHash("sha256");
  if (!existsSync(path)) return "missing";
  const walk = (p) => {
    if (skip(p)) return;
    let s; try { s = statSync(p); } catch { return; }
    if (s.isDirectory()) { for (const n of readdirSync(p).sort()) walk(join(p, n)); return; }
    h.update(`${p}\0${s.size}\0${s.mtimeMs}\n`);
  };
  walk(path);
  return h.digest("hex").slice(0, 16);
}

// 应用可以写的地方：沙箱、系统临时目录、各类工具缓存。其他地方的写入都算漏配
const HOME = homedir();
const ALLOWED = [tmpdir(), "/tmp", "/private/tmp", "/private/var/folders", "/var/folders", "/dev",
  join(HOME, "Library/Caches"), join(HOME, "Library/Logs"), join(HOME, ".npm"), join(HOME, ".cache"), join(HOME, ".nvm"), join(HOME, ".pnpm-store"), join(HOME, ".yarn"), join(HOME, ".bun")];
// 应用直接在原项目目录里跑时（没开 copyProject），只允许写这些构建产物
const BUILD_ARTIFACT = /(^|\/)(node_modules|\.next|\.vinext|\.vite|\.turbo|\.svelte-kit|\.nuxt|\.output|dist|build|out|coverage|\.wrangler\/tmp|\.parcel-cache|__pycache__)(\/|$)|\.log$|\.tsbuildinfo$/;
const safeReal = (p) => { try { return realpathSync(p); } catch { return p; } };
const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

export class Sandbox {
  constructor(config, log = console.log) {
    this.config = config; this.log = log;
    this.root = join(config.home, "sandbox");
    this.child = null; this.dirty = false; this.leaks = new Set(); this.watcher = null;
  }

  originals() {
    const out = Object.entries(this.config.data).map(([name, p]) => [`data:${name}`, fingerprint(p)]);
    for (const p of this.config.watch) out.push([`watch:${p}`, fingerprint(p)]);
    {
      const skip = (p) => { const rel = relative(this.config.projectDir, p); return rel === ".git" || rel.startsWith(".git" + sep) || BUILD_ARTIFACT.test(rel); };
      out.push(["project", fingerprint(this.config.projectDir, skip)]);
    }
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
    this.watchWrites();
    const exited = new Promise((r) => this.child.once("exit", (code) => r(code)));
    const deadline = Date.now() + this.config.readyTimeout;
    while (Date.now() < deadline) {
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 500))]);
      if (code !== undefined) throw new Error(`应用启动后退出了（code ${code}）：\n${this.output.slice(-1500)}`);
      try { const r = await fetch(this.url + "/", { redirect: "manual" }); if (r.status < 500) return; } catch {}
    }
    throw new Error(`应用 ${this.config.readyTimeout / 1000}s 内没有响应 ${this.url}：\n${this.output.slice(-1500)}`);
  }

  // 每秒用 lsof 看一次应用整个进程组以写方式打开了哪些文件。SQLite 这类长期打开的库一定能抓到；
  // 写完立刻关闭的小文件可能漏掉，所以结束时还会对原数据做指纹比对
  watchWrites() {
    clearInterval(this.watcher);
    const pgid = this.child.pid;
    const realProject = safeReal(this.config.projectDir);
    const scan = () => execFile("lsof", ["-n", "-P", "-F", "an", "-g", String(pgid)], { maxBuffer: 8 << 20 }, (err, out) => {
      if (!out) return;
      let mode = "";
      for (const line of out.split("\n")) {
        if (line[0] === "a") mode = line.slice(1);
        else if (line[0] === "n" && line[1] === "/" && /[wu]/.test(mode)) {
          const p = line.slice(1).replace(/ \(.*\)$/, "");
          if (under(p, this.root)) continue;
          // 原项目目录（包括 macOS 上 /tmp → /private/tmp 的真实路径）优先判定，哪怕它在临时目录下
          const proj = [this.config.projectDir, realProject].find((d) => under(p, d));
          if (proj) { if (!this.config.copyProject && BUILD_ARTIFACT.test(relative(proj, p))) continue; this.leaks.add(p); continue; }
          if (Object.values(this.config.data).some((d) => under(p, d) || under(p, safeReal(d)))) { this.leaks.add(p); continue; }
          if (ALLOWED.some((r) => under(p, r))) continue;
          this.leaks.add(p);
        }
      }
    });
    this.watcher = setInterval(scan, 1000); scan();
  }

  checkLeaks(stage) {
    if (!this.leaks.size) return;
    const err = new Error(`应用往沙箱外写文件（${stage}）：\n  ${[...this.leaks].slice(0, 8).join("\n  ")}\n这些路径没有写进配置的 data，应用写的是原数据。把它们加进 data 并用 env 指到副本后再跑`);
    err.code = "ISOLATION"; throw err;
  }

  async stop() {
    clearInterval(this.watcher);
    if (!this.child || this.child.exitCode !== null) return;
    const exited = new Promise((r) => this.child.once("exit", r));
    try { process.kill(-this.child.pid, "SIGTERM"); } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    try { process.kill(-this.child.pid, "SIGKILL"); } catch {}
    this.child = null;
  }

  // 有写操作之后才重置；重置前后都核对原数据
  async reset() {
    this.checkLeaks("运行中");
    if (!this.dirty) return;
    this.verify("重置前");
    if (this.config.reset === "files") this.resetData();
    else { await this.stop(); this.resetData(); await this.start(); }
  }

  // 已经因为隔离问题中止时不再重复检查，保留第一次的报错
  async dispose(failed) {
    await this.stop();
    if (failed?.code === "ISOLATION") return;
    this.checkLeaks("结束时");
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
