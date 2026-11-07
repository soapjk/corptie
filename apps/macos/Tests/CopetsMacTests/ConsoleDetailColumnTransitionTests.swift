import AppKit
import SwiftUI
import CorptieConversation
import XCTest
@testable import CorptieMac

@MainActor
final class ConsoleDetailColumnTransitionTests: XCTestCase {
    private final class State: ObservableObject {
        @Published var visible = true
    }
    private final class WidthProbe: NSView {
        var creations = 0
        var widths: [CGFloat] = []
        override func setFrameSize(_ newSize: NSSize) {
            super.setFrameSize(newSize)
            if widths.last != newSize.width { widths.append(newSize.width) }
        }
    }
    private struct Probe: NSViewRepresentable {
        let view: WidthProbe
        func makeNSView(context: Context) -> WidthProbe {
            view.creations += 1
            return view
        }
        func updateNSView(_ nsView: WidthProbe, context: Context) {}
    }
    private struct Surface: View {
        @ObservedObject var state: State
        let chat: WidthProbe
        let rail: WidthProbe
        var body: some View {
            AdaptiveConversationColumns(isVisible: $state.visible) {
                Probe(view: chat).frame(maxWidth: .infinity, maxHeight: .infinity)
            } detail: {
                Probe(view: rail).frame(maxHeight: .infinity)
            }
            .environment(\.conversationSkin, .codexFlat)
        }
    }

    private func harness() async throws -> (NSWindow, State, WidthProbe, WidthProbe) {
        _ = NSApplication.shared
        let state = State(), chat = WidthProbe(), rail = WidthProbe()
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 900, height: 400),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Surface(state: state, chat: chat, rail: rail))
        window.layoutIfNeeded()
        addTeardownBlock { @MainActor in window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(350))
        window.layoutIfNeeded()
        chat.widths.removeAll()
        return (window, state, chat, rail)
    }

    func testDetailOverlayToggleKeepsTranscriptIdentityAndWidth() async throws {
        let (window, state, chat, _) = try await harness()
        for visible in [false, true, false, true] {
            state.visible = visible
            try await Task.sleep(for: .milliseconds(300))
            window.layoutIfNeeded()
            XCTAssertTrue(chat.window === window)
            XCTAssertEqual(chat.frame.width, 900, accuracy: 1)
            XCTAssertEqual(chat.creations, 1)
        }
    }

    func testRapidToggleEndsInRequestedStateWithoutReplacingTranscript() async throws {
        let (window, state, chat, _) = try await harness()
        state.visible = false
        try await Task.sleep(for: .milliseconds(50))
        state.visible = true
        try await Task.sleep(for: .milliseconds(300))
        window.layoutIfNeeded()
        XCTAssertTrue(state.visible)
        XCTAssertEqual(chat.creations, 1)
        XCTAssertTrue(chat.window === window)
    }
}
