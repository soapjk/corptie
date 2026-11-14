// Installer/protocol entry point. The Session gateway uses the same preparation
// directly, retaining its normal cancellation, approval and desktop mutex rules.
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { builtinComputerUseConfig, prepareBuiltinComputerUse } from "../application/computerUseEngine.mjs";

const dataDir = process.argv[process.argv.indexOf("--data-dir") + 1];
let prepared, child;
async function cleanup() {
  if (prepared?.stateRoot) await rm(prepared.stateRoot, { recursive: true, force: true });
}
try {
  prepared = await prepareBuiltinComputerUse(builtinComputerUseConfig(dataDir));
  child = spawn(prepared.command, prepared.args ?? [], {
    cwd: prepared.cwd, env: prepared.env, stdio: ["pipe", "pipe", "pipe"]
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", () => {});
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => child.kill(signal));
  child.once("error", async error => { process.stderr.write(`${error.code ?? "COMPUTER_USE_START_FAILED"}\n`); await cleanup(); process.exitCode = 1; });
  child.once("close", async code => { await cleanup(); process.exitCode = code ?? 1; process.stdin.destroy(); });
} catch (error) {
  process.stderr.write(`${error.code ?? "COMPUTER_USE_UNAVAILABLE"}: ${error.message}\n`);
  await cleanup();
  process.exitCode = 1;
}
