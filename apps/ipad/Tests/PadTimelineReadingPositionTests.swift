import Foundation
import Testing
@testable import CorptieMobileState

@MainActor @Suite struct PadTimelineReadingPositionTests {
    @Test func positionsSurviveWorkspaceRecreationAndAreScoped() throws {
        let name = "reading-position-tests-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        let history = PadTimelineReadingPosition(followsLatest: false, entryID: "message:a", minY: -47)
        workspace.saveReadingPosition(history, serverID: "server", deviceID: "phone", sessionID: "a")
        workspace.saveReadingPosition(.init(followsLatest: true, entryID: nil, minY: 0),
            serverID: "server", deviceID: "phone", sessionID: "b")
        let restored = PadWorkspace(defaults: defaults)
        #expect(restored.readingPosition(serverID: "server", deviceID: "phone", sessionID: "a") == history)
        #expect(restored.readingPosition(serverID: "server", deviceID: "phone", sessionID: "b")?.followsLatest == true)
        #expect(restored.readingPosition(serverID: "other", deviceID: "phone", sessionID: "a") == nil)
        #expect(restored.readingPosition(serverID: "server", deviceID: "tablet", sessionID: "a") == nil)
        #expect(restored.readingPosition(serverID: "server", deviceID: "phone", sessionID: "missing") == nil)
    }

    @Test func boundedRecordsAndInvalidAnchors() throws {
        let name = "reading-position-tests-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        for index in 0..<105 {
            workspace.saveReadingPosition(.init(followsLatest: false, entryID: "m\(index)", minY: 0,
                updatedAt: Date(timeIntervalSince1970: Double(index))),
                serverID: "s", deviceID: "d", sessionID: "t\(index)")
        }
        #expect(workspace.readingPosition(serverID: "s", deviceID: "d", sessionID: "t0") == nil)
        #expect(workspace.readingPosition(serverID: "s", deviceID: "d", sessionID: "t5") != nil)
        #expect(workspace.readingPosition(serverID: "s", deviceID: "d", sessionID: "t104") != nil)
        workspace.saveReadingPosition(.init(followsLatest: false, entryID: nil, minY: .nan),
            serverID: "s", deviceID: "d", sessionID: "invalid")
        #expect(workspace.readingPosition(serverID: "s", deviceID: "d", sessionID: "invalid") == nil)
        #expect(PadTimelineReadingPosition(followsLatest: true, entryID: nil, minY: .infinity).minY == 0)
    }

    @Test func nativeResizeAndRestorationCannotBeOverriddenByInitialTailPlacement() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/CorptieMobileApp.swift"), encoding: .utf8)
        let native = try String(contentsOf: root.appendingPathComponent("Sources/PadNativeTimeline.swift"), encoding: .utf8)
        #expect(source.contains("await prepareNativeTimeline()"))
        #expect(source.contains("for _ in 0..<20"))
        #expect(source.contains("preserveSavedPosition = workspace.historyRequestCursor != nil"))
        #expect(source.contains("readingScope == scope"))
        #expect(native.contains("pendingRestore ?? (resized && !following ? resizeAnchor : nil)"))
        #expect(native.contains("offset: CGFloat(anchor.minY) - chatLayout.settings.additionalInsets.top"))
        #expect(!source.contains("timelinePosition.scrollTo"))
    }
}
