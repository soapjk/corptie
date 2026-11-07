import AppKit
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor final class ConversationRegionLayoutTests: XCTestCase {
    func testEmptyHeaderDoesNotReserveTitleHeight() throws {
        let host = NSHostingView(rootView: AdaptiveConversationColumns(isVisible: .constant(false),
            transcript: { Color.clear }, detail: { Color.clear }))
        host.frame = CGRect(x: 0, y: 0, width: 600, height: 500)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        func find(_ view: NSView) -> ConversationRegionContainer<AnyView, AnyView>? {
            (view as? ConversationRegionContainer<AnyView, AnyView>) ?? view.subviews.lazy.compactMap(find).first
        }
        let region = try XCTUnwrap(find(host))
        XCTAssertEqual(region.accessory.frame.height, 0, accuracy: 0.5)
    }
    func testHeaderKeepsTopEdgeAcrossContainerResize() {
        let view = ConversationRegionContainer(content: Color.clear, accessory: Text("Title"), atTop: true, height: 64)
        for size in [CGSize(width: 800, height: 600), CGSize(width: 500, height: 400), CGSize(width: 900, height: 720)] {
            view.frame.size = size
            view.layoutSubtreeIfNeeded()
            XCTAssertEqual(view.accessory.frame.maxY, view.bounds.maxY, accuracy: 0.5)
            XCTAssertEqual(view.accessory.frame.height, 64, accuracy: 0.5)
            XCTAssertEqual(view.content.frame.maxY, view.accessory.frame.minY, accuracy: 0.5)
        }
    }
    func testInputGrowthOnlyShrinksMessageViewport() {
        let view = ConversationRegionContainer(content: Color.clear, accessory: Color.clear.frame(height: 40), atTop: false, height: nil)
        view.frame.size = CGSize(width: 700, height: 500)
        view.layoutSubtreeIfNeeded()
        let old = view.content.frame.height
        view.accessory.rootView = Color.clear.frame(height: 90)
        view.accessory.invalidateIntrinsicContentSize()
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.accessory.frame.minY, view.bounds.minY, accuracy: 0.5)
        XCTAssertEqual(view.content.frame.maxY, view.bounds.maxY, accuracy: 0.5)
        XCTAssertEqual(old - view.content.frame.height, 50, accuracy: 0.5)
    }
    func testQuickMessagesOverlapViewportWhileRemainingInInputHost() {
        // 34pt quick actions + 66pt editor share the same accessory host.
        let view = ConversationRegionContainer(content: Color.clear,
            accessory: Color.clear.frame(height: 100), atTop: false, height: nil, overlap: 34)
        for size in [CGSize(width: 700, height: 500), CGSize(width: 540, height: 380)] {
            view.frame.size = size
            view.layoutSubtreeIfNeeded()
            XCTAssertEqual(view.accessory.frame.height, 100, accuracy: 0.5)
            XCTAssertEqual(view.content.frame.minY, view.accessory.frame.maxY - 34, accuracy: 0.5)
            XCTAssertEqual(view.content.frame.intersection(view.accessory.frame).height, 34, accuracy: 0.5)
            XCTAssertTrue(view.subviews.last === view.accessory, "Quick actions receive clicks above messages")
        }
        // A pinned checklist uses normal stacking, with the same two hosts.
        view.setAccessoryOverlap(0)
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.content.frame.minY, view.accessory.frame.maxY, accuracy: 0.5)
    }
    private final class Marker: ObservableObject { }
    private struct EnvironmentProbe: View {
        @EnvironmentObject var marker: Marker
        @Environment(\.locale) var locale
        let report: (Marker, String) -> Void
        var body: some View {
            Color.clear.onAppear { report(marker, locale.identifier) }
        }
    }
    func testBothHostsInheritEnvironmentAndSharedObjects() {
        let marker = Marker()
        var received: [Marker] = []
        var locales: [String] = []
        let probe = { EnvironmentProbe { received.append($0); locales.append($1) } }
        let host = NSHostingView(rootView: ConversationRegionStack(accessoryAtTop: true, accessoryHeight: 64,
            content: probe, accessory: probe).environmentObject(marker).environment(\.locale, Locale(identifier: "zh_CN")))
        host.frame = CGRect(x: 0, y: 0, width: 600, height: 500)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(received.count, 2)
        XCTAssertTrue(received.allSatisfy { $0 === marker })
        XCTAssertEqual(locales, ["zh_CN", "zh_CN"])
    }

    private struct DockMarker: NSViewRepresentable {
        let name: String
        func makeNSView(context: Context) -> NSView {
            let view = NSView()
            view.identifier = .init(name)
            return view
        }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }

    private struct DockFixture: View {
        let showsQuickMessages: Bool
        let editorHeight: CGFloat
        var body: some View {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                ConversationComposerDock {
                    if showsQuickMessages { DockMarker(name: "quick").frame(height: 28) }
                } composer: {
                    DockMarker(name: "editor").frame(height: editorHeight)
                }
            }
        }
    }

    func testQuickMessagesAndEditorShareFixedBottomLayout() throws {
        let host = NSHostingView(rootView: DockFixture(showsQuickMessages: true, editorHeight: 80))
        func marker(_ name: String, in view: NSView) -> NSView? {
            if view.identifier?.rawValue == name { return view }
            return view.subviews.lazy.compactMap { marker(name, in: $0) }.first
        }
        var editor: NSView?
        for (height, editorHeight, showsQuick) in [(400.0, 80.0, true), (700.0, 80.0, true),
                                                  (500.0, 150.0, true), (600.0, 80.0, false),
                                                  (400.0, 80.0, true)] {
            host.rootView = DockFixture(showsQuickMessages: showsQuick, editorHeight: editorHeight)
            host.frame = .init(x: 0, y: 0, width: 600, height: height)
            host.layoutSubtreeIfNeeded()
            let current = try XCTUnwrap(marker("editor", in: host))
            if let editor { XCTAssertTrue(current === editor, "Quick-action visibility must retain the editor") }
            else { editor = current }
            let frame = current.convert(current.bounds, to: host)
            let bottom = host.isFlipped ? host.bounds.maxY - frame.maxY : frame.minY
            XCTAssertEqual(bottom, 4, accuracy: 0.5)
            if showsQuick {
                let quick = try XCTUnwrap(marker("quick", in: host))
                let quickFrame = quick.convert(quick.bounds, to: host)
                let gap = host.isFlipped ? frame.minY - quickFrame.maxY : quickFrame.minY - frame.maxY
                XCTAssertEqual(gap, 4, accuracy: 0.5)
            } else { XCTAssertNil(marker("quick", in: host)) }
        }
    }
}
