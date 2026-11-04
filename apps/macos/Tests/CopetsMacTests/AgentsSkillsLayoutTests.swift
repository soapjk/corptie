import AppKit
import SwiftUI
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

@MainActor
@Suite("Role page window-filling columns", .serialized)
struct RolePageColumnsTests {
    @Test("Both panes keep the full available height while the window is resized")
    func panesFollowTheViewport() throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: RolePageColumns(showsSkills: true, topInset: 32) {
            RoleColumnLayoutProbe(name: "roles").frame(maxWidth: .infinity, maxHeight: .infinity)
        } skills: {
            RoleColumnLayoutProbe(name: "skills").frame(maxWidth: .infinity, maxHeight: .infinity)
        })
        host.sizingOptions = []
        for size in [CGSize(width: 1200, height: 900), CGSize(width: 869, height: 620),
                     CGSize(width: 1480, height: 1100), CGSize(width: 1000, height: 620)] {
            host.frame = CGRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            let roles = try #require(probe("roles", in: host))
            let skills = try #require(probe("skills", in: host))
            let roleFrame = roles.convert(roles.bounds, to: host)
            let skillFrame = skills.convert(skills.bounds, to: host)
            #expect(abs(roleFrame.width - (size.width - 301)) <= 1)
            #expect(abs(skillFrame.width - 300) <= 1)
            #expect(abs(roleFrame.height - (size.height - 32)) <= 1)
            #expect(abs(skillFrame.height - roleFrame.height) <= 1)
            #expect(abs(skillFrame.maxX - size.width) <= 1)
            #expect(abs(topDistance(roleFrame, in: host) - 32) <= 1)
            #expect(abs(topDistance(skillFrame, in: host) - 32) <= 1)
            print("role columns viewport=\(size) main=\(roleFrame) skills=\(skillFrame)")
        }
    }

    @Test("Short content stays at the top and both column backgrounds remain opaque to the bottom")
    func shortContentDoesNotShrinkTheCanvas() throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: RolePageColumns(showsSkills: true, topInset: 32) {
            RoleColumnLayoutProbe(name: "roles").frame(height: 20)
        } skills: {
            RoleColumnLayoutProbe(name: "skills").frame(height: 20)
        })
        host.sizingOptions = []
        host.frame = CGRect(x: 0, y: 0, width: 1200, height: 900)
        host.layoutSubtreeIfNeeded()
        for name in ["roles", "skills"] {
            let marker = try #require(probe(name, in: host))
            let rect = marker.convert(marker.bounds, to: host)
            #expect(abs(rect.height - 20) <= 1)
            #expect(abs(topDistance(rect, in: host) - 32) <= 1)
        }
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        for point in [(20, 2), (20, bitmap.pixelsHigh - 3),
                      (bitmap.pixelsWide - 20, 2), (bitmap.pixelsWide - 20, bitmap.pixelsHigh - 3)] {
            let color = try #require(bitmap.colorAt(x: point.0, y: point.1))
            #expect(color.alphaComponent >= 0.99)
        }
    }

    @Test("Compact mode removes only the auxiliary column and leaves the primary viewport full sized")
    func compactColumnUsesAllAvailableSpace() throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: RolePageColumns(showsSkills: false, topInset: 32) {
            RoleColumnLayoutProbe(name: "roles").frame(maxWidth: .infinity, maxHeight: .infinity)
        } skills: {
            RoleColumnLayoutProbe(name: "skills")
        })
        host.sizingOptions = []
        host.frame = CGRect(x: 0, y: 0, width: 600, height: 620)
        host.layoutSubtreeIfNeeded()
        let marker = try #require(probe("roles", in: host))
        let rect = marker.convert(marker.bounds, to: host)
        #expect(abs(rect.width - 600) <= 1)
        #expect(abs(rect.height - 588) <= 1)
        #expect(probe("skills", in: host) == nil)
    }

    private func topDistance(_ rect: CGRect, in host: NSView) -> CGFloat {
        host.isFlipped ? rect.minY : host.bounds.height - rect.maxY
    }

    private func probe(_ name: String, in view: NSView) -> NSView? {
        if view.identifier?.rawValue == name { return view }
        return view.subviews.lazy.compactMap { probe(name, in: $0) }.first
    }
}

private struct RoleColumnLayoutProbe: NSViewRepresentable {
    let name: String
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.identifier = NSUserInterfaceItemIdentifier(name)
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
