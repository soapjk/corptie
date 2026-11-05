import AppKit
import CorptieConversation
import SwiftUI
import XCTest

@MainActor
final class DetailTextLayoutTests: XCTestCase {
    func testOverflowProbeDoesNotExpandVisibleTextAndSettlesAfterWidthChanges() async throws {
        _ = NSApplication.shared
        let longText = String(repeating: "A long detail with 中文 and enough words to wrap. ", count: 80)
        let host = NSHostingView(rootView: ConversationDetailText(text: longText, collapsedLineLimit: 3).frame(width: 240))
        host.frame = .init(x: 0, y: 0, width: 240, height: 100)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { window.contentView = nil }
        func settledHeight() async throws -> CGFloat {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
            host.layoutSubtreeIfNeeded()
            return host.fittingSize.height
        }
        let narrow = try await settledHeight()
        XCTAssertGreaterThan(narrow, 30)
        XCTAssertLessThan(narrow, 130, "The hidden full text must not become a height owner")
        host.rootView = ConversationDetailText(text: longText, collapsedLineLimit: 3).frame(width: 560)
        let wide = try await settledHeight()
        XCTAssertLessThan(wide, 130)
        let settledWide = try await settledHeight()
        XCTAssertEqual(settledWide, wide, accuracy: 0.5, "Preference updates must settle")
        host.rootView = ConversationDetailText(text: "Short detail", collapsedLineLimit: 3).frame(width: 240)
        let short = try await settledHeight()
        XCTAssertLessThan(short, narrow, "A short value must not reserve an overflow action row")
    }
}
