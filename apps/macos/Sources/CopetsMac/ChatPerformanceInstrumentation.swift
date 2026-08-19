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
