import AppKit
import SwiftUI
import CorptieConversation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct AdaptiveConversationColumnsTests {
    @MainActor private final class Visibility: ObservableObject {
        @Published var isVisible = false
    }

    private struct HeaderLayoutHarness: View {
        @ObservedObject var visibility: Visibility
        let header: NSView
        let transcript: NSView
        let inspector: NSView
        var body: some View {
            AdaptiveConversationColumns(isVisible: $visibility.isVisible) {
                NativeProbe(view: transcript)
            } detail: {
                NativeProbe(view: inspector)
            } header: {
                NativeProbe(view: header).frame(height: 64)
            }
        }
    }

    @MainActor @Test
    func inspectorToggleKeepsHeaderFullWidthAndRailBelowControls() async throws {
        let visibility = Visibility()
        let header = NSView(), transcript = NSView(), inspector = NSView()
        let host = NSHostingView(rootView: HeaderLayoutHarness(visibility: visibility,
            header: header, transcript: transcript, inspector: inspector))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 700),
            styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        // Layout only: never present the test window or inspect screen pixels.
        for width: CGFloat in [1400, 900, 1400] {
            window.setContentSize(NSSize(width: width, height: 700))
            var previousHeader: NSRect?
            for visible in [false, true, false] {
                visibility.isVisible = visible
                try await Task.sleep(for: .milliseconds(260))
                host.layoutSubtreeIfNeeded()
                let headerFrame = header.convert(header.bounds, to: host)
                let transcriptFrame = transcript.convert(transcript.bounds, to: host)
                #expect(abs(headerFrame.width - width) < 2)
                #expect(abs(headerFrame.height - 64) < 2)
                if let previousHeader { #expect(headerFrame == previousHeader) }
                previousHeader = headerFrame
                #expect(transcriptFrame.width > 0)
                #expect(transcriptFrame.width <= width)
                #expect(!headerFrame.intersects(transcriptFrame.insetBy(dx: 1, dy: 1)))
                if visible && inspector.window === window {
                    let railFrame = inspector.convert(inspector.bounds, to: host)
                    #expect(!headerFrame.intersects(railFrame.insetBy(dx: 1, dy: 1)))
                    #expect(abs(railFrame.height - transcriptFrame.height) < 2)
                }
                #expect(transcript.window === window)
            }
        }
    }

    private struct NativeProbe: NSViewRepresentable {
        let view: NSView
        func makeNSView(context: Context) -> NSView { view }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }

    @MainActor @Test
    func systemInspectorKeepsTranscriptMountedAcrossWindowResizes() async throws {
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
            #expect(transcript.frame.width > 0)
            #expect(transcript.frame.width <= width)
            #expect(transcript.window === window, "Resizing must keep the editor's native view mounted")
            if inspector.window === window { #expect(abs(inspector.frame.width - ConversationDetailWidgetMetrics.railWidth) < 2) }
        }
    }
}
