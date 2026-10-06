#!/usr/bin/env node
// Inactive until explicitly launched. Diagnostic mode never starts/stops NPC.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { open, readFile, rename, mkdir, lstat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { NPCRecoveryPolicy, NPCOutputDecoder } from "../dist/src/npcRecovery.js";

const emit = (event, fields = {}) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + "\n");
export function npcProcessIDs(output) {
  return output.split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && /(?:^|\/)npc$/.test(match[2]) ? [Number(match[1])] : [];
  });
}
async function existingNPCs(ownedPID) {
  const { stdout } = await promisify(execFile)("/bin/ps", ["-axo", "pid=,comm="], { maxBuffer: 1024 * 1024 });
  return npcProcessIDs(stdout).filter(pid => pid !== ownedPID);
}
export async function stopOwnedNPC(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await exited; } finally { clearTimeout(kill); }
}
export async function startOwnedNPC(executable, config, receive, processCheck = existingNPCs) {
  if ((await processCheck()).length) throw new Error("Existing NPC requires operator migration");
  const child = spawn(executable, ["-config=" + config], { stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new NPCOutputDecoder(receive);
    stream.setEncoding("utf8");
    stream.on("data", chunk => decoder.append(chunk));
  }
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return child;
}
export async function probeHTTP(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    await response.body?.cancel();
    return { ready: response.ok, status: response.status };
  } catch { return { ready: false, status: 0 }; }
}
export function probeBridge(host, port) {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    let finished = false;
    const finish = value => { if (!finished) { finished = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(3000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
export function options(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (["--supervise", "--allow-registration"].includes(flag)) opts[flag] = true;
    else if (["--executable", "--config", "--state-dir"].includes(flag)) {
      if (!args[i + 1] || args[i + 1].startsWith("--") || opts[flag]) throw new Error("Invalid arguments");
      opts[flag] = args[++i];
    } else throw new Error("Unknown argument");
  }
  if (!opts["--config"] || !isAbsolute(opts["--config"])) throw new Error("Absolute config required");
  if (opts["--supervise"] && (!opts["--allow-registration"] || !isAbsolute(opts["--executable"] ?? "") ||
      !isAbsolute(opts["--state-dir"] ?? ""))) throw new Error("Supervision requires explicit registration permission, executable and private state directory");
  return opts;
}
export function parseBridgeConfig(text) {
  const common = text.split(/^\[common\]\s*$/m)[1]?.split(/^\[/m)[0];
  const address = common?.match(/^server_addr\s*=\s*([^\r\n]+)$/m)?.[1]?.trim();
  const match = address?.match(/^([A-Za-z0-9.-]+):(\d+)$/);
  if (!match || +match[2] < 1 || +match[2] > 65535) throw new Error("Invalid bridge address");
  if (!common.match(/^vkey\s*=\s*\S+\s*$/m)) throw new Error("Missing bridge credential");
  return { host: match[1], port: +match[2] };
}
export async function acquireLock(directory) {
  if (!isAbsolute(directory)) throw new Error("Absolute state directory required");
  if (["/", "/tmp", "/private/tmp"].includes(directory)) throw new Error("Dedicated state directory required");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
    throw new Error("State directory must be owned, private and not a symlink");
  }
  const lock = join(directory, "supervisor.lock");
  const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  await handle.writeFile(String(process.pid));
  await handle.close();
  // Stale locks deliberately require an operator check; never kill an unknown PID.
  return () => unlink(lock);
}
async function main(args) {
  const opts = options(args);
  const configInfo = await lstat(opts["--config"]);
  if (!configInfo.isFile() || configInfo.isSymbolicLink() || (configInfo.mode & 0o077) !== 0 ||
      configInfo.uid !== process.getuid() || configInfo.size > 65536) throw new Error("Config must be a private owned regular file");
  const config = await readFile(opts["--config"], "utf8");
  const bridge = parseBridgeConfig(config);
  const sample = async () => {
    const [local, publicHealth, bridgeReachable] = await Promise.all([
      probeHTTP("http://127.0.0.1:4310/readyz"), probeHTTP("https://corptie.llmay.cn/healthz"), probeBridge(bridge.host, bridge.port)
    ]);
    return { local, publicHealth, bridgeReachable };
  };
  if (!opts["--supervise"]) { emit("diagnostic", { ...await sample(), existingNPCCount: (await existingNPCs()).length }); return; }
  const release = await acquireLock(opts["--state-dir"]);
  let child, stopping = false;
  const statePath = join(opts["--state-dir"], "restart-state.json");
  try {
    let prior = [];
    try { prior = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Unreadable restart budget"); }
    if (!Array.isArray(prior)) throw new Error("Invalid restart budget");
    const policy = new NPCRecoveryPolicy(prior);
    let persisted = JSON.stringify(prior);
    const save = async () => {
      const content = JSON.stringify(policy.state());
      if (content === persisted) return;
      const temporary = statePath + ".next";
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await file.writeFile(content); await file.close();
      await rename(temporary, statePath);
      persisted = content;
    };
    const stopChild = async () => {
      await stopOwnedNPC(child);
    };
    const startChild = async () => {
      if ((await existingNPCs(child?.pid)).length) {
        emit("npc-start-refused", { reason: "existing-client-requires-operator-migration" });
        throw new Error("Existing NPC must be resolved before activation");
      }
      child = await startOwnedNPC(opts["--executable"], opts["--config"], signal => {
        policy.signal(signal);
        if (signal !== "other") emit("npc-signal", { signal });
      });
      // No shell, no vkey in argv. Preserve every configured forwarding route.
      emit("npc-started");
    };
    const stop = () => { stopping = true; };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    try {
      // Startup is budgeted too, so restarting this supervisor cannot bypass limits.
      const initialHealth = await sample();
      const initial = policy.startupDecision(Date.now());
      if (!stopping && initialHealth.local.ready && initialHealth.bridgeReachable && initial.action === "restart") {
        policy.restarted(Date.now()); await save(); await startChild();
      }
      while (!stopping) {
        const health = await sample();
        if (stopping) break;
        const decision = policy.evaluate({ localReady: health.local.ready, publicReady: health.publicHealth.ready,
          bridgeReachable: health.bridgeReachable, childAlive: !!child && child.exitCode === null && child.signalCode === null }, Date.now());
        emit("health", { ...health, ...decision });
        await save();
        if (decision.action === "restart") {
          await stopChild();
          if (stopping) break;
          policy.restarted(Date.now()); await save(); await startChild();
        }
        if (!stopping) await new Promise(resolve => setTimeout(resolve, 10_000));
      }
    } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); await stopChild(); }
  } finally { await release(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { emit("supervisor-failed", { reason: "check-private-config-lock-and-restart-budget" }); process.exitCode = 1; });
}
