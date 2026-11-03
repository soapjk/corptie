import Testing

@testable import CorptieMac

@Suite("Agents and Skills management layout")
struct AgentsSkillsLayoutTests {
    @Test("Desktop width uses parallel columns")
    func desktopUsesSplitLayout() {
        #expect(RolesSkillsLayoutMetrics.mode(for: 1200) == .split)
        #expect(RolesSkillsLayoutMetrics.skillsColumnWidth == 300)
        #expect(RolesSkillsLayoutMetrics.headerHeight == 60)
        #expect(RolesSkillsLayoutMetrics.columnPadding == 16)
    }

    @Test("Minimum window width prioritizes Agents")
    func minimumWidthUsesCompactLayout() {
        #expect(RolesSkillsLayoutMetrics.mode(for: 600) == .compact)
    }

    @Test("A split layout reserves room for two complete role cards")
    func splitBoundary() {
        #expect(RolesSkillsLayoutMetrics.mode(for: 868) == .compact)
        #expect(RolesSkillsLayoutMetrics.mode(for: 869) == .split)
        #expect(RolesSkillsLayoutMetrics.gridColumnCount(for: 568) == 2)
        #expect(RolesSkillsLayoutMetrics.gridColumnCount(for: 567) == 1)
        #expect(RolesSkillsLayoutMetrics.gridColumnCount(for: 899) == 3)
        #expect(RolesSkillsLayoutMetrics.gridColumnCount(for: 420) == 1)
        #expect(RolesSkillsLayoutMetrics.gridColumnCount(for: 180) == 1)
    }

    @Test("An open Skills sheet never duplicates the inline registry")
    func effectiveSkillsVisibility() {
        #expect(
            RolesSkillsLayoutMetrics.showsInlineSkills(
                width: 1200, sidebarVisible: true, preference: true, sheetPresented: false))
        #expect(
            !RolesSkillsLayoutMetrics.showsInlineSkills(
                width: 868, sidebarVisible: true, preference: true, sheetPresented: false))
        #expect(
            !RolesSkillsLayoutMetrics.showsInlineSkills(
                width: 1200, sidebarVisible: false, preference: true, sheetPresented: false))
        #expect(
            !RolesSkillsLayoutMetrics.showsInlineSkills(
                width: 1200, sidebarVisible: true, preference: false, sheetPresented: false))
        #expect(
            !RolesSkillsLayoutMetrics.showsInlineSkills(
                width: 1200, sidebarVisible: true, preference: true, sheetPresented: true))
    }

    @Test("Management sheets fit inside a narrow and short host")
    func sheetBounds() {
        let size = RolesSkillsLayoutMetrics.sheetSize(
            in: .init(width: 600, height: 500), ideal: .init(width: 760, height: 620))
        #expect(size.width == 568)
        #expect(size.height == 452)
    }

    @Test("Skill rows derive source from the shared registry model")
    func skillSourcePresentation() {
        let local = skill(sourceType: "local", source: "/tmp/example")
        let git = skill(sourceType: "git", source: "https://example.com/skill.git")
        var remote = skill(sourceType: "url", source: "https://example.com/skill.zip")

        #expect(local.sourceKindLocalizationKey == "Local")
        #expect(git.sourceKindLocalizationKey == "Git")
        #expect(remote.sourceKindLocalizationKey == "HTTPS ZIP")
        #expect(!remote.isManaged)
        remote.installationMode = "managed"
        #expect(remote.isManaged)
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
