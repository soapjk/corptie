#if os(macOS)
import AppKit
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor @Suite(.serialized)
struct CoordinationSummaryCardTests {
    private let report = "整体尚不可验收。主开发集中验证存在失败，修复后需要完成最后验证。\n\n"
        + String(repeating: "H2独立成果保留可交付结论，H1仍需继续推进。完整证据保留在报告中。\n\n", count: 8)
        + "这是报告最后一段，展开后应完整可读。"

    private func event() throws -> ConversationCoordinationEvent {
        try JSONDecoder().decode(ConversationCoordinationEvent.self, from: Data(#"{"kind":"decision"}"#.utf8))
    }

    @Test func previewIsBoundedButExpandedReportUsesItsFullNaturalHeight() throws {
        for width: CGFloat in [240, 780] {
            let folded = NSHostingView(rootView: CoordinationSummaryCard(event: try event(), text: report, expanded: false)
                .frame(width: width))
            let full = NSHostingView(rootView: CoordinationSummaryCard(event: try event(), text: report, expanded: true)
                .frame(width: width))
            let short = NSHostingView(rootView: CoordinationSummaryCard(event: try event(), text: "报告已完成。")
                .frame(width: width))
            #expect(folded.fittingSize.height < 240)
            #expect(full.fittingSize.height > folded.fittingSize.height + 100)
            #expect(short.fittingSize.height < folded.fittingSize.height)
        }
    }

    @Test func footerMouseClickExpandsAndCollapsesUsingLocalState() async throws {
        try await exercise(CoordinationSummaryCard(event: event(), text: report).frame(width: 480))
    }

    @Test func footerMouseClickAlsoUpdatesAnExternallyOwnedExpansionState() async throws {
        let calls = Calls()
        try await exercise(ControlledCard(event: event(), text: report, calls: calls).frame(width: 480))
        #expect(calls.count == 2)
    }

    private func exercise<Content: View>(_ content: Content) async throws {
        let host = NSHostingView(rootView: content)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: host.fittingSize.height),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(60))
        let collapsedHeight = host.fittingSize.height
        try clickFooter(host, window: window)
        try await Task.sleep(for: .milliseconds(60))
        let expandedHeight = host.fittingSize.height
        #expect(expandedHeight > collapsedHeight + 100)
        // The native timeline also resizes the existing host after disclosure.
        window.setContentSize(.init(width: 480, height: expandedHeight))
        host.layoutSubtreeIfNeeded()
        try clickFooter(host, window: window)
        try await Task.sleep(for: .milliseconds(60))
        #expect(abs(host.fittingSize.height - collapsedHeight) <= 1)
        #expect(window.childWindows?.isEmpty != false)
    }

    private func clickFooter<Content: View>(_ host: NSHostingView<Content>, window: NSWindow) throws {
        let point = NSPoint(x: 24, y: host.isFlipped ? host.bounds.height - 22 : 22)
        let location = host.convert(point, to: nil)
        for (number, type) in [NSEvent.EventType.leftMouseDown, .leftMouseUp].enumerated() {
            let event = try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: number, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
    }

    private final class Calls { var count = 0 }
    private struct ControlledCard: View {
        let event: ConversationCoordinationEvent
        let text: String
        let calls: Calls
        @State private var expanded = false
        var body: some View {
            CoordinationSummaryCard(event: event, text: text, expanded: expanded, toggle: {
                expanded.toggle(); calls.count += 1
            })
        }
    }
}
#endif
