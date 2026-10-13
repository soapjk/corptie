import AppKit
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation

struct SessionPreparationNoticeTests {
    @Test @MainActor func localRecoveryChromeFitsPhonePadAndDesktopWithoutReplacingTimeline() {
        for width in [320.0, 768.0, 1024.0] {
            let view = NSHostingView(rootView: SessionPreparationNotice(sessionID: "session",
                api: { throw ClientConnectionError.invalidResponse }, didPrepare: {}))
            view.frame = NSRect(x: 0, y: 0, width: width, height: 100)
            view.layoutSubtreeIfNeeded()
            #expect(view.fittingSize.height.isFinite)
            #expect(view.fittingSize.height <= 100)
            #expect(view.fittingSize.width <= width)
        }
    }
}
