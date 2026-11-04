import AppKit
import Observation
import SwiftUI
import XCTest
import CorptieConversation
@testable import CorptieMac

/// Opt-in experiment, not a replacement renderer or a product feature flag.
/// A successful test run means measurements completed; each scenario prints its
/// own verdict, including failures of the candidate's native scrolling behavior.
@MainActor
final class SwiftUITimelineFeasibilityTests: XCTestCase {
    func testNativeSwiftUIScrollFeasibility() async throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_SWIFTUI_TIMELINE_PROBE"] == "1" else {
            throw XCTSkip("Opt-in native SwiftUI timeline feasibility experiment")
        }
        guard #available(macOS 15, *) else { throw XCTSkip("ScrollAnchorRole requires macOS 15") }
        try await runExperiment()
    }

    @available(macOS 15, *)
    private func runExperiment() async throws {
        _ = NSApplication.shared
        let model = CandidateModel(rows: (0..<1_000).map { makeRow($0) })
        let window = makeWindow(model)
        defer { window.orderOut(nil); window.contentView = nil }
        await settle(0.8)
        let host = try XCTUnwrap(window.contentView)
        let scroll = try XCTUnwrap(findScroll(in: host))
        XCTAssertGreaterThan(model.metrics.contentHeight, 0, "The candidate must produce native scroll geometry")
        var verdicts: [String: Bool] = [:]
        func record(_ name: String, _ pass: Bool, _ detail: String = "") {
            verdicts[name] = pass
            print("SWIFTUI_SCROLL_PROBE scenario=\(name) pass=\(pass) \(detail)")
        }
        record("initial-latest", model.metrics.bottomGap <= 3, "bottom_gap=\(model.metrics.bottomGap)")
        record("lazy-mounting", model.tracker.created.count < 150,
            "realized=\(model.tracker.created.count) total=\(model.rows.count)")

        var streamGaps: [CGFloat] = []
        for revision in 1...8 {
            let previous = model.rows.last!
            model.rows[model.rows.count-1] = makeRow(999, revision: revision,
                text: previous.nativeText + "\nStreaming continuation \(revision): a new line of response text.")
            await settle(0.08)
            streamGaps.append(model.metrics.bottomGap)
        }
        record("same-id-stream-follows", (streamGaps.max() ?? .infinity) <= 3,
            "max_bottom_gap=\(streamGaps.max() ?? -1)")
        model.rows.append(makeRow(1_000))
        await settle(0.3)
        record("append-follows", model.metrics.bottomGap <= 3, "bottom_gap=\(model.metrics.bottomGap)")

        model.followsLatest = false
        model.position.scrollTo(id: "probe-400", anchor: .top)
        await settle(0.35)
        try wheel(scroll, delta: -110)
        await settle(0.2)
        let reading = try XCTUnwrap(model.tracker.firstVisible(in: scroll, host: host))
        model.rows.append(makeRow(1_001))
        await settle(0.3)
        let afterAppend = model.tracker.firstVisible(in: scroll, host: host)
        record("append-respects-reader", afterAppend?.id == reading.id && abs((afterAppend?.top ?? .infinity)-reading.top) <= 3,
            "before=\(reading) after=\(String(describing: afterAppend))")

        model.rows.insert(contentsOf: (-30..<0).map { makeRow($0) }, at: 0)
        await settle(0.4)
        let afterPrepend = model.tracker.firstVisible(in: scroll, host: host)
        record("prepend-preserves-reader", afterPrepend?.id == reading.id && abs((afterPrepend?.top ?? .infinity)-reading.top) <= 3,
            "before=\(reading) after=\(String(describing: afterPrepend))")

        model.position.scrollTo(id: "probe-850", anchor: .top)
        await settle(0.4)
        let destination = model.tracker.visible(in: scroll, host: host).first { $0.id == "probe-850" }
        record("unrealized-id-jump", destination.map { abs($0.top) <= 3 } ?? false,
            "target=\(String(describing: destination))")
        try wheel(scroll, delta: -80)
        await settle(0.2)
        let beforeResize = try XCTUnwrap(model.tracker.firstVisible(in: scroll, host: host))
        var maxReadingDrift: CGFloat = 0
        var resizeReadings: [String] = []
        for width: CGFloat in [860, 520, 720] {
            window.setContentSize(.init(width: width, height: 600))
            await settle(0.2)
            resizeReadings.append("\(width):\(String(describing: model.tracker.firstVisible(in: scroll, host: host)))")
            if let current = model.tracker.firstVisible(in: scroll, host: host), current.id == beforeResize.id {
                maxReadingDrift = max(maxReadingDrift, abs(current.top-beforeResize.top))
            } else { maxReadingDrift = .infinity }
        }
        record("resize-preserves-reader", maxReadingDrift <= 3,
            "before=\(beforeResize) max_row_top_drift=\(maxReadingDrift) readings=\(resizeReadings)")

        model.followsLatest = true
        model.position.scrollTo(edge: .bottom)
        await settle(0.3)
        var resizeBottomGaps: [CGFloat] = []
        var actualTailGaps: [CGFloat?] = []
        var resizeIntent: [String] = []
        for size in [NSSize(width: 520, height: 450), NSSize(width: 860, height: 700), NSSize(width: 720, height: 600)] {
            window.setContentSize(size)
            await settle(0.2)
            resizeBottomGaps.append(model.metrics.bottomGap)
            actualTailGaps.append(model.tracker.bottomGap(of: model.rows.last!.id, in: scroll, host: host))
            resizeIntent.append("following=\(model.followsLatest),edge=\(String(describing: model.position.edge))")
        }
        // Lazy stacks estimate total content height. Judge the displayed tail,
        // not an estimated content extent that can disagree with actual cells.
        record("resize-follows-latest", actualTailGaps.allSatisfy { $0.map { abs($0) <= 3 } ?? false },
            "estimated_content_gaps=\(resizeBottomGaps) actual_tail_gaps=\(actualTailGaps) intent=\(resizeIntent)")

        model.followsLatest = false
        model.position.scrollTo(id: "probe-600", anchor: .top)
        await settle(0.3)
        try wheel(scroll, delta: -95)
        await settle(0.2)
        let saved = try XCTUnwrap(model.tracker.firstVisible(in: scroll, host: host))
        let restored = CandidateModel(rows: model.rows, restoring: saved)
        let secondWindow = makeWindow(restored)
        defer { secondWindow.orderOut(nil); secondWindow.contentView = nil }
        await settle(0.6)
        let secondHost = try XCTUnwrap(secondWindow.contentView)
        let secondScroll = try XCTUnwrap(findScroll(in: secondHost))
        let result = restored.tracker.firstVisible(in: secondScroll, host: secondHost)
        record("cold-restore-message-id", result?.id == saved.id,
            "saved=\(saved) restored=\(String(describing: result))")
        record("cold-restore-inside-message", result?.id == saved.id && abs((result?.top ?? .infinity)-saved.top) <= 3,
            "pixel_drift=\(abs((result?.top ?? .infinity)-saved.top))")
        let adjustmentsBeforeResize = restored.restoreAdjustmentCount
        for width: CGFloat in [540, 860, 720] {
            secondWindow.setContentSize(.init(width: width, height: 600))
            await settle(0.15)
        }
        record("restore-is-one-shot", adjustmentsBeforeResize == 1
            && restored.restoreAdjustmentCount == 1 && restored.pendingRestore == nil,
            "corrections=\(restored.restoreAdjustmentCount)")

        let cancelled = CandidateModel(rows: model.rows, restoring: saved)
        cancelled.cancelPendingRestore()
        let thirdWindow = makeWindow(cancelled)
        defer { thirdWindow.orderOut(nil); thirdWindow.contentView = nil }
        await settle(0.3)
        let cancelledHost = try XCTUnwrap(thirdWindow.contentView)
        let cancelledScroll = try XCTUnwrap(findScroll(in: cancelledHost))
        let cancelledReading = cancelled.tracker.firstVisible(in: cancelledScroll, host: cancelledHost)
        record("cancel-before-mount", cancelled.restoreAdjustmentCount == 0 && cancelled.pendingRestore == nil
            && cancelledReading?.id != saved.id,
            "corrections=\(cancelled.restoreAdjustmentCount) visible=\(String(describing: cancelledReading))")
        print("SWIFTUI_SCROLL_PROBE verdicts=\(verdicts.filter { $0.value }.count)/\(verdicts.count) OS=\(ProcessInfo.processInfo.operatingSystemVersionString)")
    }

    private func makeRow(_ index: Int, revision: Int = 0, text: String? = nil) -> AppKitChatTimelineRow {
        let body = text ?? "Message \(index)\n\n" + String(repeating:
            "A response with variable height, **Markdown**, a link https://example.com and enough text to wrap naturally.\n\n",
            count: 1 + abs(index) % 6) + (index.isMultiple(of: 17) ? "\n```swift\nlet value = 42\nprint(value)\n```" : "")
        return AppKitChatTimelineRow(id: "probe-\(index)", contentRevision: revision,
            nativeText: body, copyText: body, nativeStyle: index.isMultiple(of: 5) ? .user : .agent,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false, showsHeader: false)
    }

    @available(macOS 15, *)
    private func makeWindow(_ model: CandidateModel) -> NSWindow {
        let window = NSWindow(contentRect: .init(x: 180, y: 180, width: 720, height: 600),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.title = "SwiftUI timeline feasibility — isolated test"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Candidate(model: model))
        window.orderFrontRegardless()
        return window
    }

    private func findScroll(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.lazy.compactMap { self.findScroll(in: $0) }.first
    }
    private func wheel(_ scroll: NSScrollView, delta: Int32) throws {
        let event = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
            wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0))
        scroll.scrollWheel(with: try XCTUnwrap(NSEvent(cgEvent: event)))
    }
    private func settle(_ seconds: Double) async {
        try? await Task.sleep(for: .seconds(seconds))
    }
}

@available(macOS 15, *)
@MainActor @Observable private final class CandidateModel {
    var rows: [AppKitChatTimelineRow]
    var position = ScrollPosition(idType: String.self)
    var followsLatest = true
    var pendingRestore: CandidateTracker.Reading?
    @ObservationIgnored var restoreFrame: CandidateRestoreFrame?
    @ObservationIgnored var restoreAdjustmentCount = 0
    @ObservationIgnored var metrics = CandidateMetrics()
    @ObservationIgnored let tracker = CandidateTracker()
    init(rows: [AppKitChatTimelineRow], restoring bookmark: CandidateTracker.Reading? = nil) {
        self.rows = rows
        pendingRestore = bookmark
        if let bookmark {
            followsLatest = false
            position = ScrollPosition(id: bookmark.id, anchor: .top)
        }
    }

    func cancelPendingRestore() {
        guard pendingRestore != nil else { return }
        pendingRestore = nil
        restoreFrame = nil
        position = ScrollPosition(idType: String.self)
    }

    func observeRestoreFrame(id: String, frame: CandidateRestoreFrame) {
        guard pendingRestore?.id == id else { return }
        restoreFrame = frame
        completeRestoreIfReady()
    }

    func completeRestoreIfReady() {
        guard let bookmark = pendingRestore, let frame = restoreFrame,
              abs(frame.viewportY) <= 1,
              // Geometry callbacks can arrive in either order. Consume only
              // matching row and scroll geometry from the ID-aligned layout.
              abs(frame.contentY - metrics.offsetY - frame.viewportY) <= 1 else { return }
        let target = max(0, metrics.offsetY + frame.viewportY - bookmark.top)
        pendingRestore = nil
        restoreFrame = nil
        if abs(target - metrics.offsetY) > 0.5 {
            restoreAdjustmentCount += 1
            position.scrollTo(y: target)
        }
    }
}

private struct CandidateRestoreFrame: Equatable {
    let viewportY: CGFloat
    let contentY: CGFloat
}

private struct CandidateMetrics: Equatable {
    var contentHeight: CGFloat = 0
    var offsetY: CGFloat = 0
    var visibleBottom: CGFloat = 0
    var bottomGap: CGFloat { max(0, contentHeight-visibleBottom) }
}

@available(macOS 15, *)
@MainActor private struct Candidate: View {
    @Bindable var model: CandidateModel
    var body: some View {
        GeometryReader { viewport in
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(model.rows) { row in
                        let layout = NativeTimelineLayoutCache.shared.layout(for: row,
                            columnWidth: viewport.size.width, typography: .classic, skin: .classic)
                        MacSharedMessageTextCard(row: row, layout: layout)
                            .frame(height: layout.rowHeight)
                            .background(CandidateMarker(id: row.id, tracker: model.tracker))
                            .background {
                                if model.pendingRestore?.id == row.id {
                                    Color.clear.onGeometryChange(for: CandidateRestoreFrame.self) { geometry in
                                        CandidateRestoreFrame(
                                            viewportY: geometry.frame(in: .named("candidate-viewport")).minY,
                                            contentY: geometry.frame(in: .named("candidate-content")).minY)
                                    } action: { _, frame in
                                        model.observeRestoreFrame(id: row.id, frame: frame)
                                    }
                                }
                            }
                            .id(row.id)
                    }
                }
                .scrollTargetLayout()
                .coordinateSpace(name: "candidate-content")
            }
            .coordinateSpace(name: "candidate-viewport")
            .scrollPosition($model.position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.top, for: .alignment)
            .defaultScrollAnchor(model.followsLatest ? .bottom : .top, for: .sizeChanges)
            .onScrollGeometryChange(for: CandidateMetrics.self) { geometry in
                CandidateMetrics(contentHeight: geometry.contentSize.height,
                    offsetY: geometry.contentOffset.y, visibleBottom: geometry.visibleRect.maxY)
            } action: { _, value in
                model.metrics = value
                model.completeRestoreIfReady()
            }
            .onScrollPhaseChange { _, phase, _ in
                if phase == .tracking || phase == .interacting {
                    model.cancelPendingRestore()
                    model.followsLatest = false
                }
                else if phase == .idle, model.position.isPositionedByUser {
                    model.followsLatest = model.metrics.bottomGap <= 3
                }
            }
            .onChange(of: model.rows.last?.id) { _, _ in
                if model.followsLatest { model.position.scrollTo(edge: .bottom) }
            }
        }
    }
}

@MainActor private final class CandidateTracker {
    struct Reading: CustomStringConvertible {
        let id: String
        let top: CGFloat
        var description: String { "\(id)@\(top)" }
    }
    final class WeakView {
        weak var view: NSView?
        init(_ view: NSView) { self.view = view }
    }
    var views: [String: WeakView] = [:]
    var created: Set<String> = []
    func visible(in scroll: NSScrollView, host: NSView) -> [Reading] {
        let viewport = scroll.contentView.convert(scroll.contentView.bounds, to: host)
        return views.compactMap { id, weak in
            guard let view = weak.view, view.window === host.window else { return nil }
            let frame = view.convert(view.bounds, to: host)
            guard frame.intersection(viewport).height > 1 else { return nil }
            return Reading(id: id, top: host.isFlipped ? frame.minY-viewport.minY : viewport.maxY-frame.maxY)
        }.sorted { $0.top < $1.top }
    }
    func bottomGap(of id: String, in scroll: NSScrollView, host: NSView) -> CGFloat? {
        guard let view = views[id]?.view, view.window === host.window else { return nil }
        let viewport = scroll.contentView.convert(scroll.contentView.bounds, to: host)
        let frame = view.convert(view.bounds, to: host)
        return host.isFlipped ? viewport.maxY-frame.maxY : frame.minY-viewport.minY
    }
    func firstVisible(in scroll: NSScrollView, host: NSView) -> Reading? { visible(in: scroll, host: host).first }
}

@MainActor private struct CandidateMarker: NSViewRepresentable {
    let id: String
    let tracker: CandidateTracker
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        tracker.created.insert(id)
        tracker.views[id] = .init(view)
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) { tracker.views[id] = .init(nsView) }
}
