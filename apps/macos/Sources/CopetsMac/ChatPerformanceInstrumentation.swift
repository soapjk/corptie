import Foundation
import os

enum ChatPerformanceMetric: String, CaseIterable, Sendable {
    case detailPollRequests
    case sseSnapshots
    case sseSnapshotBytes
    case sseDeltas
    case sseDeltaBytes
    case sseSnapshotRecoveries
    case detailPublishes
    case displayRebuilds
    case displayProjectionRequests
    case displayProjectionCommits
    case displayProjectionCancellations
    case historyPrepends
    case markdownPreprocesses
    case markdownCharacters
    case fixtureStreamingUpdates
    case appKitCellsCreated
    case appKitRowsConfigured
    case appKitRowWidthUpdates
}

struct ChatPerformanceSnapshot: Equatable, Sendable {
    let counters: [ChatPerformanceMetric: Int64]

    subscript(_ metric: ChatPerformanceMetric) -> Int64 {
        counters[metric, default: 0]
    }
}

final class ChatPerformanceRecorder: @unchecked Sendable {
    static let shared = ChatPerformanceRecorder()

    private let lock = NSLock()
    private var counters: [ChatPerformanceMetric: Int64] = [:]
    private let logger = Logger(subsystem: "com.corptie.mac", category: "ChatTimelinePerformance")

    func increment(_ metric: ChatPerformanceMetric, by amount: Int64 = 1) {
        lock.lock()
        counters[metric, default: 0] += amount
        lock.unlock()
    }

    func snapshot() -> ChatPerformanceSnapshot {
        lock.lock()
        let value = ChatPerformanceSnapshot(counters: counters)
        lock.unlock()
        return value
    }

    func reset() {
        lock.lock()
        counters.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    func logSnapshot(reason: String) {
        let value = snapshot()
        let fields = ChatPerformanceMetric.allCases
            .map { "\($0.rawValue)=\(value[$0])" }
            .joined(separator: " ")
        logger.info("reason=\(reason, privacy: .public) \(fields, privacy: .public)")
    }
}

enum ChatPerformanceTrace {
    private static let log = OSLog(subsystem: "com.corptie.mac", category: "ChatTimelinePerformance")

    static func measure<T>(_ name: StaticString, operation: () throws -> T) rethrows -> T {
        os_signpost(.begin, log: log, name: name)
        defer { os_signpost(.end, log: log, name: name) }
        return try operation()
    }

    @MainActor
    static func measure<T>(_ name: StaticString, operation: () async throws -> T) async rethrows -> T {
        os_signpost(.begin, log: log, name: name)
        defer { os_signpost(.end, log: log, name: name) }
        return try await operation()
    }

    static func event(_ name: StaticString, value: Int = 0) {
        os_signpost(.event, log: log, name: name, "%{public}d", value)
    }
}

/// Opt-in Development diagnostics. A trace observes four seconds of work, not
/// click-to-paint completion. Stage durations may nest and must not be summed.
/// No message content, files, production activation, or UI observation involved.
@MainActor
final class SessionSwitchTrace {
    static let shared = SessionSwitchTrace(enabled: CorptieAppEnvironment.isDevelopment &&
        ProcessInfo.processInfo.environment["CORPTIE_SESSION_SWITCH_TRACE"] == "1")

    enum Stage: String, CaseIterable {
        case taskAction, navigationSelection, backendSelection, selectionCommitted
        case detailCacheHit, detailCacheMiss, supplementaryStarted
        case splitUpdate, sidebarRoot, detailRoot, outlineHit, outlineBuild
        case restoreProjection, restoreDisplay, displayCacheHit, displayCacheMiss, rowMapping
        case timelineUpdate, sessionRebind, timelineApply, viewportLayout
        case cardContent, cardHost, composerCreate, composerUpdate
        case detailHostCreated, detailHostReused, detailHostRootUpdated
        case conversationBody, headerBody, modelMenuBody, composerBody
        case pageHostCreated, pageHostReused, pageHostEvicted
        case nativePageVisibilityCommitted, presentationDeferredWorkAllowed, presentationGateTimedOut
        case pageContentUncovered, presentationContentGateTimedOut
        case pageOpeningDrawPrepared
    }

    struct Metric {
        var count = 0
        var totalMilliseconds = 0.0
        var maximumMilliseconds = 0.0
    }

    /// Existing value inputs only: never inspect additional observable state for diagnostics.
    struct WorkHeaderInputs: Equatable {
        let title: String
        let avatarPath: String?
        let expanded, selected, working, unread, chatSelected, chatRunning, unreadChat, active: Bool
    }

    struct WorkHeaderMetric {
        var count = 0
        var unchangedInputs = 0
        var changedInputs = 0
        var unknownInputs = 0
        var collapsed = 0
    }

    enum CellStage: String, CaseIterable {
        case hit, miss, hitReconfigured, crossSessionRebind, revisionReplaced, capacityEvicted, hostAssigned, hostCreated
    }

    struct Snapshot {
        let id: UInt64
        let sessionID: String
        let start: TimeInterval
        let eventQueueMilliseconds: Double?
        var firstStageMilliseconds: [Stage: Double] = [:]
        var metrics: [Stage: Metric] = [:]
        var workHeaders: [String: WorkHeaderMetric] = [:]
        var detailBodies = 0
        var cells: [String: [CellStage: Int]] = [:]
        var droppedEntities = 0
    }

    struct Segment {
        fileprivate let traceID: UInt64
        fileprivate let stage: Stage
        fileprivate let start: TimeInterval
        fileprivate let signpostID: OSSignpostID
    }

    private let enabled: Bool
    private let clock: () -> TimeInterval
    private let log = OSLog(subsystem: "com.corptie.mac", category: "SessionSwitch")
    private let logger = Logger(subsystem: "com.corptie.mac", category: "SessionSwitch")
    private var nextID: UInt64 = 0
    private(set) var workHeaderInputs: [String: WorkHeaderInputs] = [:]
    private var expiryTask: Task<Void, Never>?
    private(set) var snapshot: Snapshot?

    init(enabled: Bool, clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.enabled = enabled
        self.clock = clock
    }

    @discardableResult
    func begin(sessionID: String, eventTimestamp: TimeInterval? = nil) -> UInt64? {
        guard enabled else { return nil }
        end(reason: "superseded")
        nextID &+= 1
        let now = clock()
        // NSEvent timestamps use system uptime. Synthetic/programmatic events
        // without a valid timestamp are explicitly unknown, never zero latency.
        let queue = eventTimestamp.flatMap { $0 > 0 && $0 <= now ? (now - $0) * 1000 : nil }
        snapshot = Snapshot(id: nextID, sessionID: sessionID, start: now, eventQueueMilliseconds: queue)
        logger.info("switch begin id=\(self.nextID) session=\(sessionID, privacy: .public) host=\(now) eventQueueMs=\(queue ?? -1)")
        let id = nextID
        expiryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            guard let self, self.snapshot?.id == id else { return }
            self.end(reason: "observation-window-ended")
        }
        return id
    }

    /// Direct selection paths may bypass the Task button. Keep the original
    /// button timestamp when the same selection is already being traced.
    func ensureSelection(sessionID: String) {
        guard enabled else { return }
        if current(sessionID: sessionID) == nil { begin(sessionID: sessionID) }
    }

    func mark(_ stage: Stage, sessionID: String? = nil) {
        guard var value = current(sessionID: sessionID) else { return }
        let elapsed = (clock() - value.start) * 1000
        if value.firstStageMilliseconds[stage] == nil {
            value.firstStageMilliseconds[stage] = elapsed
            logger.info("switch stage id=\(value.id) name=\(stage.rawValue, privacy: .public) host=\(self.clock()) elapsedMs=\(elapsed)")
            os_signpost(.event, log: log, name: "SessionSwitchStage", "%{public}llu %{public}s", value.id, stage.rawValue)
        }
        var metric = value.metrics[stage, default: Metric()]
        metric.count += 1
        value.metrics[stage] = metric
        snapshot = value
    }

    func start(_ stage: Stage, sessionID: String? = nil) -> Segment? {
        guard let value = current(sessionID: sessionID) else { return nil }
        let id = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "SessionSwitchWork", signpostID: id,
                    "%{public}llu %{public}s", value.id, stage.rawValue)
        return Segment(traceID: value.id, stage: stage, start: clock(), signpostID: id)
    }

    func finish(_ segment: Segment?) {
        guard let segment else { return }
        os_signpost(.end, log: log, name: "SessionSwitchWork", signpostID: segment.signpostID)
        // A synchronous main-thread stall may outlast the observation window.
        // Preserve its duration before the expiry task can run; new work after
        // the deadline is still rejected by start/mark.
        guard var value = snapshot, value.id == segment.traceID else { return }
        let duration = max(0, clock() - segment.start) * 1000
        var metric = value.metrics[segment.stage, default: Metric()]
        metric.count += 1
        metric.totalMilliseconds += duration
        metric.maximumMilliseconds = max(metric.maximumMilliseconds, duration)
        value.metrics[segment.stage] = metric
        snapshot = value
    }

    func recordWorkHeader(workID: String, inputs: @autoclosure () -> WorkHeaderInputs) {
        guard enabled else { return }
        let inputs = inputs()
        let previous = workHeaderInputs[workID]
        if previous == nil && workHeaderInputs.count >= 64 { workHeaderInputs.removeAll(keepingCapacity: true) }
        workHeaderInputs[workID] = inputs
        guard var value = current() else { return }
        guard value.workHeaders[workID] != nil || value.workHeaders.count < 64 else {
            value.droppedEntities += 1; snapshot = value; return
        }
        var metric = value.workHeaders[workID, default: WorkHeaderMetric()]
        metric.count += 1
        if let previous {
            if previous == inputs { metric.unchangedInputs += 1 } else { metric.changedInputs += 1 }
        } else { metric.unknownInputs += 1 }
        if !inputs.expanded { metric.collapsed += 1 }
        value.workHeaders[workID] = metric
        snapshot = value
    }

    /// Root body entries, not inner card rendering or paint completion.
    func recordDetailPanel(sessionID: String) {
        guard var value = current(sessionID: sessionID) else { return }
        value.detailBodies += 1
        snapshot = value
    }

    func recordCell(_ stage: CellStage, sessionID: String?, rowID: String) {
        guard let sessionID, var value = current(sessionID: sessionID) else { return }
        guard value.cells[rowID] != nil || value.cells.count < 256 else {
            value.droppedEntities += 1; snapshot = value; return
        }
        value.cells[rowID, default: [:]][stage, default: 0] += 1
        snapshot = value
    }

    func end(reason: String) {
        expiryTask?.cancel()
        expiryTask = nil
        guard let value = snapshot else { return }
        snapshot = nil
        logger.info("switch end id=\(value.id) reason=\(reason, privacy: .public) observedMs=\((self.clock() - value.start) * 1000)")
        logger.info("switch detail id=\(value.id) bodies=\(value.detailBodies) droppedEntities=\(value.droppedEntities)")
        for (workID, metric) in value.workHeaders {
            logger.info("switch work id=\(value.id) work=\(workID, privacy: .public) bodies=\(metric.count) unchanged=\(metric.unchangedInputs) changed=\(metric.changedInputs) unknown=\(metric.unknownInputs) collapsed=\(metric.collapsed)")
        }
        for (rowID, stages) in value.cells {
            for stage in CellStage.allCases {
                guard let count = stages[stage] else { continue }
                logger.info("switch cell id=\(value.id) row=\(rowID, privacy: .public) stage=\(stage.rawValue, privacy: .public) count=\(count)")
            }
        }
        for stage in Stage.allCases {
            guard let metric = value.metrics[stage] else { continue }
            logger.info("switch metric id=\(value.id) name=\(stage.rawValue, privacy: .public) count=\(metric.count) totalMs=\(metric.totalMilliseconds) maxMs=\(metric.maximumMilliseconds)")
        }
    }

    private func current(sessionID: String? = nil) -> Snapshot? {
        guard enabled, let value = snapshot, clock() - value.start < 4,
              sessionID == nil || sessionID == value.sessionID else { return nil }
        return value
    }
}
