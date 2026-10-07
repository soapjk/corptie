import Foundation
import Observation

public enum OperationNotificationCategory: String, Codable, CaseIterable, Sendable {
    case worktree, developmentService, dataMigration, gitPush, environment, mcp

    public var title: String {
        switch self {
        case .worktree: "Worktree operations"
        case .developmentService: "Development services"
        case .dataMigration: "Data migration"
        case .gitPush: "Git push"
        case .environment: "Environment preparation"
        case .mcp: "MCP installation and maintenance"
        }
    }
}

public enum OperationNotificationOutcome: String, Codable, Sendable {
    case succeeded, partial, failed, attention, cancelled, unconfirmed
    public static func errorOutcome(_ error: Error) -> Self {
        if error is CancellationError { return .cancelled }
        if let url = error as? URLError { return url.code == .cancelled ? .cancelled : .unconfirmed }
        if error is DecodingError { return .unconfirmed }
        if let failure = error as? ClientServiceFailure, failure.statusCode >= 500 { return .unconfirmed }
        return .failed
    }
    public var title: String {
        switch self {
        case .succeeded: "Operation completed"
        case .partial: "Operation partially completed"
        case .failed: "Operation failed"
        case .attention: "Operation needs attention"
        case .cancelled: "Operation cancelled"
        case .unconfirmed: "Operation result unconfirmed"
        }
    }
}

/// Device-local settings. Existing Session/Automation preferences remain independent.
@MainActor @Observable
public final class OperationNotificationPreferences {
    private let defaults: UserDefaults
    private let prefix = "corptie.notifications.operations."
    public var enabled: Bool { didSet { save(enabled, "enabled") } }
    public var success: Bool { didSet { save(success, "success") } }
    public var failure: Bool { didSet { save(failure, "failure") } }
    public var attention: Bool { didSet { save(attention, "attention") } }
    public var cancellation: Bool { didSet { save(cancellation, "cancellation") } }
    public var sound: Bool { didSet { save(sound, "sound") } }
    public var hideDetails: Bool { didSet { save(hideDetails, "hideDetails") } }
    public var suppressWhenVisible: Bool { didSet { save(suppressWhenVisible, "suppressWhenVisible") } }
    private var categories: [String: Bool]

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        func read(_ key: String, _ fallback: Bool) -> Bool {
            defaults.object(forKey: "corptie.notifications.operations." + key) as? Bool ?? fallback
        }
        enabled = read("enabled", true)
        success = read("success", true)
        failure = read("failure", true)
        attention = read("attention", true)
        cancellation = read("cancellation", false)
        sound = read("sound", false)
        hideDetails = read("hideDetails", false)
        suppressWhenVisible = read("suppressWhenVisible", false)
        categories = defaults.dictionary(forKey: prefix + "categories") as? [String: Bool] ?? [:]
    }

    private func save(_ value: Bool, _ key: String) { defaults.set(value, forKey: prefix + key) }
    public func categoryEnabled(_ category: OperationNotificationCategory) -> Bool {
        categories[category.rawValue] ?? true
    }
    public func setCategory(_ category: OperationNotificationCategory, enabled: Bool) {
        categories[category.rawValue] = enabled
        defaults.set(categories, forKey: prefix + "categories")
    }
    public func allows(_ event: OperationNotificationEvent) -> Bool {
        guard enabled, categoryEnabled(event.category) else { return false }
        switch event.outcome {
        case .succeeded: return success
        case .partial, .failed: return failure
        case .attention, .unconfirmed: return attention
        case .cancelled: return cancellation
        }
    }
}

public struct OperationResultCounts: Codable, Equatable, Sendable {
    public let completed: Int
    public let failed: Int
    public let pending: Int
}

public struct OperationNotificationEvent: Codable, Equatable, Identifiable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let category: OperationNotificationCategory
    public let outcome: OperationNotificationOutcome
    public let name: String
    public let summary: String
    public let repositoryID: String?
    public let worktreeID: String?
    public let sessionID: String?
    public let jobID: String?
    public let counts: OperationResultCounts?
    public let occurredAt: Date

    public init(id: String = UUID().uuidString, category: OperationNotificationCategory,
                outcome: OperationNotificationOutcome, name: String, summary: String = "",
                repositoryID: String? = nil, worktreeID: String? = nil,
                sessionID: String? = nil, jobID: String? = nil, counts: OperationResultCounts? = nil, occurredAt: Date = Date()) {
        schemaVersion = 1
        self.id = id; self.category = category; self.outcome = outcome
        self.name = String(name.prefix(120)); self.summary = String(summary.prefix(180))
        self.repositoryID = repositoryID; self.worktreeID = worktreeID
        self.sessionID = sessionID; self.jobID = jobID; self.counts = counts; self.occurredAt = occurredAt
    }
}

/// A bounded projection of the existing product Job contract, shared by both clients.
/// Audit count is monotonic within a Job, unlike timestamps which can share a millisecond.
public struct OperationJobSnapshot: Decodable, Equatable, Sendable {
    public let id: String
    public let schemaVersion: Int?
    public let repositoryId: String
    public let status: String
    public let phase: String
    public let updatedAt: String
    public let currentWorktreeId: String?
    public let audit: [Audit]
    public let revision: Int?
    public let plan: Plan
    public let conflictAutomation: Conflict?
    public let conflictResolution: Conflict?
    public let counts: OperationResultCounts?
    public let attentionKey: String?
    public let resultKind: String?
    public struct Audit: Decodable, Equatable, Sendable { public let event: String }
    public struct Plan: Decodable, Equatable, Sendable { public let operationType: String? }
    public struct Conflict: Decodable, Equatable, Sendable { public let status: String }

    public var outcome: OperationNotificationOutcome? {
        switch status {
        case "completed": return .succeeded
        case "partial_completed": return .partial
        case "failed": return .failed
        case "canceled", "cancelled": return .cancelled
        case "paused":
            if conflictAutomation?.status == "running" || conflictResolution?.status == "running" { return nil }
            return phase == "failed" ? (resultKind == "partial" ? .partial : .failed) : .attention
        default: return nil
        }
    }
}

/// Stores only operations explicitly initiated on this device. Snapshot/replay reads
/// cannot turn unrelated historical jobs into notifications. No per-progress disk writes.
@MainActor
public final class OperationNotificationLedger {
    private struct Tracked: Codable {
        let id: String
        var revision: Int
        var updatedAt: String
        var result: String?
        var settled: Bool
        var resourceName: String?
        var kind: String?
    }
    private let defaults: UserDefaults
    private let key: String
    private var tracked: [Tracked]
    private var consumed: [String]
    public private(set) var results: [OperationNotificationEvent]
    public var deletionJobIDs: [String] { tracked.filter { !$0.settled && $0.kind == "task_delete" }.map(\.id) }
    public var recoverableJobIDs: [String] { tracked.filter { !$0.settled && $0.kind != "task_delete" }.map(\.id) }

    public init(defaults: UserDefaults, scope: String) {
        self.defaults = defaults
        key = "corptie.notifications.operations.ledger." + scope
        tracked = defaults.data(forKey: key + ".jobs").flatMap { try? JSONDecoder().decode([Tracked].self, from: $0) } ?? []
        consumed = defaults.stringArray(forKey: key + ".consumed") ?? []
        results = defaults.data(forKey: key + ".results").flatMap {
            try? JSONDecoder().decode([OperationNotificationEvent].self, from: $0)
        } ?? []
    }

    public func track(jobID: String, resourceName: String? = nil, kind: String? = nil) {
        guard !tracked.contains(where: { $0.id == jobID }) else { return }
        tracked.append(Tracked(id: jobID, revision: -1, updatedAt: "", result: nil, settled: false, resourceName: resourceName.map { String($0.prefix(100)) }, kind: kind))
        tracked = Array(tracked.suffix(128))
        persistJobs()
    }

    public func observe(_ job: OperationJobSnapshot) -> OperationNotificationEvent? {
        guard job.schemaVersion == nil || job.schemaVersion == 1 else { return nil }
        guard let index = tracked.firstIndex(where: { $0.id == job.id }) else { return nil }
        let previous = tracked[index]
        guard (job.revision ?? job.audit.count) >= previous.revision, job.updatedAt >= previous.updatedAt else { return nil }
        let outcome = job.outcome
        let fingerprint = outcome.map { "\($0.rawValue):\(job.phase):\(job.currentWorktreeId ?? ""):\(job.attentionKey ?? "")" }
        // In-memory ordering follows progress; persistence only follows semantic transitions.
        tracked[index].revision = (job.revision ?? job.audit.count)
        tracked[index].updatedAt = job.updatedAt
        guard previous.result != fingerprint || previous.revision == -1 else { return nil }
        tracked[index].result = fingerprint
        tracked[index].settled = ["completed", "partial_completed", "failed", "canceled", "cancelled"].contains(job.status)
        persistJobs()
        guard let outcome else { return nil }
        let name = job.plan.operationType == "task_delete" ? "Task cleanup"
            : job.plan.operationType == "sync" ? "Worktree synchronization"
            : job.plan.operationType == "converge" ? "Worktree convergence" : "Worktree integration"
        let dateParser = ISO8601DateFormatter()
        dateParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let occurredAt = dateParser.date(from: job.updatedAt) ?? Date()
        return OperationNotificationEvent(id: "job:\(job.id):\((job.revision ?? job.audit.count)):\(outcome.rawValue)",
            category: .worktree, outcome: outcome, name: name, summary: previous.resourceName ?? "",
            repositoryID: job.repositoryId.isEmpty ? nil : job.repositoryId, worktreeID: job.currentWorktreeId, jobID: job.id, counts: job.counts, occurredAt: occurredAt)
    }

    /// Consume disabled events too: enabling a switch must not replay old results.
    public func consume(_ event: OperationNotificationEvent) -> Bool {
        guard !consumed.contains(event.id) else { return false }
        consumed.append(event.id); consumed = Array(consumed.suffix(512))
        results.append(event); results = Array(results.suffix(64))
        defaults.set(consumed, forKey: key + ".consumed")
        defaults.set(try? JSONEncoder().encode(results), forKey: key + ".results")
        return true
    }

    private func persistJobs() { defaults.set(try? JSONEncoder().encode(tracked), forKey: key + ".jobs") }
}
