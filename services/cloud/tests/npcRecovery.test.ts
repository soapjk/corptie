import assert from "node:assert/strict";
import test from "node:test";
import { NPCOutputDecoder, NPCRecoveryPolicy, classifyNPCOutput, type NPCHealth } from "../src/npcRecovery.js";

const broken: NPCHealth = { localReady: true, publicReady: false, bridgeReachable: true, childAlive: true };
function sampleThree(policy: NPCRecoveryPolicy, now: number, health = broken) {
  policy.evaluate(health, now); policy.evaluate(health, now);
  return policy.evaluate(health, now);
}
test("NPC diagnostic categories never return remote text, keys or passwords", () => {
  assert.equal(classifyNPCOutput("Validation key sensitive-secret incorrect"), "auth-rejected");
  assert.equal(classifyNPCOutput("web access login username:user password:secret"), "other");
  assert.equal(classifyNPCOutput("Successful connection with server secret.example"), "connected");
  assert.equal(classifyNPCOutput("error EOF"), "transport-closed");
});
test("fragmented and oversized output stays bounded and resumes on next line", () => {
  const signals: string[] = [];
  const decoder = new NPCOutputDecoder(signal => signals.push(signal));
  decoder.append("Validation ke"); decoder.append("y SECRET incorrect\n");
  decoder.append("x".repeat(100_000)); decoder.append("Validation key SECRET incorrect\n");
  decoder.append("error EOF\nSuccessful connection with server x\n");
  assert.deepEqual(signals, ["auth-rejected", "transport-closed", "connected"]);
});
test("auth rejection plus persistent unhealthy tunnel requests full registration restart", () => {
  const policy = new NPCRecoveryPolicy();
  for (let i = 0; i < 3; i++) policy.signal("auth-rejected");
  assert.deepEqual(sampleThree(policy, 100_000), { action: "restart", reason: "authentication-stuck" });
});
test("local outage, NPS outage and public-only outage never restart a healthy process", () => {
  for (const health of [broken, { ...broken, localReady: false }, { ...broken, bridgeReachable: false }]) {
    const policy = new NPCRecoveryPolicy();
    assert.equal(sampleThree(policy, 100_000, health).action, "wait");
  }
  const policy = new NPCRecoveryPolicy();
  policy.signal("auth-rejected"); policy.signal("auth-rejected"); policy.signal("auth-rejected");
  assert.equal(sampleThree(policy, 100_000, { ...broken, localReady: false }).reason, "local-unavailable");
});
test("repeated transport failures and process exit are recoverable but transient failures are not", () => {
  const policy = new NPCRecoveryPolicy();
  policy.signal("transport-closed");
  assert.equal(sampleThree(policy, 100_000).action, "wait");
  for (let i = 0; i < 5; i++) policy.signal("transport-closed");
  assert.equal(policy.evaluate(broken, 100_000).reason, "transport-stuck");
  assert.equal(sampleThree(new NPCRecoveryPolicy(), 100_000, { ...broken, childAlive: false }).reason, "process-exited");
});
test("restart budgets persist across supervisor recreation and expire after an hour", () => {
  const policy = new NPCRecoveryPolicy([100_000, 200_000, 300_000]);
  assert.equal(policy.startupDecision(320_000).reason, "cooldown");
  assert.equal(policy.startupDecision(400_000).reason, "restart-budget-exhausted");
  assert.equal(policy.startupDecision(3_900_001).action, "restart");
  policy.restarted(3_900_001);
  const recreated = new NPCRecoveryPolicy(policy.state());
  assert.equal(recreated.startupDecision(3_900_002).reason, "cooldown");
  assert.equal(recreated.startupDecision(1000).reason, "cooldown");
});
test("corrupt restart budgets fail closed", () => {
  assert.throws(() => new NPCRecoveryPolicy([NaN]));
  assert.throws(() => new NPCRecoveryPolicy([-1]));
  assert.throws(() => new NPCRecoveryPolicy([2, 1]));
  assert.throws(() => new NPCRecoveryPolicy([1, 2, 3, 4]));
});
test("only sustained public health resets budget; connected log alone is not health", () => {
  const policy = new NPCRecoveryPolicy([100_000, 200_000, 300_000]);
  policy.signal("connected");
  assert.equal(policy.startupDecision(400_000).reason, "restart-budget-exhausted");
  policy.evaluate({ ...broken, publicReady: true }, 400_000);
  policy.evaluate({ ...broken, publicReady: true }, 699_999);
  assert.equal(policy.state().length, 3);
  policy.evaluate({ ...broken, publicReady: true }, 700_000);
  assert.deepEqual(policy.state(), []);
});
