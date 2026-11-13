import Foundation
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit
#endif

@MainActor struct DetailWidgetLayoutTests {
    private final class MeasureCounts { var measurements = 0 }
    private struct ExpensiveContent: Layout {
        let counts: MeasureCounts
        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
            counts.measurements += 1
            return CGSize(width: proposal.width ?? 100, height: 10_000)
        }
        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {}
    }

    #if os(macOS)
    private struct FixedSlot: NSViewRepresentable {
        let index: Int
        func makeNSView(context: Context) -> NSView {
            let view = NSView(); view.identifier = .init("fixed-slot-\(index)"); return view
        }
        func updateNSView(_ view: NSView, context: Context) {}
    }
    @Test func fixedDesktopGeometrySurvivesWidthAndHeightProposals() async throws {
        let host = NSHostingView(rootView: ScrollView {
            DetailWidgetLayout(sizes: [.small, .small, .medium], fixedWidth: 300) {
                ForEach(0..<3) { FixedSlot(index: $0) }
            }.frame(width: 300).frame(maxWidth: .infinity, alignment: .leading)
        })
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 324, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { window.contentView = nil; window.close() }
        func slots(_ view: NSView) -> [NSView] {
            if view.identifier?.rawValue.hasPrefix("fixed-slot-") == true { return [view] }
            return view.subviews.flatMap(slots)
        }
        var initial: [CGRect]?
        for size in [CGSize(width: 324, height: 500), .init(width: 600, height: 300),
                     .init(width: 260, height: 700), .init(width: 324, height: 400)] {
            window.setContentSize(size); window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
            let cells = slots(host).sorted { $0.identifier!.rawValue < $1.identifier!.rawValue }
            #expect(cells.count == 3)
            let frames = cells.map { $0.convert($0.bounds, to: host) }
            #expect(frames.map(\.size) == [CGSize(width: 144, height: 144), .init(width: 144, height: 144), .init(width: 300, height: 144)])
            if let initial { #expect(frames == initial, "Viewport changes must not move or resize fixed cards") }
            else { initial = frames }
        }
    }

    @Test func naturalProviderDoesNotProbeOtherCardsScrollingContent() {
        let counts = MeasureCounts()
        let host = NSHostingView(rootView: DetailWidgetLayout(sizes: [.medium, .small], naturalHeightIndices: [0]) {
            Color.clear.frame(height: 189)
            DetailWidgetViewport(size: .small) { ExpensiveContent(counts: counts) { Color.clear } }
        })
        for _ in 0..<100 { _ = host.fittingSize }
        #expect(counts.measurements == 0)
    }

    @Test func viewportIdealSizeProbesDoNotMeasureScrollingContent() {
        let counts = MeasureCounts()
        let host = NSHostingView(rootView: DetailWidgetViewport(size: .small) {
            ExpensiveContent(counts: counts) { Color.clear }
        })
        // AppKit/SwiftUI ideal-size probes happen before actual placement.
        for _ in 0..<100 {
            let size = host.fittingSize
            #expect(size.width == 144 && size.height == 144)
        }
        #expect(counts.measurements == 0)
    }
    #endif

    @Test func referenceSizesComposeSquaresIncludingTheirGaps() {
        let pair = DetailWidgetPlacement.make(width: 300, widgets: [.small, .small])
        #expect(pair.frames == [CGRect(x: 0, y: 0, width: 144, height: 144), CGRect(x: 156, y: 0, width: 144, height: 144)])
        let expected: [(DetailWidgetSize, CGSize)] = [
            (.strip, CGSize(width: 300, height: 84)), (.small, CGSize(width: 144, height: 144)), (.medium, CGSize(width: 300, height: 144)),
            (.large, CGSize(width: 300, height: 300)), (.tall, CGSize(width: 144, height: 300)),
            (.extraLarge, CGSize(width: 300, height: 456))
        ]
        for size in DetailWidgetSize.allCases {
            #expect(DetailWidgetPlacement.make(width: 300, widgets: [size]).frames[0].size == expected.first { $0.0 == size }?.1)
        }
        #expect(ConversationDetailWidgetMetrics.railWidth == 324)
    }

    @Test func mixedCardsKeepOrderAndNeverOverlapOrEscapeTheRail() {
        let sizes: [DetailWidgetSize] = [.strip, .tall, .small, .small, .medium, .large, .small, .extraLarge]
        for width in [1.0, 240, 292, 300, 352, 480] {
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

    @Test func providerUsesAvailableRowWithoutAnEmptyHalf() throws {
        let provider = try decode(kind: "provider", data: ["providerId": "test", "name": "Provider", "model": "model", "reasoning": "high", "switching": false, "providers": []])
        let size = DetailWidgetSizing.preferredSize(for: provider)
        for width: CGFloat in [260, 300, 390, 600] {
            let plan = DetailWidgetPlacement.make(width: width, widgets: [.strip, size, .medium])
            #expect(plan.frames[1].width == width)
            #expect(plan.frames[1].minX == 0)
            #expect(plan.frames[2].minY == plan.frames[1].maxY + 12)
        }
    }

    @Test func naturalProviderReservesContentHeightWithoutChangingOtherCells() {
        for width: CGFloat in [220, 300, 390] {
            for height: CGFloat in [189, 251.5, 430] {
                let plan = DetailWidgetPlacement.make(width: width, widgets: [.strip, .medium, .small, .small], naturalHeights: [1: height])
                #expect(plan.frames[0].height == DetailWidgetSize.strip.height)
                #expect(plan.frames[1].height == height)
                #expect(plan.frames[1].width == width)
                #expect(plan.frames[2].height == DetailWidgetSize.small.height)
                let gap = plan.frames[2].minY - plan.frames[1].maxY
                #expect(gap >= 12 && gap < 24)
                for (index, frame) in plan.frames.enumerated() {
                    for other in plan.frames.dropFirst(index + 1) { #expect(!frame.intersects(other)) }
                }
            }
        }
        let defaults = DetailWidgetPlacement.make(width: 300, widgets: [.medium, .small])
        for invalid: CGFloat in [0, -1, .infinity, .nan] {
            #expect(DetailWidgetPlacement.make(width: 300, widgets: [.medium, .small], naturalHeights: [0: invalid]) == defaults)
        }
    }

    @Test func shortCardsUseTwelvePointHeightSteps() {
        #expect(DetailWidgetSize.fitted(height: 1).height == 60)
        #expect(DetailWidgetSize.fitted(height: 61).height == 72)
        #expect(DetailWidgetSize.fitted(height: 73).height == 84)
        let sizes = [60, 72, 84, 96, 108].map { DetailWidgetSize.fitted(height: $0) }
        let plan = DetailWidgetPlacement.make(width: 300, widgets: sizes)
        #expect(plan.frames.map(\.height) == [60, 72, 84, 96, 108])
        for pair in zip(plan.frames, plan.frames.dropFirst()) {
            #expect(pair.1.minY - pair.0.maxY == 12)
        }
    }

    @Test func visiblePreviewGrowthAndPaginationAvoidOversizedCells() throws {
        for (length, size) in [(30, DetailWidgetSize.fitted(height: 96)), (100, .fitted(height: 108)), (400, .fitted(height: 108)), (1600, .fitted(height: 108))] {
            let card = try decode(kind: "chatSummary", data: ["text": String(repeating: "文", count: length)])
            #expect(DetailWidgetSizing.preferredSize(for: card) == size)
        }
        let reference: [String: Any] = ["referenceId": "ref", "title": "引用", "targetType": "web", "status": "available", "enabled": true]
        #expect(DetailWidgetSizing.preferredSize(for: try decode(kind: "contextReferences", data: ["items": [reference], "hasMore": false])) == .fitted(height: 108))
        #expect(DetailWidgetSizing.preferredSize(for: try decode(kind: "contextReferences", data: ["items": [reference, reference], "hasMore": false])) == .fitted(height: 156))
        #expect(DetailWidgetSizing.preferredSize(for: try decode(kind: "contextReferences", data: ["items": [reference], "hasMore": true])) == .fitted(height: 108))
    }

    #if os(macOS)
    @Test func firstCardStartsWithinFourPointsOfDetailViewport() async throws {
        let size = DetailWidgetSize.fitted(height: 72)
        let host = NSHostingView(rootView: ConversationDetailDashboard {
            DetailWidgetLayout(sizes: [size]) {
                ConversationDetailModuleCard(title: "详情", systemImage: "info.circle") { Text("短内容") }.detailWidget(size)
            }
        })
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 324, height: 400),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.setFrameOrigin(NSPoint(x: -10000, y: -10000)); window.orderBack(nil)
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(80))
        func first<T: NSView>(_ view: NSView, as type: T.Type) -> T? {
            if let match = view as? T { return match }
            return view.subviews.compactMap { first($0, as: type) }.first
        }
        let outer = try #require(first(host, as: NSScrollView.self))
        let card = try #require(first(host, as: DetailCardProbe.View.self))
        let clip = outer.contentView
        let frame = card.convert(card.bounds, to: clip)
        let top = clip.isFlipped ? frame.minY - clip.bounds.minY : clip.bounds.maxY - frame.maxY
        #expect(top >= 0 && top <= 4)
    }

    @Test func sessionProviderAndCollapsedContentUseCompactProfiles() throws {
        let session = try decode(kind: "sessionInfo", data: ["sessionId": "session:1", "workName": "Work"])
        #expect(DetailWidgetSizing.preferredSize(for: session) == .fitted(height: 96))
        let provider = try decode(kind: "provider", data: ["providerId": "test", "name": "Provider", "model": "Model",
            "reasoning": "Medium", "switching": false, "providers": []])
        #expect(DetailWidgetSizing.preferredSize(for: provider) == .medium)
        let memory: [String: Any] = ["memoryId": "memory:1", "kind": "fact", "content": String(repeating: "隐藏正文", count: 5000),
            "unavailable": false, "snapshotAtRecall": false]
        for more in [false, true] {
            let hit = try decode(kind: "memoryHits", data: ["items": [memory], "hasMore": more])
            #expect(DetailWidgetSizing.preferredSize(for: hit) == .fitted(height: 108))
            let artifact: [String: Any] = ["artifactId": "artifact:1", "title": "交付文档", "summary": "完成", "contentHash": "hash", "readAvailable": true]
            let artifacts = try decode(kind: "artifacts", data: ["items": [artifact], "hasMore": more])
            #expect(DetailWidgetSizing.preferredSize(for: artifacts) == .fitted(height: 96))
        }
        let summary: [String: Any] = ["state": "ready", "focus": "", "progress": "", "intervention": "none", "reason": "", "nextAction": ""]
        var task: [String: Any] = ["taskId": "task:1", "title": "Task", "status": "active", "description": "短描述",
            "acceptanceCriteria": "", "verificationCriteria": "", "resourceRevision": "1", "summary": summary]
        #expect(DetailWidgetSizing.preferredSize(for: try decode(kind: "taskInfo", data: task)) == .fitted(height: 120))
        task["description"] = String(repeating: "默认收起的长正文", count: 5000)
        #expect(DetailWidgetSizing.preferredSize(for: try decode(kind: "taskInfo", data: task)) == .fitted(height: 156))
        task["acceptanceCriteria"] = String(repeating: "验收", count: 5000)
        task["verificationCriteria"] = String(repeating: "验证", count: 5000)
        #expect(DetailWidgetSizing.preferredSize(for: try decode(kind: "taskInfo", data: task)) == .fitted(height: 264))
    }

    @Test func narrowProviderUsesNaturalHeightAndOnlyTheRailScrollOwner() async throws {
        let selection = ClientDetailConfiguration.Selection(id: "test", title: "Example Model With A Long Fully Visible Name", choices: [], canSelect: false)
        let host = NSHostingView(rootView: ConversationDetailDashboard {
            DetailWidgetLayout(sizes: [.medium], naturalHeightIndices: [0]) {
                ConversationDetailProviderCard(configuration: .init(provider: selection, model: selection, reasoning: selection),
                    scope: "test", select: { _, _ in }, reload: {}).detailWidget(.medium)
            }
        })
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 244, height: 600),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.setFrameOrigin(NSPoint(x: -10000, y: -10000)); window.orderBack(nil)
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        func scrolls(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrolls)
        }
        func probes(_ view: NSView) -> [DetailCardProbe.View] {
            (view as? DetailCardProbe.View).map { [$0] } ?? view.subviews.flatMap(probes)
        }
        #expect(scrolls(host).count == 1)
        let card = try #require(probes(host).first)
        print("PROVIDER_NARROW frame=\(card.bounds)")
        #expect(card.bounds.width == 220)
        #expect(card.bounds.height > DetailWidgetSize.medium.height)
    }

    @Test func nativeBusinessGridSettlesWhileReorderingResizingAndUpdatingContent() async throws {
        let repository = ClientDetailBusinessRepository()
        let scope = ClientDetailBusinessScope(serverID: "test", ownerID: "test", principalID: "test",
            sessionID: "session:test", taskID: nil, workID: nil)
        let handle = repository.entry(for: scope)
        let suite = "detail-grid-test-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let arrangement = ConversationDetailCardArrangement(defaults: defaults)
        let selection = ClientDetailConfiguration.Selection(id: "test", title: "Test", choices: [], canSelect: false)
        let adapters = ConversationDetailAdapters(
            configuration: .init(provider: selection, model: selection, reasoning: selection),
            selectConfiguration: { _, _ in throw ClientDetailConfigurationFailure.unavailable },
            reloadConfiguration: {}, readTurnSummary: { _ in throw ClientDetailConfigurationFailure.unavailable },
            readTurnTrace: { _, _ in throw ClientDetailConfigurationFailure.unavailable },
            worktreeAPI: { _ in throw ClientDetailConfigurationFailure.unavailable }, onWorktreeJob: { _ in }, resident: .init())
        let context = ClientDetailContext(sessionKind: "assistantChat", taskID: nil, workID: nil)
        func rail() -> some View {
            ConversationDetailDashboard {
                ConversationNativeBusinessDetail(store: handle.store, api: nil, actions: nil, context: context,
                    adapters: adapters, handle: handle, arrangement: arrangement,
                    refresh: {}, canCommand: { _, _ in false }, perform: { _, _, _ in Issue.record("Layout dispatched a command") })
            }
        }
        let host = NSHostingView(rootView: rail())
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 376, height: 700),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000)); window.orderBack(nil)
        defer { window.contentView = nil; window.close() }
        func probes(_ view: NSView) -> [DetailCardProbe.View] {
            if let probe = view as? DetailCardProbe.View { return [probe] }
            return view.subviews.flatMap(probes)
        }
        for revision in 0..<16 {
            let cards: [[String: Any]] = [
                ["id": "summary", "kind": "chatSummary", "version": 1, "revision": "\(revision)", "loadState": "ready",
                 "data": ["text": String(repeating: "有界正文。", count: revision.isMultiple(of: 2) ? 10 : 400)], "actions": []],
                ["id": "references", "kind": "contextReferences", "version": 1, "revision": "\(revision)", "loadState": "ready",
                 "data": ["items": [], "hasMore": false], "actions": []]
            ]
            let document: [String: Any] = ["protocolVersion": 1, "catalog": "native-business-v1", "documentId": "detail:test",
                "sessionId": scope.sessionID, "generation": "test", "revision": "\(revision)",
                "cards": cards, "order": ["summary", "references"]]
            try handle.store.receive(ClientDetailBusinessDocument.decode(JSONSerialization.data(withJSONObject: document)))
            if revision.isMultiple(of: 3) {
                arrangement.move(["references"], before: "summary", cards: handle.store.orderedCards)
            } else {
                arrangement.move(["summary"], before: "references", cards: handle.store.orderedCards)
            }
            host.rootView = rail()
            let width = [324.0, 264, 320, 324][revision % 4]
            window.setContentSize(CGSize(width: width, height: 700))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(30))
            let sizes = arrangement.ordered(ClientDetailCardPolicy.orderedCards(in: handle.store, context: context))
                .map { DetailWidgetSizing.preferredSize(for: $0.card) }
            let expected = DetailWidgetPlacement.make(width: width - 24, widgets: sizes)
            #expect(sizes.count == 2)
            let found = probes(host)
            #expect(found.count == sizes.count)
            for (index, probe) in found.enumerated() { #expect(probe.bounds.size == expected.frames[index].size) }
        }
        let frames = probes(host).map(\.frame)
        for _ in 0..<10 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(probes(host).map(\.frame) == frames)
        #expect(defaults.stringArray(forKey: "corptie.detail.cardKindOrder.v1") == ["contextReferences", "chatSummary"])
    }

    @Test func hostedCardsHonorTheirCellsAndKeepOverflowScrollableAfterResize() async throws {
        let sizes: [DetailWidgetSize] = [.strip, .small, .small, .medium, .large, .tall, .small, .extraLarge]
        let rows = ForEach(sizes.indices, id: \.self) { index in
                    ConversationDetailModuleCard(title: "组件 \(index)", systemImage: "square.grid.2x2") {
                        ForEach(0..<20) { row in Text("\(row) 记忆内容").font(.caption) }
                        Button("最后一个操作") {}
                    }.detailWidget(sizes[index])
        }
        let host = NSHostingView(rootView: ConversationDetailDashboard {
            DetailWidgetLayout(sizes: sizes) { rows }
        })
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 376, height: 800), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000)); window.orderBack(nil)
        defer { window.contentView = nil; window.close() }
        func cards(_ view: NSView) -> [DetailCardProbe.View] {
            if let card = view as? DetailCardProbe.View { return [card] }
            return view.subviews.flatMap(cards)
        }
        func scrolls(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrolls)
        }
        // AppKit rounds native view frames to physical pixels; the shallow
        // profile can have a fractional track height at intermediate widths.
        func matchesCell(_ actual: CGSize, _ expected: CGSize) -> Bool {
            let pixel = 1 / window.backingScaleFactor
            return abs(actual.width - expected.width) < pixel && abs(actual.height - expected.height) < pixel
        }
        for width in [324.0, 320, 264, 324] {
            window.setContentSize(CGSize(width: width, height: 800))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
            // The native viewport can reserve a legacy scroller gutter during
            // resize. Cells must honor its actual proposal, not window width.
            func currentPlan() -> DetailWidgetPlacement {
                DetailWidgetPlacement.make(width: (scrolls(host).first?.documentView?.bounds.width ?? host.bounds.width) - 24, widgets: sizes)
            }
            // The router switches AppKit's initial legacy scroller to overlay
            // on the next main-queue pass. Wait for that width change to settle
            // before checking the exact cells, including under concurrent tests.
            for _ in 0..<20 {
                let found = cards(host)
                let plan = currentPlan()
                if found.count == sizes.count && zip(found, plan.frames).allSatisfy({ matchesCell($0.0.bounds.size, $0.1.size) }) { break }
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(10))
            }
            let found = cards(host)
            let plan = currentPlan()
            #expect(found.count == sizes.count)
            for (index, card) in found.enumerated() {
                let actual = card.bounds.size, expected = plan.frames[index].size
                #expect(matchesCell(actual, expected), "requested=\(width) host=\(host.bounds.width) actual=\(actual.width)x\(actual.height) expected=\(expected.width)x\(expected.height)")
            }
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
