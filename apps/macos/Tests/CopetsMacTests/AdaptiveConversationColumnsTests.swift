import AppKit
import SwiftUI
import CorptieConversation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct AdaptiveConversationColumnsTests {
    private struct NativeProbe: NSViewRepresentable {
        let view: NSView
        func makeNSView(context: Context) -> NSView { view }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }

    @MainActor @Test
    func compactInspectorPreservesReadingWidthAcrossWindowResizes() async throws {
        let transcript = NSView()
        let inspector = NSView()
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: .constant(true)) {
            NativeProbe(view: transcript)
        } detail: {
            NativeProbe(view: inspector)
                .frame(width: ConversationDetailWidgetMetrics.railWidth)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        for width: CGFloat in [900, 1400, 900] {
            window.setContentSize(NSSize(width: width, height: 600))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
            host.layoutSubtreeIfNeeded()
            let expected = width < 1040 ? width
                : width - ConversationDetailWidgetMetrics.railWidth - MainWindowPageLayoutMetrics.columnSpacing
            #expect(abs(transcript.frame.width - expected) < 2)
            #expect(transcript.window === window, "Resizing must keep the editor's native view mounted")
            #expect(abs(inspector.frame.width - ConversationDetailWidgetMetrics.railWidth) < 2)
        }
    }
}
