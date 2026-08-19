import Testing
@testable import CorptieMac

@Suite("Agents and Skills management layout")
struct AgentsSkillsLayoutTests {
    @Test("Desktop width uses parallel columns")
    func desktopUsesSplitLayout() {
        #expect(AgentsSkillsLayoutMetrics.mode(for: 1200) == .split)
        #expect(AgentsSkillsLayoutMetrics.skillsColumnWidth == 300)
        #expect(AgentsSkillsLayoutMetrics.headerHeight == 60)
        #expect(AgentsSkillsLayoutMetrics.columnPadding == 16)
    }

    @Test("Minimum window width prioritizes Agents")
    func minimumWidthUsesCompactLayout() {
        #expect(AgentsSkillsLayoutMetrics.mode(for: 600) == .compact)
    }

    @Test("Skill rows derive source from the shared registry model")
    func skillSourcePresentation() {
        let local = skill(sourceType: "local", source: "/tmp/example")
        let git = skill(sourceType: "git", source: "https://example.com/skill.git")

        #expect(local.sourceKindLocalizationKey == "Local")
        #expect(git.sourceKindLocalizationKey == "Git")
        #expect(local.source == "/tmp/example")
        #expect(git.source == "https://example.com/skill.git")
    }

    private func skill(sourceType: String, source: String) -> Skill {
        Skill(
            skillId: "skill:\(sourceType)",
            name: "Example",
            description: "Example description",
            sourceType: sourceType,
            source: source,
            installedAt: "2026-08-19T00:00:00.000Z",
            updatedAt: "2026-08-19T00:00:00.000Z"
        )
    }
}
