import test from "node:test";
import assert from "node:assert/strict";
import { parseJson } from "../src/store/storedJson.mjs";
import { handleFoundationModelUpdateHttpRequest } from "../src/application/modelSettingsHttpApi.mjs";
import { SshWorkspaceTransport } from "../src/runtime/sshWorkspaceTransport.mjs";

async function capture(run) {
  const original = console.error;
  const entries = [];
  console.error = (...args) => entries.push(args.join(" "));
  try { await run(); } finally { console.error = original; }
  return entries.join("\n");
}

test("stored JSON keeps fallback semantics without quoting private payloads", async () => {
  const fallback = [];
  const output = await capture(() => {
    assert.equal(parseJson(undefined, fallback), fallback);
    assert.equal(parseJson("", fallback), fallback);
    assert.deepEqual(parseJson('{"ok":true}', fallback), { ok: true });
    assert.equal(parseJson("private-user-content-canary", fallback), fallback);
  });
  assert.match(output, /SyntaxError/);
  assert.match(output, /decode-stored-json/);
  assert.ok(!output.includes("private-user-content-canary"));
  assert.equal(output.split("\n").length, 1);
});

test("settings failure logs original system cause while preserving the exact HTTP result", async () => {
  const cause = Object.assign(new Error("write rejected"), { code: "EACCES", syscall: "open" });
  const error = new Error("save failed", { cause });
  let result;
  const response = new Promise(resolve => { result = resolve; });
  const logs = await capture(async () => {
    assert.equal(handleFoundationModelUpdateHttpRequest({
      request: { method: "PUT" }, response: {},
      url: new URL("http://localhost/settings/foundation-model"),
      backendStoreReady: true, store: { migrationInProgress: false },
      readJson: async () => ({ mode: "api" }),
      foundationModelSettings: { save() { throw error; } },
      sendJson: (_response, status, body) => result({ status, body })
    }), true);
    assert.deepEqual(await response, {
      status: 400, body: { error: "模型设置无效，请检查 Provider、模型和 API 地址。" }
    });
  });
  assert.match(logs, /EACCES/);
  assert.match(logs, /open/);
  assert.equal(error.cause, cause);
});

test("SSH resolution logs cause without changing the existing public error", async () => {
  const original = Object.assign(new Error("connection lookup failed"), { code: "EIO" });
  const transport = new SshWorkspaceTransport({ resolveConnection: async () => { throw original; } });
  const logs = await capture(async () => {
    await assert.rejects(transport.execute({ connectionRef: "fixture", expectedHostIdentity: "fixture",
      cwd: "/tmp", argv: ["true"] }), error => {
      assert.equal(error.code, "SSH_CONNECTION_UNAVAILABLE");
      assert.equal(error.message, "SSH connection reference could not be resolved.");
      assert.equal(error.cause, undefined);
      return true;
    });
  });
  assert.match(logs, /EIO/);
  assert.match(logs, /resolve-connection/);
});
