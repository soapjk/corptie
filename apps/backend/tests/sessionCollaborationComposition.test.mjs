import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSessionCollaborationComposition } from "../src/application/sessionCollaborationComposition.mjs";
import { WorkSessionStartApplicationService } from "../src/application/workSessionStartApplicationService.mjs";

function compose(getService) {
  return createSessionCollaborationComposition({
    store: {}, workService: {}, collaborationCore: {}, defaultProviderId: "test",
    getWorkSessionStartApplicationService: getService
  }).workSessionStartApplicationService;
}

test("production collaboration port resolves startup lazily and preserves arguments, this and results", async () => {
  let service = null, reads = 0;
  const port = compose(() => { reads++; return service; });
  assert.equal(reads, 0);
  assert.throws(() => port.getSessionBinding("logical:one"), { code: "START_REFERENCE_INVALID" });
  assert.throws(() => port.start({}), { code: "CAPABILITY_UNAVAILABLE" });
  const command = { taskId: "task:one" }, proof = { status: "ready" };
  service = {
    start(input) { assert.equal(this, service); assert.equal(input, command); return Promise.resolve(proof); },
    getSessionBinding(id) { assert.equal(this, service); assert.equal(id, "logical:one"); return proof; }
  };
  assert.equal(await port.start(command), proof);
  assert.equal(port.getSessionBinding("logical:one"), proof);
  const failure = Object.assign(new Error("Proof no longer valid"), { code: "START_REFERENCE_INVALID" });
  service = { getSessionBinding() { throw failure; } };
  assert.throws(() => port.getSessionBinding("logical:one"), error => error === failure);
});

test("production collaboration port delegates real startup proof lookup including managed Sandbox fallback", () => {
  const gitProof = { status: "ready", task: { id: "task:git" } };
  const sandboxProof = { status: "ready", task: { id: "task:sandbox" } };
  const calls = [];
  const coordinator = {
    getSessionBinding(id) {
      assert.equal(this, coordinator);
      calls.push(["git", id]);
      if (id === "logical:git") return gitProof;
      throw Object.assign(new Error("No Git receipt"), { code: "START_REFERENCE_INVALID" });
    }
  };
  const managedSandboxCoordinator = {
    getSessionBinding(id) {
      assert.equal(this, managedSandboxCoordinator);
      calls.push(["sandbox", id]);
      if (id === "logical:sandbox") return sandboxProof;
      throw Object.assign(new Error("No Sandbox receipt"), { code: "START_REFERENCE_INVALID" });
    }
  };
  const service = new WorkSessionStartApplicationService({ store: {}, providerRegistry: {}, coordinator, managedSandboxCoordinator });
  const port = compose(() => service);
  assert.equal(port.getSessionBinding("logical:git"), gitProof);
  assert.equal(port.getSessionBinding("logical:sandbox"), sandboxProof);
  assert.throws(() => port.getSessionBinding("logical:missing"), { code: "START_REFERENCE_INVALID" });
  assert.deepEqual(calls, [["git", "logical:git"], ["git", "logical:sandbox"], ["sandbox", "logical:sandbox"],
    ["git", "logical:missing"], ["sandbox", "logical:missing"]]);
  coordinator.getSessionBinding = () => { throw Object.assign(new Error("Store unavailable"), { code: "STORE_UNAVAILABLE" }); };
  assert.throws(() => port.getSessionBinding("logical:sandbox"), { code: "STORE_UNAVAILABLE" });
  assert.equal(calls.length, 5, "non-reference errors must not fall back or synthesize proof");
});

test("server uses the tested collaboration composition with a delayed startup getter", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ createSessionCollaborationComposition \} from "\.\/application\/sessionCollaborationComposition\.mjs"/);
  const wiring = source.match(/sessionCollaborationService = createSessionCollaborationComposition\(\{([\s\S]*?)\n\}\);/);
  assert.ok(wiring);
  assert.match(wiring[1], /getWorkSessionStartApplicationService: \(\) => workSessionStartApplicationService/);
  assert.ok(source.indexOf(wiring[0]) < source.indexOf("= createWorkSessionStartupComposition({"));
});
