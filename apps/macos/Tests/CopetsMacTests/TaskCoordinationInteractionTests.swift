import Foundation
import Testing
@testable import CorptieMac

struct TaskCoordinationInteractionTests {
    @Test func coordinationUsesSharedControlBeforeTheCollapsedDefinition() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let shared = try String(contentsOf: root.appendingPathComponent("packages/CorptieConversation/Sources/CorptieConversation/ConversationTaskInformationCard.swift"), encoding: .utf8)
        let control = try #require(shared.range(of: "ConversationTaskCoordinationControl(enabled:"))
        let disclosure = try #require(shared.range(of: "if isExpanded {"))
        #expect(control.lowerBound < disclosure.lowerBound)
        let desktop = try String(contentsOf: root.appendingPathComponent("apps/macos/Sources/CopetsMac/WorkTasks/CorptieTaskDetailView.swift"), encoding: .utf8)
        let mobile = try String(contentsOf: root.appendingPathComponent("apps/ipad/Sources/PadInspectorResources.swift"), encoding: .utf8)
        #expect(desktop.contains("coordinationEnabled:"))
        #expect(mobile.contains("coordinationEnabled:"))
        #expect(desktop.contains("coordinationDispatches:"))
        #expect(mobile.contains("coordinationDispatches:"))
    }
}
