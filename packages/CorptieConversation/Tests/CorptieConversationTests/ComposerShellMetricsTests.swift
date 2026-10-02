import Testing
import Foundation
import CorptieClientCore
#if os(macOS)
import AppKit
import SwiftUI
#endif
@testable import CorptieConversation

@Suite("Shared composer input height")
struct ComposerShellMetricsTests {
    @Test func recommendationsDecodeTheSharedVersionedContract() throws {
        let data = Data(#"{"schemaVersion":1,"taskId":"task:a","items":[{"id":"a","text":"继续","scope":"task","count":3}]}"#.utf8)
        let value = try JSONDecoder().decode(ClientQuickMessageRecommendations.self, from: data)
        #expect(value.taskId == "task:a")
        #expect(value.items.first?.text == "继续")
        #expect(value.items.first?.count == 3)
    }

    #if os(macOS)
    @Test @MainActor func quickMessageRowStaysCompactWhenViewportIsTall() {
        let host = NSHostingView(rootView: ConversationQuickMessages(
            items: ClientQuickMessage.defaults, enabled: true, send: { _ in }))
        host.frame = NSRect(x: 0, y: 0, width: 320, height: 600)
        host.layoutSubtreeIfNeeded()
        #expect(host.fittingSize.height == 30)
        for width in [240.0, 480.0, 320.0] {
            host.setFrameSize(NSSize(width: width, height: 600))
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.height == 30)
        }
    }
    #endif
    @Test("An empty or single-line input uses one row")
    func singleLineMinimum() {
        #expect(ComposerShellMetrics.minimumInputHeight == 30)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 0) == 30)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 28) == 30)
    }

    @Test("Wrapped content grows without exceeding the shared cap")
    func growsWithContent() {
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 30.2) == 31)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 63.2) == 64)
        #expect(ComposerShellMetrics.resolvedInputHeight(for: 140) == 96)
    }
}
