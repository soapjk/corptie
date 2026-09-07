import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SshConnectionService } from "../src/application/sshConnectionService.mjs";
import { SshWorkspaceTransport } from "../src/runtime/sshWorkspaceTransport.mjs";

const runFile = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ssh reference with spaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config");
  const knownHostsPath = join(root, "known_hosts");
  const keyPath = join(root, "fixture-key");
  await runFile("/usr/bin/ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath]);
  const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim().split(/\s+/u).slice(0, 2).join(" ");
  await writeFile(configPath, "Host fixture-one fixture-two wildcard*\n  HostName fixture.example.invalid\n  User fixture\n  Port 22\nHost fixture-one\n  ForwardAgent yes\n");
  await writeFile(knownHostsPath, `fixture.example.invalid ${publicKey}\n`);
  const records = new Map();
  const repository = {
    registerConnection(input) { records.set(input.connectionId, input); const { credentialRef, ...result } = input; return result; },
    connection(id) { return records.get(id); }
  };
  const commands = [];
  const service = new SshConnectionService({ repository, referenceDirectory: join(root, "references"), configPath, knownHostsPath,
    run: (binary, args, options) => { commands.push({ binary, args }); return runFile(binary, args, options); } });
  return { root, service, records, configPath, knownHostsPath, publicKey, commands };
}

test("connection registration pins reviewed public host key and retains authentication as a private local reference", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.listAliases(), ["fixture-one", "fixture-two"]);
  const inspection = await f.service.inspectAlias("fixture-one");
  assert.equal(inspection.target.hostname, "fixture.example.invalid");
  assert.equal(inspection.keys[0].algorithm, "ssh-ed25519");
  const connection = await f.service.register({ hostAlias: "fixture-one", label: "Fixture", fingerprint: inspection.keys[0].fingerprint });
  assert.equal(connection.credentialRef, undefined);
  const resolved = await f.service.resolve(connection.connectionId);
  assert.equal(resolved.configPath, f.configPath);
  assert.equal(resolved.hostIdentity, connection.hostIdentity);
  assert.equal((await stat(resolved.knownHostsPath)).mode & 0o777, 0o600);
  assert.match(await readFile(resolved.knownHostsPath, "utf8"), /^corptie-[a-f0-9-]+ ssh-ed25519 /u);
  const ref = f.records.get(connection.connectionId).credentialRef;
  const contents = await readFile(join(f.root, "references", `${ref.split(":")[1]}.json`), "utf8");
  assert.ok(!contents.includes("PRIVATE KEY"));
  assert.ok(!contents.includes("fixture-key"));
  assert.ok(f.commands.every(({ binary, args }) => binary.endsWith("ssh-keygen") || args.includes("-G")), "all inspection commands must be local-only");
});

test("replaced aliases, host pins and reference permissions require explicit re-registration", async (t) => {
  const f = await fixture(t);
  const fingerprint = (await f.service.inspectAlias("fixture-one")).keys[0].fingerprint;
  const connection = await f.service.register({ hostAlias: "fixture-one", label: "Fixture", fingerprint });
  const original = await readFile(f.configPath, "utf8");
  await writeFile(f.configPath, original.replace("fixture.example.invalid", "other.example.invalid"));
  await assert.rejects(f.service.resolve(connection.connectionId), { code: "SSH_REFERENCE_CHANGED" });
  await writeFile(f.configPath, original);
  const resolved = await f.service.resolve(connection.connectionId);
  await writeFile(resolved.knownHostsPath, "replaced-key");
  await assert.rejects(f.service.resolve(connection.connectionId), { code: "SSH_REFERENCE_CHANGED" });
});

test("untrusted/revoked keys and malicious aliases are rejected without connecting", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.inspectAlias("-oProxyCommand=echo secret"), { code: "SSH_ALIAS_INVALID" });
  await assert.rejects(f.service.register({ hostAlias: "fixture-one", label: "Fixture", fingerprint: "SHA256:unreviewed" }), { code: "SSH_HOST_KEY_CHANGED" });
  await writeFile(f.knownHostsPath, `fixture.example.invalid ${f.publicKey}\n@revoked fixture.example.invalid ${f.publicKey}\n`);
  await assert.rejects(f.service.inspectAlias("fixture-one"), { code: "SSH_HOST_KEY_REVOKED" });
  await writeFile(f.knownHostsPath, "");
  await assert.rejects(f.service.inspectAlias("fixture-one"), { code: "SSH_TRUSTED_HOST_KEY_REQUIRED" });
});

test("hashed known_hosts entries are resolved by OpenSSH without network access", async (t) => {
  const f = await fixture(t);
  const fingerprint = (await f.service.inspectAlias("fixture-one")).keys[0].fingerprint;
  await runFile("/usr/bin/ssh-keygen", ["-H", "-f", f.knownHostsPath]);
  assert.ok((await readFile(f.knownHostsPath, "utf8")).startsWith("|1|"));
  assert.equal((await f.service.inspectAlias("fixture-one")).keys[0].fingerprint, fingerprint);
});

test("saved connections reject later host key revocation and trust removal before transport launch", async (t) => {
  const f = await fixture(t);
  const fingerprint = (await f.service.inspectAlias("fixture-one")).keys[0].fingerprint;
  const connection = await f.service.register({ hostAlias: "fixture-one", label: "Fixture", fingerprint });
  let launches = 0;
  const transport = new SshWorkspaceTransport({ resolveConnection: (id) => f.service.resolve(id),
    spawnProcess: () => { launches++; throw new Error("must not launch"); } });
  for (const trust of [`fixture.example.invalid ${f.publicKey}\n@revoked fixture.example.invalid ${f.publicKey}\n`, ""]) {
    await writeFile(f.knownHostsPath, trust);
    await assert.rejects(transport.execute({ connectionRef: connection.connectionId, expectedHostIdentity: connection.hostIdentity,
      cwd: "/remote", argv: ["true"] }), { code: "SSH_CONNECTION_UNAVAILABLE" });
  }
  assert.equal(launches, 0);
  await writeFile(f.knownHostsPath, `fixture.example.invalid ${f.publicKey}\n`);
  assert.equal((await f.service.resolve(connection.connectionId)).hostIdentity, connection.hostIdentity);
});

test("transport options preserve private known_hosts paths containing spaces in OpenSSH config parsing", async (t) => {
  const f = await fixture(t);
  const fingerprint = (await f.service.inspectAlias("fixture-one")).keys[0].fingerprint;
  const connection = await f.service.register({ hostAlias: "fixture-one", label: "Fixture", fingerprint });
  const resolved = await f.service.resolve(connection.connectionId);
  const transport = new SshWorkspaceTransport({ resolveConnection: (id) => f.service.resolve(id),
    // -G exits after config expansion; it never connects or runs the remote command.
    spawnProcess: (binary, args, options) => spawn(binary, ["-G", ...args], options) });
  const result = await transport.execute({ connectionRef: connection.connectionId, expectedHostIdentity: connection.hostIdentity, cwd: "/remote", argv: ["true"] });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes(`userknownhostsfile ${resolved.knownHostsPath}`));
  assert.match(result.stdout, /forwardagent no/u);
  assert.match(result.stdout, /stricthostkeychecking true|stricthostkeychecking yes/u);
});
