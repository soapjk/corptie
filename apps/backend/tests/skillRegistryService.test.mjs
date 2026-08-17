import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillRegistryService } from "../src/application/skillRegistryService.mjs";
import { callSkillDynamicTool } from "../src/application/skillDynamicTools.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-skill-registry-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const source = join(directory, "source");
  const runtime = join(directory, "runtime-skills");
  await mkdir(join(source, "skills", "alpha"), { recursive: true });
  await mkdir(join(source, "skills", "investrace"), { recursive: true });
  await writeFile(join(source, "skills", "alpha", "SKILL.md"), [
    "---", "name: alpha", "description: Alpha workflow", "---", "Alpha instructions"
  ].join("\n"));
  await writeFile(join(source, "skills", "investrace", "SKILL.md"), [
    "---", "name: investrace", "description: Record investment decisions", "---", "Investrace instructions"
  ].join("\n"));
  const service = new SkillRegistryService({ store, skillsDirs: { test: runtime } });
  return { directory, source, runtime, store, service };
}

test("multi-Skill source requires an explicit candidate and materializes the selected Skill", async () => {
  const value = await fixture();
  try {
    const discovery = await value.service.discover({ sourceType: "local", source: value.source });
    assert.deepEqual(discovery.candidates.map((item) => item.manifestName), ["alpha", "investrace"]);

    await assert.rejects(
      value.service.register({ sourceType: "local", source: value.source }),
      (error) => error.code === "AMBIGUOUS_SKILL_SOURCE" && error.candidates.length === 2
    );

    const skill = await value.service.register({
      sourceType: "local",
      source: value.source,
      sourceSubpath: "skills/investrace"
    });
    assert.equal(skill.manifestName, "investrace");
    assert.equal(skill.sourceSubpath, "skills/investrace");
    const installed = await readFile(join(value.runtime, skill.skillId, "SKILL.md"), "utf8");
    assert.match(installed, /Investrace instructions/);
    assert.doesNotMatch(installed, /Alpha instructions/);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Skill search and load are limited to the authenticated Agent's assignments", async () => {
  const value = await fixture();
  try {
    const skill = await value.service.register({
      sourceType: "local",
      source: value.source,
      sourceSubpath: "skills/investrace"
    });
    const assigned = value.store.createAgent({ name: "Investor", provider: "codex-app-server" });
    const unassigned = value.store.createAgent({ name: "Other", provider: "codex-app-server" });
    value.store.setAgentRegistrySkills(assigned.agentId, [skill.skillId]);

    const search = await callSkillDynamicTool(value.service, {
      actorId: assigned.agentId,
      tool: "corptie_skill_search",
      arguments: { intent: "你能不能使用investrace" }
    });
    assert.equal(search.found, true);
    assert.equal(search.candidates[0].skillId, skill.skillId);

    const loaded = await value.service.loadForAgent(assigned.agentId, skill.skillId);
    assert.equal(loaded.name, "investrace");
    assert.match(loaded.content, /Investrace instructions/);

    await assert.rejects(
      value.service.loadForAgent(unassigned.agentId, skill.skillId),
      (error) => error.code === "SKILL_NOT_ASSIGNED"
    );
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Agent Skill replacement validates before deleting the existing assignment", async () => {
  const value = await fixture();
  try {
    const skill = await value.service.register({
      sourceType: "local",
      source: value.source,
      sourceSubpath: "skills/investrace"
    });
    const agent = value.store.createAgent({ name: "Investor", provider: "codex-app-server" });
    value.store.setAgentRegistrySkills(agent.agentId, [skill.skillId]);
    assert.throws(
      () => value.store.setAgentRegistrySkills(agent.agentId, ["skill:missing"]),
      (error) => error.code === "SKILL_NOT_FOUND"
    );
    assert.deepEqual(value.store.listRegistrySkillIdsForAgent(agent.agentId), [skill.skillId]);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("legacy registration repair selects the unique manifest matching the registered name", async () => {
  const value = await fixture();
  try {
    const legacy = value.store.createRegistrySkill({
      name: "investrace",
      description: "",
      sourceType: "local",
      source: value.source
    });
    const result = await value.service.repairLegacyRegistrations();
    assert.equal(result.repaired.length, 1);
    const repaired = value.store.getRegistrySkill(legacy.skillId);
    assert.equal(repaired.sourceSubpath, "skills/investrace");
    assert.equal(repaired.manifestName, "investrace");
    const installed = await readFile(join(value.runtime, legacy.skillId, "SKILL.md"), "utf8");
    assert.match(installed, /Investrace instructions/);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
