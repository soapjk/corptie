import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function seedDevelopmentFixtures({
  store, skillRegistryService,
  bundledCollaborationSkillPath, now, marker, enabled
}) {
  if (!enabled) return;

  const designAgent = store.getAgent("agent:development-design") ?? store.createAgent({
    id: "agent:development-design",
    name: "产品设计",
    description: "用于验证 Agent Profile、长文本与 Memory 的开发样例。",
    systemPrompt: "梳理用户目标，输出清晰、可验证的产品方案。",
    capabilities: ["product", "ux", "research"]
  });
  const engineeringAgent = store.getAgent("agent:development-engineering") ?? store.createAgent({
    id: "agent:development-engineering",
    name: "开发验证",
    description: "用于验证聊天 Session 与 Task Worker 共用同一 Agent 的开发样例。",
    systemPrompt: "实现变更，运行相关测试，并给出可复现证据。",
    capabilities: ["swiftui", "backend", "testing"]
  });
  const bundledSkillSource = dirname(bundledCollaborationSkillPath);
  const bundledSkill = store.listRegistrySkills().find((skill) => (
    skill.sourceType === "local" && resolve(skill.source) === resolve(bundledSkillSource)
  )) ?? await skillRegistryService.register({
    name: "Corptie Collaboration",
    description: "用于验证 Agent 已安装 Skill 列表与选择流程。",
    sourceType: "local",
    source: bundledSkillSource,
    assist: false
  });
  store.setAgentRegistrySkills(designAgent.agentId, [bundledSkill.skillId]);
  store.setAgentRegistrySkills(engineeringAgent.agentId, []);
  await writeFile(marker, `${JSON.stringify({ schemaVersion: 1, seededAt: now() })}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  console.log(`[development-fixtures] seeded agents=2 skills=1 database=${store.dbPath}`);
}
