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

    @Test("Skills column retains its existing split boundary")
    func splitBoundary() {
        #expect(RolesSkillsLayoutMetrics.mode(for: 868) == .compact)
        #expect(RolesSkillsLayoutMetrics.mode(for: 869) == .split)
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

    @Test("Native flow keeps compact cards square and moves neighbors around an expanded card")
    func cardsReflow() throws {
        _ = NSApplication.shared
        for width in [280.0, 568.0, 1080.0] {
            for expanded in [false, true] {
                let host = NSHostingView(rootView: RoleCardFlowLayout() {
                    RoleColumnLayoutProbe(name: "first").frame(width: 136, height: 136)
                    RoleColumnLayoutProbe(name: "selected")
                        .frame(width: expanded ? min(600, width) : 136, height: expanded ? 340 : 136)
                    RoleColumnLayoutProbe(name: "last").frame(width: 136, height: 136)
                })
                host.sizingOptions = []
                host.frame = CGRect(x: 0, y: 0, width: width, height: 1000)
                host.layoutSubtreeIfNeeded()
                let frames = try ["first", "selected", "last"].map { name in
                    let view = try #require(probe(name, in: host))
                    return view.convert(view.bounds, to: host)
                }
                for rect in frames { #expect(rect.minX >= 0 && rect.maxX <= width + 1) }
                #expect(frames[0].size == CGSize(width: 136, height: 136))
                #expect(frames[2].size == CGSize(width: 136, height: 136))
                for i in frames.indices {
                    for j in frames.indices where j > i { #expect(!frames[i].intersects(frames[j])) }
                }
            }
        }
    }

    @Test("Long role names and descriptions do not enlarge the compact card")
    func compactCardBounds() throws {
        let role = Role(roleId: "role:long", name: String(repeating: "长名称", count: 20),
            description: String(repeating: "完整描述用于检查截断。", count: 60), status: "available",
            systemPrompt: "", capabilities: ["long capability"], createdAt: "", updatedAt: "")
        let host = NSHostingView(rootView: CompactRoleCardProbe(role: role))
        #expect(host.fittingSize == CGSize(width: 136, height: 136))
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

private struct CompactRoleCardProbe: View {
    let role: Role
    @FocusState private var focused: String?
    var body: some View {
        RoleCard(agent: role, focusedRoleID: $focused, onOpenDetail: {}, onStartSession: {})
    }
}
