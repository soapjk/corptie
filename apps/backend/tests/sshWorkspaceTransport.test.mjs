import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshWorkspaceTransport, remoteAbsolutePath, shellQuote, sshWorkspaceIdentity, sshClientEnvironment } from "../src/runtime/sshWorkspaceTransport.mjs";

const connection = {
  hostIdentity: "fixture-host-key-sha256",
  hostAlias: "fixture", hostKeyAlias: "fixture-key",
  configPath: "/private/fixture-config", knownHostsPath: "/private/fixture-known-hosts"
};
const input = { connectionRef: "credential:fixture", expectedHostIdentity: connection.hostIdentity, cwd: "/tmp", argv: ["true"] };

function fixture(options = {}) {
  let starts = 0;
  const transport = new SshWorkspaceTransport({
    resolveConnection: async () => connection,
    spawnProcess: (_binary, args, spawnOptions) => {
      starts += 1;
      return spawn("/bin/sh", ["-c", args.at(-1)], spawnOptions);
    },
    ...options
  });
  return { transport, starts: () => starts };
}

test("SSH identities include the host and normalize POSIX paths without local resolution", () => {
  assert.notEqual(sshWorkspaceIdentity("host-a", "/same"), sshWorkspaceIdentity("host-b", "/same"));
  assert.equal(sshWorkspaceIdentity("host-a", "/same/../repo"), sshWorkspaceIdentity("host-a", "/repo"));
  for (const path of ["relative", "~/repo", "/bad\0path", "/bad\npath"]) {
    assert.throws(() => remoteAbsolutePath(path), { code: "SSH_WORKSPACE_INPUT_INVALID" });
  }
});

test("SSH does not inherit Provider authentication, runtime configuration or arbitrary SendEnv secrets", () => {
  const env = sshClientEnvironment({ PATH: "/usr/bin", HOME: "/local/home", SSH_AUTH_SOCK: "/local/agent.sock",
    ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret", CODEX_HOME: "/provider/runtime", CUSTOM_SECRET: "secret", GIT_DIR: "/wrong" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/local/home", SSH_AUTH_SOCK: "/local/agent.sock" });
});

test("cwd and argv remain literal across SSH's remote shell, including spaces, quotes and substitutions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh fixture ' $() ; "));
  try {
    const { transport } = fixture();
    const literal = "' ; $(printf injected) `id` \n \" * -- " ;
    const result = await transport.execute({ ...input, cwd: root, argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify([process.cwd(),process.argv[1]]))", literal] });
    assert.equal(result.state, "completed");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), [root.replace(/^\/var\//, "/private/var/"), literal]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing remote cwd fails without running in a local fallback directory", async () => {
  const { transport } = fixture();
  const result = await transport.execute({ ...input, cwd: "/corptie-fixture-missing-8cdc76", argv: ["printf", "must-not-run"] });
  assert.equal(result.state, "completed");
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, "");
});

test("host changes, unsafe aliases and unresolved credentials fail before spawn without leaking resolver errors", async () => {
  let starts = 0;
  const transport = new SshWorkspaceTransport({ resolveConnection: async () => connection, spawnProcess: () => { starts += 1; } });
  await assert.rejects(transport.execute({ ...input, expectedHostIdentity: "other" }), { code: "SSH_HOST_IDENTITY_CHANGED" });
  transport.resolveConnection = async () => ({ ...connection, hostAlias: "-oProxyCommand=secret" });
  await assert.rejects(transport.execute(input), { code: "SSH_WORKSPACE_INPUT_INVALID" });
  transport.resolveConnection = async () => { throw new Error("private-key-secret"); };
  await assert.rejects(transport.execute(input), (error) => error.code === "SSH_CONNECTION_UNAVAILABLE" && !JSON.stringify(error).includes("private-key-secret"));
  assert.equal(starts, 0);
});

test("SSH invocation pins known hosts, disables forwarding/multiplexing and uses no local shell", async () => {
  const { transport } = fixture({ spawnProcess: (binary, args, options) => {
    assert.equal(binary, "/usr/bin/ssh");
    assert.equal(options.shell, false);
    for (const flag of ["BatchMode=yes", "StrictHostKeyChecking=yes", "UpdateHostKeys=no", "ForwardAgent=no", "ClearAllForwardings=yes", "ControlPath=none", "PermitLocalCommand=no"]) assert.ok(args.includes(flag));
    assert.deepEqual(args.slice(-3, -1), ["--", "fixture"]);
    return spawn("/bin/sh", ["-c", args.at(-1)], options);
  } });
  assert.equal((await transport.execute(input)).exitCode, 0);
});

test("stderr containing SSH credential diagnostics is never returned or streamed", async () => {
  const events = [];
  const { transport } = fixture();
  const result = await transport.execute({ ...input, argv: [process.execPath, "-e", "process.stderr.write('private-key-secret');process.stdout.write('public')"], onOutput: (event) => events.push(event) });
  assert.equal(result.stdout, "public");
  assert.ok(!JSON.stringify([result, events]).includes("private-key-secret"));
});

test("disconnect returns unknown, never claims remote process termination and never replays", async () => {
  const { transport, starts } = fixture();
  const result = await transport.execute({ ...input, argv: [process.execPath, "-e", "process.stdout.write('partial');process.exit(255)"] });
  assert.equal(result.state, "unknown");
  assert.equal(result.stdout, "partial");
  assert.equal(result.remoteProcessTermination, "unverified");
  assert.equal(result.retrySafe, false);
  assert.equal(starts(), 1);
});

test("timeout and cancellation are unknown outcomes; pre-cancelled requests do not start", async () => {
  const { transport, starts } = fixture();
  const command = { ...input, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] };
  const timeout = await transport.execute({ ...command, timeoutMs: 40 });
  assert.equal(timeout.state, "unknown");
  assert.equal(timeout.reason, "timeout");
  const controller = new AbortController();
  const running = transport.execute({ ...command, signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  const cancelled = await running;
  assert.equal(cancelled.state, "unknown");
  assert.equal(cancelled.reason, "cancelled");
  const before = starts();
  assert.equal((await transport.execute({ ...command, signal: controller.signal })).state, "not_started");
  assert.equal(starts(), before);
});

test("bounded output and callback failure stop collection without falsely succeeding", async () => {
  const { transport } = fixture({ maxOutputBytes: 4096 });
  const result = await transport.execute({ ...input, argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"] });
  assert.equal(result.reason, "output_limit");
  assert.equal(result.state, "unknown");
  assert.ok(Buffer.byteLength(result.stdout) <= 4096);
  const callback = await transport.execute({ ...input, argv: ["printf", "hello"], onOutput: () => { throw new Error("consumer"); } });
  assert.equal(callback.reason, "output_consumer_failed");
});

test("capacity is reserved before async credential lookup and released on failure", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { transport } = fixture({ maxConcurrent: 1, resolveConnection: () => pending });
  const first = transport.execute(input);
  await assert.rejects(transport.execute(input), { code: "SSH_WORKSPACE_BUSY" });
  release(connection);
  assert.equal((await first).exitCode, 0);
  assert.equal((await transport.execute(input)).exitCode, 0);
});

test("invalid argument, timeout and stdin limits reject before any execution", async () => {
  const { transport, starts } = fixture();
  for (const patch of [{ argv: [] }, { argv: ["echo", "bad\0value"] }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { stdin: Buffer.from("x") }]) {
    await assert.rejects(transport.execute({ ...input, ...patch }), { code: "SSH_WORKSPACE_INPUT_INVALID" });
  }
  assert.throws(() => shellQuote("bad\0value"));
  assert.equal(starts(), 0);
});
