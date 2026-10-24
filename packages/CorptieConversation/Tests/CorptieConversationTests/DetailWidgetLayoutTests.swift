import Foundation
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit
#endif

@MainActor struct DetailWidgetLayoutTests {
    @Test func referenceSizesComposeSquaresIncludingTheirGaps() {
        let pair = DetailWidgetPlacement.make(width: 352, widgets: [.small, .small])
        #expect(pair.frames == [CGRect(x: 0, y: 0, width: 170, height: 170), CGRect(x: 182, y: 0, width: 170, height: 170)])
        let expected: [DetailWidgetSize: CGSize] = [
            .small: CGSize(width: 170, height: 170), .medium: CGSize(width: 352, height: 170),
            .large: CGSize(width: 352, height: 352), .tall: CGSize(width: 170, height: 352),
            .extraLarge: CGSize(width: 352, height: 534)
        ]
        for size in DetailWidgetSize.allCases {
            #expect(DetailWidgetPlacement.make(width: 352, widgets: [size]).frames[0].size == expected[size])
        }
        #expect(ConversationDetailWidgetMetrics.railWidth == 376)
    }

    @Test func mixedCardsKeepOrderAndNeverOverlapOrEscapeTheRail() {
        let sizes: [DetailWidgetSize] = [.tall, .small, .small, .medium, .large, .small, .extraLarge]
        for width in [240.0, 292, 320, 352, 480] {
            let plan = DetailWidgetPlacement.make(width: width, widgets: sizes)
            #expect(plan.frames.count == sizes.count)
            for (index, frame) in plan.frames.enumerated() {
                #expect(frame.minX >= 0 && frame.maxX <= width + 0.01)
                #expect(frame.width > 0 && frame.height > 0 && frame.maxY <= plan.size.height)
                for next in plan.frames.dropFirst(index + 1) { #expect(!frame.intersects(next)) }
            }
            #expect(plan.frames.map(\.minY) == plan.frames.map(\.minY).sorted())
            #expect(plan == DetailWidgetPlacement.make(width: width, widgets: sizes))
        }
        #expect(DetailWidgetPlacement.make(width: .infinity, widgets: [.small]).size.width.isFinite)
        #expect(DetailWidgetPlacement.make(width: 0, widgets: []).size.height == 0)
    }

    @Test func contentGrowthAndPaginationSelectLargerSizesWithoutTextMeasurement() throws {
        for (length, size) in [(30, DetailWidgetSize.small), (100, .medium), (400, .large), (1600, .extraLarge)] {
            let card = try decode(kind: "chatSummary", data: ["text": String(repeating: "文", count: length)])
            #expect(DetailWidgetSizing.preferredSize(for: card) == size)
        }
        let reference: [String: Any] = ["referenceId": "ref", "title": "引用", "targetType": "web", "status": "available", "enabled": true]
        #expect(DetailWidgetSizing.preferredSize(for: try decode(kind: "contextReferences", data: ["items": [reference], "hasMore": false])) == .small)
        #expect(DetailWidgetSizing.preferredSize(for: try decode(kind: "contextReferences", data: ["items": [reference, reference], "hasMore": false])) == .tall)
        #expect(DetailWidgetSizing.preferredSize(for: try decode(kind: "contextReferences", data: ["items": [reference], "hasMore": true])) == .extraLarge)
    }

    #if os(macOS)
    @Test func hostedCardsHonorTheirCellsAndKeepOverflowScrollableAfterResize() async throws {
        let sizes: [DetailWidgetSize] = [.small, .small, .medium, .large, .tall, .small, .extraLarge]
        let rows = ForEach(sizes.indices, id: \.self) { index in
                    ConversationDetailModuleCard(title: "组件 \(index)", systemImage: "square.grid.2x2") {
                        ForEach(0..<20) { row in Text("\(row) 记忆内容").font(.caption) }
                        Button("最后一个操作") {}
                    }.detailWidget(sizes[index])
        }
        let host = NSHostingView(rootView: ConversationDetailDashboard {
            if #available(macOS 27.0, *) {
                DetailWidgetLayout(sizes: sizes) { rows.reorderable() }
                    .reorderContainer(for: Int.self, itemID: \.self, isEnabled: true) { _ in }
            } else {
                DetailWidgetLayout(sizes: sizes) { rows }
            }
        })
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 376, height: 800), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.contentView = nil; window.close() }
        func cards(_ view: NSView) -> [DetailCardProbe.View] {
            if let card = view as? DetailCardProbe.View { return [card] }
            return view.subviews.flatMap(cards)
        }
        func scrolls(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrolls)
        }
        for width in [376.0, 320, 264, 376] {
            window.setContentSize(CGSize(width: width, height: 800))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
            let found = cards(host)
            let plan = DetailWidgetPlacement.make(width: width - 24, widgets: sizes)
            #expect(found.count == sizes.count)
            for (index, card) in found.enumerated() { #expect(card.bounds.size == plan.frames[index].size) }
        }
        let inner = scrolls(host).flatMap { outer in outer.documentView.map(scrolls) ?? [] }
        #expect(!inner.isEmpty)
        #expect(inner.contains { ($0.documentView?.bounds.height ?? 0) > $0.contentView.bounds.height })
    }
    #endif

    private func decode(kind: String, data: [String: Any]) throws -> ClientDetailBusinessCard {
        let object: [String: Any] = ["id": kind, "kind": kind, "version": 1, "revision": "1", "loadState": "ready", "data": data, "actions": []]
        return try JSONDecoder().decode(ClientDetailBusinessCard.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
