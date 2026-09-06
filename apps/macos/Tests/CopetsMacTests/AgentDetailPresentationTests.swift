import Foundation
import Testing
@testable import CorptieMac

@Suite("Agent detail presentation")
struct AgentDetailPresentationTests {
    @Test("Installed Skill list preserves registry order and excludes unassigned Skills")
    func installedSkillsFollowRegistryOrder() {
        let skills = [skill(id: "one"), skill(id: "two"), skill(id: "three")]

        let installed = AgentSkillAssignment.installedSkills(
            from: skills,
            selectedSkillIds: ["skill:three", "skill:one"]
        )

        #expect(installed.map(\.skillId) == ["skill:one", "skill:three"])
    }

    @Test("Skill picker toggles a draft selection without mutating the original set")
    func skillPickerTogglesDraftSelection() {
        let original: Set<String> = ["skill:one"]

        let added = AgentSkillAssignment.toggled("skill:two", in: original)
        let removed = AgentSkillAssignment.toggled("skill:one", in: added)

        #expect(original == ["skill:one"])
        #expect(added == ["skill:one", "skill:two"])
        #expect(removed == ["skill:two"])
    }

    @Test("Agent cards expose keyboard and accessibility detail actions")
    func agentCardsExposeDetailActions() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/AgentManagementView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        #expect(source.contains(".focusable()"))
        #expect(source.contains(".onKeyPress(.return)"))
        #expect(source.contains(".onKeyPress(.space)"))
        #expect(source.contains(".accessibilityAction(named: Text(L10n(\"打开详情\")))"))
    }

    @Test("Agent management and Session creation do not branch on Assistant or Contributor roles")
    func unifiedAgentCapabilityModel() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        let management = try String(contentsOf: sourceRoot.appendingPathComponent("AgentManagementView.swift"), encoding: .utf8)
        let creation = try String(contentsOf: sourceRoot.appendingPathComponent("NewChatPickerSheet.swift"), encoding: .utf8)
        let model = try String(contentsOf: sourceRoot.appendingPathComponent("AgentModels.swift"), encoding: .utf8)

        #expect(!management.contains("filter(\\.isAssistant)"))
        #expect(!management.contains("filter(\\.isIndependentContributor)"))
        #expect(creation.contains("rows: client.agents"))
        #expect(creation.contains("case .worker: candidates = workerAgents"))
        #expect(!model.contains("var role: String"))
    }

    private func skill(id: String) -> Skill {
        Skill(
            skillId: "skill:\(id)",
            name: id.capitalized,
            description: "\(id) description",
            sourceType: "local",
            source: "/tmp/\(id)",
            installedAt: "2026-09-04T00:00:00.000Z",
            updatedAt: "2026-09-04T00:00:00.000Z"
        )
    }
}
