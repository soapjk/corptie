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
}
