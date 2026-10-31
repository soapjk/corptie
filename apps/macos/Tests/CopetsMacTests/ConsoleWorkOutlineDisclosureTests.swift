import AppKit
import Observation
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class ConsoleWorkOutlineDisclosureTests: XCTestCase {
    private final class State: ObservableObject {
        @Published var expanded = false
        @Published var showsAll = false
        @Published var rows = 6
        @Published var reduced = false
    }
    private struct Probe: NSViewRepresentable {
        let view: NSView
        func makeNSView(context: Context) -> NSView { view }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }
    private final class GeometryProbe: NSView {
        override var isFlipped: Bool { true }
    }
    @MainActor private final class Lifetime {
        let view = GeometryProbe()
        var created = 0
        var removed = 0
        var completed = 0
    }
    private struct LifetimeProbe: NSViewRepresentable {
        let lifetime: Lifetime
        func makeCoordinator() -> Lifetime { lifetime }
        func makeNSView(context: Context) -> NSView { lifetime.created += 1; return lifetime.view }
        func updateNSView(_ nsView: NSView, context: Context) {}
        static func dismantleNSView(_ nsView: NSView, coordinator: Lifetime) { coordinator.removed += 1 }
    }
    private final class Measurements: @unchecked Sendable {
        private let lock = NSLock()
        private var recordedCount = 0
        var count: Int { lock.withLock { recordedCount } }
        func record() { lock.withLock { recordedCount += 1 } }
    }
    private struct MeasurementProbeLayout: Layout {
        let measurements: Measurements?
        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
            // Fixed-height placement queries are not a new full-list measurement.
            if proposal.height == nil { measurements?.record() }
            return subviews.first?.sizeThatFits(proposal) ?? .zero
        }
        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
            subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: proposal)
        }
    }

    private struct Surface: View {
        @ObservedObject var state: State
        let probe: NSView
        let lifetime: Lifetime
        var next: NSView? = nil
        var reduceMotion: Bool? = nil
        var usesDisclosureLimit = false
        var title = "Work"
        var measurements: Measurements? = nil
        private var rowCount: Int {
            usesDisclosureLimit && !state.showsAll ? min(5, state.rows) : state.rows
        }
        var body: some View {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    DisclosureGroup(isExpanded: $state.expanded) {
                        MeasurementProbeLayout(measurements: measurements) {
                            VStack(spacing: 2) {
                                ForEach(0..<rowCount, id: \.self) { index in Text("Task \(index)").frame(height: 22) }
                            }
                            .frame(maxWidth: .infinity)
                            .background(Color.red)
                            .background(LifetimeProbe(lifetime: lifetime))
                        }
                    } label: { Text(title).lineLimit(1) }
                    .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle(
                        reduceMotionOverride: reduceMotion ?? state.reduced,
                        onCollapseCompleted: {
                            lifetime.completed += 1
                            if usesDisclosureLimit && state.showsAll { state.showsAll = false }
                        }))
                    .consoleWorkOutlineGroupCard()
                    .background(Probe(view: probe))
                    Text("Next Work").frame(maxWidth: .infinity).frame(height: 24)
                        .consoleWorkOutlineGroupCard()
                        .background(Color.blue)
                        .background { if let next { Probe(view: next) } }
                }
            }
            .background(Color.white)
        }
    }
    @MainActor private final class ClickTimes {
        var firedAt: Date?
        var count = 0
    }
    private struct InputSurface: View {
        @ObservedObject var state: State
        let probe: NSView
        let times: ClickTimes
        let work = Work(id: "work:input-latency", workspaceId: "workspace:test", name: "Work",
            description: "", status: "active", profile: "general", tags: [], contributorRoleIds: [],
            createdAt: "", updatedAt: "")
        var body: some View {
            ScrollView {
                LazyVStack(spacing: 4) {
                    DisclosureGroup(isExpanded: $state.expanded) {
                        VStack(spacing: 2) {
                            ForEach(0..<5) { index in Text("Task \(index)").frame(height: 22) }
                        }
                    } label: {
                        ConsoleWorkOutlineHeader(work: work, isExpanded: state.expanded, isSelected: false,
                            isWorking: false, hasUnread: false, isChatSelected: false,
                            isChatRunning: false, hasUnreadChat: false, toggleExpanded: {
                                times.firedAt = Date(); times.count += 1; state.expanded.toggle()
                            }, openChat: {}, createTask: {})
                        .contextMenu { Button("Menu action") {} }
                    }
                    .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())
                    .consoleWorkOutlineGroupCard()
                    .background(Probe(view: probe))
                }
            }
        }
    }

    private func settle(_ duration: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(duration))
    }

    func testExpandedAndCollapsedGroupHeightsHaveIntermediateFrames() throws {
        _ = NSApplication.shared
        let state = State(), probe = GeometryProbe(), lifetime = Lifetime()
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Surface(state: state, probe: probe, lifetime: lifetime))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        let collapsed = probe.frame.height
        state.expanded = true
        settle(0.05)
        let expanding = probe.frame.height
        let enteringTop = probe.convert(lifetime.view.bounds, from: lifetime.view).minY
        settle(0.25)
        let expanded = probe.frame.height
        let settledTop = probe.convert(lifetime.view.bounds, from: lifetime.view).minY
        XCTAssertEqual(enteringTop, settledTop, accuracy: 2.1,
            "Rows stay at the top; only the existing 2pt title gap changes")
        XCTAssertGreaterThan(expanded, collapsed + 100)
        XCTAssertGreaterThan(expanding, collapsed + 1)
        XCTAssertLessThan(expanding, expanded - 1)
        state.expanded = false
        settle(0.05)
        let collapsing = probe.frame.height
        XCTAssertEqual(lifetime.removed, 0, "Retain children in layout throughout collapse")
        XCTAssertGreaterThan(collapsing, collapsed + 1)
        XCTAssertLessThan(collapsing, expanded - 1)
        settle(0.25)
        XCTAssertEqual(probe.frame.height, collapsed, accuracy: 1)
        XCTAssertEqual(lifetime.created, 1, "Animation must not recreate the child host each frame")
        XCTAssertEqual(lifetime.removed, 1, "Collapsed content must release its native views")
    }

    func testAdjacentWorkTracksRevealAndRowsNeverPaintAcrossItsBoundary() throws {
        _ = NSApplication.shared
        let state = State(), group = GeometryProbe(), next = GeometryProbe(), lifetime = Lifetime()
        state.expanded = true
        let host = NSHostingView(rootView: Surface(state: state, probe: group, lifetime: lifetime, next: next))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host; window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        let expanded = group.frame.height
        // Establish that the sampled column actually contains the red child rows.
        let initialBitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: initialBitmap)
        let initialFrame = group.convert(group.bounds, to: host)
        let initialScale = CGFloat(initialBitmap.pixelsHigh) / host.bounds.height
        let sampleY = Int((initialFrame.minY + 40) * initialScale)
        let initialPixel = try XCTUnwrap(initialBitmap.colorAt(x: initialBitmap.pixelsWide / 10, y: sampleY)?.usingColorSpace(.deviceRGB))
        XCTAssertGreaterThan(initialPixel.redComponent, 0.85)
        XCTAssertGreaterThan(initialPixel.redComponent - initialPixel.greenComponent, 0.4)
        XCTAssertGreaterThan(initialPixel.redComponent - initialPixel.blueComponent, 0.4)
        state.expanded = false
        var heights: [CGFloat] = []
        for _ in 0..<14 {
            settle(0.016)
            host.layoutSubtreeIfNeeded()
            let groupFrame = group.convert(group.bounds, to: host)
            let nextFrame = next.convert(next.bounds, to: host)
            heights.append(groupFrame.height)
            XCTAssertEqual(nextFrame.minY, groupFrame.maxY + 4, accuracy: 1,
                "Next Work must track the closing Work's current boundary")
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let scale = CGFloat(bitmap.pixelsHigh) / host.bounds.height
            let bottom = min(bitmap.pixelsHigh, Int(ceil(groupFrame.maxY * scale)) + 2)
            for y in bottom..<bitmap.pixelsHigh {
                let pixel = try XCTUnwrap(bitmap.colorAt(x: bitmap.pixelsWide / 10, y: y)?.usingColorSpace(.deviceRGB))
                XCTAssertFalse(pixel.redComponent > 0.8 && pixel.redComponent - pixel.greenComponent > 0.4 && pixel.redComponent - pixel.blueComponent > 0.4,
                    "Departing rows painted over the following Work at pixel \(y)")
            }
        }
        settle(0.1)
        let collapsed = group.frame.height
        XCTAssertGreaterThan(heights.filter { $0 > collapsed + 1 && $0 < expanded - 1 }.count, 2,
            "Collapse must have multiple intermediate layout frames")
        XCTAssertEqual(lifetime.removed, 1)
    }

    func testRapidReversalKeepsTheMountedChildrenAndIgnoresOldCompletion() {
        _ = NSApplication.shared
        let state = State(), probe = GeometryProbe(), lifetime = Lifetime()
        state.expanded = true
        state.rows = 10
        state.showsAll = true
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Surface(state: state, probe: probe, lifetime: lifetime, usesDisclosureLimit: true))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        for _ in 0..<3 {
            state.expanded = false; settle(0.04)
            state.expanded = true; settle(0.04)
        }
        settle(0.3)
        XCTAssertEqual(lifetime.created, 1)
        XCTAssertEqual(lifetime.removed, 0)
        XCTAssertEqual(lifetime.completed, 0)
        XCTAssertTrue(state.showsAll)
        XCTAssertGreaterThan(probe.frame.height, 150)
        state.expanded = false
        settle(0.3)
        XCTAssertEqual(lifetime.removed, 1)
        XCTAssertEqual(lifetime.completed, 1)
        XCTAssertFalse(state.showsAll)
    }

    func testReduceMotionCollapsesImmediatelyAndReleasesChildren() {
        _ = NSApplication.shared
        let state = State(), probe = GeometryProbe(), lifetime = Lifetime()
        state.expanded = true
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Surface(state: state, probe: probe, lifetime: lifetime, reduceMotion: true))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        state.expanded = false
        settle(0.04)
        XCTAssertLessThan(probe.frame.height, 40)
        XCTAssertEqual(lifetime.removed, 1)
        XCTAssertEqual(lifetime.completed, 1)
    }

    func testFullListResetsOnlyAfterCompletedCollapse() {
        _ = NSApplication.shared
        let state = State(), probe = GeometryProbe(), lifetime = Lifetime()
        state.expanded = true; state.showsAll = true; state.rows = 10
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Surface(state: state, probe: probe, lifetime: lifetime,
            usesDisclosureLimit: true))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        let fullHeight = lifetime.view.frame.height
        state.expanded = false
        settle(0.04)
        XCTAssertTrue(state.showsAll)
        XCTAssertEqual(lifetime.completed, 0)
        XCTAssertEqual(lifetime.view.frame.height, fullHeight, accuracy: 1)
        settle(0.3)
        XCTAssertFalse(state.showsAll)
        XCTAssertEqual(lifetime.completed, 1)
        XCTAssertEqual(lifetime.removed, 1)
        state.expanded = true
        settle(0.3)
        XCTAssertEqual(lifetime.created, 2)
        XCTAssertEqual(lifetime.view.frame.height, fullHeight - 5 * 24, accuracy: 1)
    }

    func testRevealKeepsTextSizeAndPlacementStable() {
        _ = NSApplication.shared
        for width: CGFloat in [220, 320, 420] {
            let state = State(), probe = GeometryProbe(), lifetime = Lifetime()
            let host = NSHostingView(rootView: Surface(state: state, probe: probe, lifetime: lifetime,
                title: String(repeating: "Long Work 标题 ", count: 20)))
            let window = NSWindow(contentRect: .init(x: 0, y: 0, width: width, height: 500),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
            defer { window.orderOut(nil); window.contentView = nil }
            settle(0.06)
            state.expanded = true; settle(0.05)
            let entering = lifetime.view.convert(lifetime.view.bounds, to: probe)
            settle(0.3)
            let expanded = lifetime.view.convert(lifetime.view.bounds, to: probe)
            XCTAssertEqual(entering.height, expanded.height, accuracy: 1)
            XCTAssertEqual(entering.width, expanded.width, accuracy: 1)
            XCTAssertEqual(entering.minY, expanded.minY, accuracy: 2.1)
            XCTAssertLessThanOrEqual(expanded.maxX, probe.bounds.width + 1)
        }
    }

    func testAnimationReusesContentMeasurementForUnchangedWidth() {
        _ = NSApplication.shared
        let state = State(), probe = GeometryProbe(), lifetime = Lifetime(), measurements = Measurements()
        let host = NSHostingView(rootView: Surface(state: state, probe: probe, lifetime: lifetime,
            measurements: measurements))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        state.expanded = true; settle(0.04)
        let measured = measurements.count
        XCTAssertGreaterThan(measured, 0)
        for _ in 0..<12 { settle(0.016); host.layoutSubtreeIfNeeded() }
        let animatedMeasurements = measurements.count - measured
        XCTAssertLessThanOrEqual(animatedMeasurements, 2,
            "Unchanged children must not be fully measured every animation frame")
        let beforeResize = measurements.count
        window.setContentSize(.init(width: 220, height: 500)); settle(0.06)
        host.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(measurements.count, beforeResize)
        let beforeChange = measurements.count, oldHeight = lifetime.view.frame.height
        state.rows = 9; settle(0.06); host.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(measurements.count, beforeChange)
        XCTAssertEqual(lifetime.view.frame.height, oldHeight + 3 * 24, accuracy: 1)
        XCTAssertEqual(probe.frame.height, lifetime.view.frame.height + 36, accuracy: 1,
            "The card must update its measured full height, not clip newly added rows")
        XCTAssertEqual(lifetime.created, 1)
        print("Work reveal full measurements during unchanged animation: \(animatedMeasurements); native mounts: \(lifetime.created)")
    }

    func testReduceMotionStopsAnInFlightCollapse() {
        _ = NSApplication.shared
        let state = State(), probe = GeometryProbe(), lifetime = Lifetime()
        state.expanded = true
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Surface(state: state, probe: probe, lifetime: lifetime))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        state.expanded = false; settle(0.04)
        XCTAssertEqual(lifetime.removed, 0)
        state.reduced = true; settle(0.04)
        XCTAssertLessThan(probe.frame.height, 40)
        XCTAssertEqual(lifetime.removed, 1)
        XCTAssertEqual(lifetime.completed, 1)
        settle(0.3)
        XCTAssertEqual(lifetime.completed, 1, "Old animation completion must not clean up twice")
    }

    func testChangingContentDuringRevealInvalidatesMeasurements() {
        _ = NSApplication.shared
        let state = State(), probe = GeometryProbe(), lifetime = Lifetime(), measurements = Measurements()
        let host = NSHostingView(rootView: Surface(state: state, probe: probe, lifetime: lifetime,
            measurements: measurements))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        state.expanded = true; settle(0.04)
        let before = measurements.count, oldHeight = lifetime.view.frame.height
        state.rows = 9; settle(0.04); host.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(measurements.count, before)
        XCTAssertEqual(lifetime.view.frame.height, oldHeight + 3 * 24, accuracy: 1)
        settle(0.3)
        XCTAssertEqual(probe.frame.height, lifetime.view.frame.height + 36, accuracy: 1)
        XCTAssertEqual(lifetime.created, 1)
        XCTAssertEqual(lifetime.removed, 0)
    }

    func testMouseReleaseToFirstFrameDoesNotWaitForHalfASecond() throws {
        _ = NSApplication.shared
        let state = State(), probe = GeometryProbe(), times = ClickTimes()
        let host = NSHostingView(rootView: InputSurface(state: state, probe: probe, times: times))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 350),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.1)
        let initialHeight = probe.frame.height
        let header = probe.convert(probe.bounds, to: host)
        let location = host.convert(NSPoint(x: 75, y: header.minY + 19), to: nil)
        func event(_ type: NSEvent.EventType) throws -> NSEvent {
            try XCTUnwrap(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
        }
        let began = Date()
        window.sendEvent(try event(.leftMouseDown)); settle(0.03)
        let released = Date()
        window.sendEvent(try event(.leftMouseUp))
        var firstFrame: Date?
        while Date().timeIntervalSince(released) < 0.7 {
            settle(0.005)
            if probe.frame.height > initialHeight + 0.5 { firstFrame = Date(); break }
        }
        let movedAt = try XCTUnwrap(firstFrame)
        print("Work header mouse action ms", times.firedAt.map { $0.timeIntervalSince(began) * 1000 } as Any,
            "release-to-layout ms", movedAt.timeIntervalSince(released) * 1000)
        XCTAssertLessThan(movedAt.timeIntervalSince(released), 0.2)
        settle(0.3)
        XCTAssertEqual(times.count, 1)
    }

    @MainActor private final class BodyCounts {
        var root = 0
        var content = 0
    }
    private struct PreferenceGroup: View {
        let preferences: ConsoleOutlineExpansionPreferences
        let counts: BodyCounts
        var body: some View {
            counts.content += 1
            let expanded = Binding(get: { preferences.expandedWorkIDs.contains("work:ownership") },
                set: { preferences.setWorkExpanded($0, workID: "work:ownership") })
            return DisclosureGroup(isExpanded: expanded) { Text("Task") } label: { Text("Work") }
                .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())
        }
    }
    private struct PreferenceOwner: View {
        @State var preferences: ConsoleOutlineExpansionPreferences
        let counts: BodyCounts
        var body: some View {
            counts.root += 1
            return PreferenceGroup(preferences: preferences, counts: counts)
        }
    }

    func testDisclosureUpdatesDoNotRebuildThePreferenceOwner() throws {
        _ = NSApplication.shared
        let suite = "ConsoleWorkOutlineDisclosureTests.ownership.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ConsoleOutlineExpansionPreferences(defaults: defaults), counts = BodyCounts()
        let host = NSHostingView(rootView: PreferenceOwner(preferences: preferences, counts: counts))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 300),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.06)
        let initialRoot = counts.root
        let collapsedHeight = host.fittingSize.height
        preferences.setWorkExpanded(true, workID: "work:ownership")
        settle(0.3)
        XCTAssertGreaterThan(host.fittingSize.height, collapsedHeight + 1,
            "The observing disclosure must still render its expanded content")
        XCTAssertEqual(counts.root, initialRoot,
            "A Work disclosure must not invalidate its owner and unrelated Console content")
        preferences.setWorkExpanded(false, workID: "work:ownership")
        settle(0.3)
        XCTAssertEqual(counts.root, initialRoot)
        XCTAssertFalse(preferences.expandedWorkIDs.contains("work:ownership"))
        XCTAssertEqual(host.fittingSize.height, collapsedHeight, accuracy: 1)
        print("Work disclosure preference owner body builds: \(initialRoot) -> \(counts.root)")
    }
}
