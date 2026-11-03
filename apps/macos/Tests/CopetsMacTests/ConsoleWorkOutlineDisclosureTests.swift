import AppKit
import Observation
import CorptieConversation
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

    @MainActor private final class RowConstructions {
        var ids: Set<String> = []
    }
    private struct RichSurface: View {
        @ObservedObject var state: State
        let tasks: [CorptieTask]
        let session: TaskSession
        let probe: NSView
        var constructions: RowConstructions? = nil
        var body: some View {
            ScrollView {
                VStack(spacing: 4) {
                    DisclosureGroup(isExpanded: $state.expanded) {
                        ConsoleWorkOutlineRows(rowCount: min(tasks.count, state.rows)) {
                            ForEach(tasks.prefix(state.rows)) { task in
                                let _ = constructions?.ids.insert(task.id)
                                ConsoleTaskRowContent(task: task, sessionActivity: .idle,
                                    session: session, isSelected: false, isUnread: true, onOpen: {})
                                .contextMenu { Button("Task action") {} }
                                .frame(height: ConsoleWorkOutlineRowMetrics.height)
                            }
                        }
                    } label: { Text("Work with live session badges") }
                    .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())
                    .consoleWorkOutlineGroupCard()
                    .background(Probe(view: probe))
                    ForEach(0..<10) { index in
                        Text("Other Work \(index)").frame(height: 28)
                            .consoleWorkOutlineGroupCard()
                    }
                }
            }
        }
    }

    private func motionSession() throws -> TaskSession {
        try JSONDecoder().decode(TaskSession.self, from: Data("""
        {"id":"session:motion","title":"会话","agent":"codex","agentId":"role:motion",
         "status":"running","progress":0,"summary":"","updatedAt":"2026-10-31T00:00:00Z","accent":"cyan",
         "external":{"provider":"codex-app-server","currentModel":"model-v1"}}
        """.utf8))
    }

    private func motionTasks(count: Int, session: TaskSession) -> [CorptieTask] {
        (0..<count).map { index in
            CorptieTask(id: "task:\(index)", workId: "work:motion", title: "Task \(index) with a long title",
                description: "", acceptanceCriteria: "", priority: "medium", lifecycleState: "in_progress",
                mainRoleId: "role:motion", currentSessionId: session.id, executionStatus: "idle",
                acceptanceAssessment: nil, completionSuggestion: nil, createdAt: "", updatedAt: "")
        }
    }

    func testDefaultPreviewUsesPreparedFiveRootsAcrossRepeatedWorkToggles() async throws {
        let suite = "ConsoleWorkOutlineDisclosureTests.preview.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ConsoleOutlineExpansionPreferences(defaults: defaults)
        let session = try motionSession(), store = ConsoleOutlineProjectionStore()
        let key = ConsoleOutlineProjectionKey(entityRevision: 1, sessionRevision: 1, search: "", sort: .standard,
            expandedTaskIDs: ["task:0"])
        var tasks = motionTasks(count: 1_000, session: session)
        var child = tasks.removeLast()
        child.parentTaskId = tasks[0].id
        tasks.insert(child, at: 1)
        await store.prepare(key: key, tasks: tasks, works: [], sessions: [])
        for _ in 0..<20 {
            preferences.toggleWork(workID: "work:motion")
            await store.prepare(key: key, tasks: tasks, works: [], sessions: [])
            let rows = try XCTUnwrap(store.prepared.workRowsByWorkID["work:motion"])
            XCTAssertEqual(rows.rootCount, 999)
            XCTAssertEqual(rows.rows(showsAll: false).map(\.id), ["task:0", "task:999", "task:1", "task:2", "task:3", "task:4"])
            XCTAssertEqual(rows.rows(showsAll: true).count, 1_000)
        }
        XCTAssertEqual(store.computationCount, 1)
        XCTAssertFalse(store.lastComputationUsedMainThread)
    }

    func testRealTaskRowsHavePromptLayoutProgressAcrossListLengths() throws {
        _ = NSApplication.shared
        let session = try motionSession()
        for rowCount in [5, 30, 300] {
            let tasks = motionTasks(count: rowCount, session: session)
            let state = State(), probe = GeometryProbe()
            state.rows = rowCount
            let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 900),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: RichSurface(state: state, tasks: tasks, session: session, probe: probe))
            window.orderFrontRegardless()
            defer { window.orderOut(nil); window.contentView = nil }
            settle(0.1)
            for expanded in [true, false, true, false] {
                let initial = probe.frame.height
                let began = Date()
                state.expanded = expanded
                var changes: [(Double, CGFloat)] = []
                var previous = initial
                while Date().timeIntervalSince(began) < 0.45 {
                    settle(0.002)
                    let height = probe.frame.height
                    if abs(height - previous) > 0.1 {
                        changes.append((Date().timeIntervalSince(began), height)); previous = height
                    }
                }
                let first = try XCTUnwrap(changes.first)
                let gaps = zip(changes, changes.dropFirst()).map { $1.0 - $0.0 }
                print("Rich Work layout rows=\(rowCount) expanded=\(expanded) first_ms=\(first.0 * 1000) updates=\(changes.count) max_gap_ms=\((gaps.max() ?? 0) * 1000)")
                XCTAssertGreaterThan(changes.count, 2)
                XCTAssertLessThan(first.0, 0.2)
                XCTAssertLessThan(gaps.max() ?? 0, 0.1)
            }
        }
    }

    func testBackgroundPreparationReusesOtherWorksAndDiscardsSupersededRequests() async throws {
        let session = try motionSession(), store = ConsoleOutlineProjectionStore()
        var tasks = motionTasks(count: 300, session: session)
        var other = motionTasks(count: 1, session: session)[0]
        other.workId = "work:other"
        // Different IDs across the two Works are required by the inventory contract.
        other = CorptieTask(id: "task:other", workId: other.workId, title: "Other", description: "",
            acceptanceCriteria: "", priority: "medium", lifecycleState: "todo", mainRoleId: nil,
            currentSessionId: nil, executionStatus: nil, createdAt: "", updatedAt: "")
        tasks.append(other)
        func key(_ revision: UInt64, sort: WorkOutlineSort = .standard) -> ConsoleOutlineProjectionKey {
            .init(entityRevision: revision, sessionRevision: 0, search: "", sort: sort)
        }
        await store.prepare(key: key(1), tasks: tasks, works: [], sessions: [])
        XCTAssertFalse(store.lastComputationUsedMainThread)
        tasks[0].description = "An unrelated description patch"
        await store.prepare(key: key(2), tasks: tasks, works: [], sessions: [])
        XCTAssertTrue(store.rebuiltWorkIDs.isEmpty)
        XCTAssertEqual(store.prepared.workRowsByWorkID["work:motion"]?.allRows.first?.description, tasks[0].description)
        await store.prepare(key: key(3, sort: .name), tasks: tasks, works: [], sessions: [])
        tasks[0].title = "ZZZ"
        await store.prepare(key: key(4, sort: .name), tasks: tasks, works: [], sessions: [])
        XCTAssertEqual(store.rebuiltWorkIDs, ["work:motion"])
        let large = motionTasks(count: 10_000, session: session)
        let pending = Task { await store.prepare(key: key(5), tasks: large, works: [], sessions: []) }
        for _ in 0..<1_000 {
            if store.requestedKey == key(5) { break }
            await Task.yield()
        }
        XCTAssertEqual(store.requestedKey, key(5))
        await store.prepare(key: key(4, sort: .name), tasks: tasks, works: [], sessions: [])
        await pending.value
        XCTAssertEqual(store.preparedKey, key(4, sort: .name), "Returning to an already prepared view must cancel a pending replacement")
        XCTAssertEqual(store.prepared.workRowsByWorkID["work:motion"]?.allRows.count, 300)
    }

    func testThousandRowWorkMountsViewportAndCanScrollToLastTask() throws {
        _ = NSApplication.shared
        let session = try motionSession(), state = State(), probe = GeometryProbe(), constructions = RowConstructions()
        let tasks = motionTasks(count: 1_000, session: session)
        state.rows = tasks.count
        let host = NSHostingView(rootView: RichSurface(state: state, tasks: tasks, session: session,
            probe: probe, constructions: constructions))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 900),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderFrontRegardless()
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.1)
        state.expanded = true; settle(0.35)
        XCTAssertEqual(probe.frame.height, ConsoleWorkOutlineRowMetrics.contentHeight(count: 1_000) + 28, accuracy: 1)
        print("1000-row Work initial row constructions:", constructions.ids.count)
        XCTAssertLessThan(constructions.ids.count, 150, "Offscreen rows must remain unconstructed")
        XCTAssertFalse(constructions.ids.contains("task:999"))
        state.rows = 995; settle(0.1)
        XCTAssertEqual(probe.frame.height, ConsoleWorkOutlineRowMetrics.contentHeight(count: 995) + 28, accuracy: 1)
        state.rows = 1_000; settle(0.1)
        XCTAssertEqual(probe.frame.height, ConsoleWorkOutlineRowMetrics.contentHeight(count: 1_000) + 28, accuracy: 1)
        func findScroll(_ view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView { return scroll }
            return view.subviews.lazy.compactMap(findScroll).first
        }
        let scroll = try XCTUnwrap(findScroll(host)), document = try XCTUnwrap(scroll.documentView)
        scroll.contentView.scroll(to: .init(x: 0, y: max(0, document.bounds.height - scroll.contentView.bounds.height)))
        scroll.reflectScrolledClipView(scroll.contentView)
        settle(0.2)
        XCTAssertTrue(constructions.ids.contains("task:999"), "The last row must become available when scrolled into view")
        XCTAssertEqual(probe.frame.height, ConsoleWorkOutlineRowMetrics.contentHeight(count: 1_000) + 28, accuracy: 1)
        state.expanded = false; settle(0.35)
        XCTAssertLessThan(probe.frame.height, 40)
        XCTAssertEqual(scroll.contentView.bounds.minY, 0, accuracy: 1)
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
        XCTAssertEqual(probe.frame.height, lifetime.view.frame.height + 28, accuracy: 1,
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
        XCTAssertEqual(probe.frame.height, lifetime.view.frame.height + 28, accuracy: 1)
        XCTAssertEqual(lifetime.created, 1)
        XCTAssertEqual(lifetime.removed, 0)
    }

    func testMousePressStartsRevealBeforeReleaseAcrossHeaderHitAreas() throws {
        _ = NSApplication.shared
        for x: CGFloat in [9, 75, 220] { // Arrow, Work title with context menu, blank header.
            let state = State(), probe = GeometryProbe(), times = ClickTimes()
            let host = NSHostingView(rootView: InputSurface(state: state, probe: probe, times: times))
            let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 350),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
            defer { window.orderOut(nil); window.contentView = nil }
            settle(0.1)
            let initialHeight = probe.frame.height
            let header = probe.convert(probe.bounds, to: host)
            let location = host.convert(NSPoint(x: x, y: header.minY + 19), to: nil)
            func event(_ type: NSEvent.EventType) throws -> NSEvent {
                try XCTUnwrap(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                    context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            }
            let began = Date()
            window.sendEvent(try event(.leftMouseDown))
            var firstFrame: Date?
            while Date().timeIntervalSince(began) < 0.2 {
                settle(0.005)
                if probe.frame.height > initialHeight + 0.5 { firstFrame = Date(); break }
            }
            XCTAssertTrue(state.expanded, "Header x=\(x) must respond while the mouse is held")
            XCTAssertNotNil(firstFrame, "Header x=\(x) must start layout before release")
            print("Work press-to-layout ms", x, firstFrame.map { $0.timeIntervalSince(began) * 1000 } as Any)
            window.sendEvent(try event(.leftMouseUp)); settle(0.3)
            XCTAssertTrue(state.expanded, "Release must not toggle the group again")
            if x == 75 { XCTAssertEqual(times.count, 1) }
        }
    }

    @MainActor private final class BodyCounts {
        var root = 0
        var content = 0
    }
    private struct ChatPreferenceOwner: View {
        let preferences: ConsoleOutlineExpansionPreferences
        let counts: BodyCounts
        var body: some View {
            counts.root += 1
            return ConsoleAssistantExpansionScope(preferences: preferences, forceExpanded: false) { expanded in
                Color.clear.frame(width: 100, height: expanded ? 60 : 20)
            }
        }
    }

    func testChatDisclosureDoesNotRebuildConsoleOwner() throws {
        _ = NSApplication.shared
        let suite = "ConsoleWorkOutlineDisclosureTests.chatScope.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ConsoleOutlineExpansionPreferences(defaults: defaults), counts = BodyCounts()
        let host = NSHostingView(rootView: ChatPreferenceOwner(preferences: preferences, counts: counts))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 200, height: 100),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.05)
        let initial = counts.root, collapsedHeight = host.fittingSize.height
        preferences.toggleAssistant(); settle(0.05)
        XCTAssertEqual(counts.root, initial)
        XCTAssertGreaterThan(host.fittingSize.height, collapsedHeight)
    }
    private struct PreferenceGroup: View {
        let preferences: ConsoleOutlineExpansionPreferences
        let counts: BodyCounts
        var body: some View {
            counts.content += 1
            let expanded = Binding(get: { preferences.isWorkExpanded("work:ownership") },
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

    @MainActor private final class GroupBuilds {
        var counts: [Int: Int] = [:]
        func record(_ index: Int) { counts[index, default: 0] += 1 }
    }
    private struct MultipleWorkSurface: View {
        let preferences: ConsoleOutlineExpansionPreferences
        let builds: GroupBuilds
        var body: some View {
            ScrollView {
                VStack(spacing: 4) {
                    ForEach(0..<12) { index in
                        let _ = builds.record(index)
                        DisclosureGroup(isExpanded: Binding(
                            get: { preferences.isWorkExpanded("work:\(index)") },
                            set: { preferences.setWorkExpanded($0, workID: "work:\(index)") })) {
                            VStack { ForEach(0..<5) { Text("Task \($0)").frame(height: 22) } }
                        } label: {
                            Text("Work \(index) \(preferences.isWorkExpanded("work:\(index)"))")
                        }
                        .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())
                        .consoleWorkOutlineGroupCard()
                    }
                }
            }
        }
    }
    func testTogglingOneGroupDoesNotReconstructSiblingGroupsInGroupedOutline() throws {
        _ = NSApplication.shared
        let suite = "ConsoleWorkOutlineDisclosureTests.groups.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ConsoleOutlineExpansionPreferences(defaults: defaults), builds = GroupBuilds()
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 900),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MultipleWorkSurface(preferences: preferences, builds: builds))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.1)
        let initial = builds.counts
        XCTAssertEqual(initial.count, 12)
        preferences.setWorkExpanded(true, workID: "work:0"); settle(0.3)
        preferences.setWorkExpanded(false, workID: "work:0"); settle(0.3)
        for index in 1..<12 { XCTAssertEqual(builds.counts[index], initial[index], "Unchanged Work \(index)") }
        XCTAssertGreaterThan(builds.counts[0] ?? 0, initial[0] ?? 0)
        print("Sibling Work constructions across expand/collapse:", (1..<12).reduce(0) { $0 + (builds.counts[$1] ?? 0) - (initial[$1] ?? 0) })
    }

    func testChangingOneWorkDoesNotInvalidateOtherWorkOrChatObservers() throws {
        let suite = "ConsoleWorkOutlineDisclosureTests.isolation.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ConsoleOutlineExpansionPreferences(defaults: defaults)
        let selected = BodyCounts(), sibling = BodyCounts(), chat = BodyCounts()
        withObservationTracking { _ = preferences.isWorkExpanded("work:a") }
            onChange: { MainActor.assumeIsolated { selected.root += 1 } }
        withObservationTracking { _ = preferences.isWorkExpanded("work:b") }
            onChange: { MainActor.assumeIsolated { sibling.root += 1 } }
        withObservationTracking { _ = preferences.isAssistantCollapsed }
            onChange: { MainActor.assumeIsolated { chat.root += 1 } }
        preferences.setWorkExpanded(true, workID: "work:a")
        XCTAssertEqual(selected.root, 1)
        XCTAssertEqual(sibling.root, 0)
        XCTAssertEqual(chat.root, 0)
        XCTAssertTrue(preferences.isWorkExpanded("work:a"))
        XCTAssertFalse(preferences.isWorkExpanded("work:b"))
        let restored = ConsoleOutlineExpansionPreferences(defaults: defaults)
        XCTAssertTrue(restored.isWorkExpanded("work:a"))
        preferences.removeWork("work:a")
        XCTAssertFalse(preferences.isWorkExpanded("work:a"))
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
        XCTAssertFalse(preferences.isWorkExpanded("work:ownership"))
        XCTAssertEqual(host.fittingSize.height, collapsedHeight, accuracy: 1)
        print("Work disclosure preference owner body builds: \(initialRoot) -> \(counts.root)")
    }
}
