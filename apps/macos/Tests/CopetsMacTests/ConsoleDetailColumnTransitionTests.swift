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
            HStack(spacing: 0) {
                Probe(view: chat).frame(maxWidth: .infinity, maxHeight: .infinity)
                Probe(view: rail).frame(maxHeight: .infinity)
                    .modifier(ConsoleDetailColumnVisibility(isVisible: state.visible))
            }
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
        try await Task.sleep(for: .milliseconds(60))
        window.layoutIfNeeded()
        chat.widths.removeAll()
        return (window, state, chat, rail)
    }

    func testExitKeepsChatWidthUntilSlideEndsAndRetainsBothViews() async throws {
        let (window, state, chat, rail) = try await harness()
        let initial = chat.frame.width
        state.visible = false
        try await Task.sleep(for: .milliseconds(60))
        window.layoutIfNeeded()
        XCTAssertEqual(chat.frame.width, initial, accuracy: 1)
        try await Task.sleep(for: .milliseconds(220))
        window.layoutIfNeeded()
        XCTAssertEqual(chat.frame.width, initial + ConversationDetailWidgetMetrics.railWidth + MainWindowPageLayoutMetrics.columnSpacing, accuracy: 1)
        XCTAssertTrue(chat.widths.allSatisfy { abs($0 - initial - ConversationDetailWidgetMetrics.railWidth - MainWindowPageLayoutMetrics.columnSpacing) < 1 })
        state.visible = true
        try await Task.sleep(for: .milliseconds(60))
        window.layoutIfNeeded()
        XCTAssertEqual(chat.frame.width, initial, accuracy: 1)
        XCTAssertEqual(chat.creations, 1)
        XCTAssertEqual(rail.creations, 1)
    }

    func testRapidToggleCancelsOldCollapse() async throws {
        let (window, state, chat, rail) = try await harness()
        let initial = chat.frame.width
        state.visible = false
        try await Task.sleep(for: .milliseconds(50))
        state.visible = true
        try await Task.sleep(for: .milliseconds(260))
        window.layoutIfNeeded()
        XCTAssertEqual(chat.frame.width, initial, accuracy: 1)
        XCTAssertEqual(rail.creations, 1)
    }

}
