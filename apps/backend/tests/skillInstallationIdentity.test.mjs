import assert from "node:assert/strict";
import test from "node:test";
import { skillInstallationIdentity, withSkillRegistryMutation } from "../src/application/skillInstallationIdentity.mjs";

test("known Git SSH/HTTPS aliases match while subpaths and unknown origins remain distinct", async () => {
  const identity = (source, sourceSubpath = "skills/one") => skillInstallationIdentity({ sourceType: "git", source, sourceSubpath });
  assert.equal(await identity("git@github.com:owner/repo.git"), await identity("https://github.com/owner/repo/"));
  assert.equal(await identity("ssh://git@github.com/owner/repo.git"), await identity("https://github.com/owner/repo"));
  assert.notEqual(await identity("https://github.com/owner/repo"), await identity("https://github.com/owner/repo", "skills/two"));
  assert.notEqual(await identity("https://host.test/owner/repo"), await identity("ssh://git@host.test/owner/repo"));
  assert.notEqual(await identity("https://github.com/owner/repo?ref=a"), await identity("https://github.com/owner/repo?ref=b"));
});

test("mutation queue recovers after failure and does not serialize independent stores", async () => {
  const store = {};
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = withSkillRegistryMutation(store, async () => { events.push("first"); await gate; throw new Error("failed"); });
  const failed = assert.rejects(first, /failed/);
  const second = withSkillRegistryMutation(store, async () => { events.push("second"); return 2; });
  await withSkillRegistryMutation({}, async () => events.push("independent"));
  assert.deepEqual(events, ["first", "independent"]);
  release();
  await failed;
  assert.equal(await second, 2);
  assert.equal(events.at(-1), "second");
});
