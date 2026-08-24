import Foundation

enum ScheduledSessionScheduleType: String, Codable, CaseIterable, Sendable {
    case once
    case interval
    case condition
    case process
}

enum ScheduledSessionMissedPolicy: String, Codable, CaseIterable, Sendable {
    case coalesceOnce = "coalesce_once"
    case skip
}

enum ScheduledSessionTaskAction: String, CaseIterable, Sendable {
    case pause
    case resume
    case cancel
    case runNow = "run"
    case retry
}

enum ScheduledSessionAPIContract {
    static let collectionPath = "scheduled-session-tasks"

    static func itemPath(taskId: String) -> String {
        "\(collectionPath)/\(taskId)"
    }

    static func actionPath(taskId: String, action: ScheduledSessionTaskAction) -> String {
        let backendAction = action == .retry ? ScheduledSessionTaskAction.resume.rawValue : action.rawValue
        return "\(itemPath(taskId: taskId))/\(backendAction)"
    }
}

/// Plan lifecycle is intentionally separate from the status of an individual run.
/// Unknown values are retained and surfaced instead of being decoded as a known success state.
struct ScheduledSessionTaskStatus: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String

    init(rawValue: String) { self.rawValue = rawValue }

    static let active = Self(rawValue: "active")
    static let cancelled = Self(rawValue: "cancelled")
    static let completed = Self(rawValue: "completed")
    static let expired = Self(rawValue: "expired")
    static let error = Self(rawValue: "error")

    var permitsEditing: Bool { self == .active || self == .error }
    var permitsPause: Bool { false }
    var permitsResume: Bool { self == .error }
    var permitsCancel: Bool { self == .active || self == .error }
    var permitsRunNow: Bool { self == .active }
}

struct ScheduledSessionRunStatus: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String

    init(rawValue: String) { self.rawValue = rawValue }

    static let missed = Self(rawValue: "missed")
    static let claimed = Self(rawValue: "claimed")
    static let retryWait = Self(rawValue: "retry_wait")
    static let queued = Self(rawValue: "queued")
    static let running = Self(rawValue: "running")
    static let completed = Self(rawValue: "completed")
    static let failed = Self(rawValue: "failed")
    static let cancelled = Self(rawValue: "cancelled")
    static let skipped = Self(rawValue: "skipped")

    /// Provider-neutral presentation state. `claimed` means due/firing, never running.
    var presentation: ScheduledSessionRunPresentation {
        switch rawValue {
        case "missed": .missed
        case "claimed": .due
        case "retry_wait": .failed
        case "queued": .queued
        case "running": .running
        case "completed": .completed
        case "failed": .failed
        case "cancelled": .cancelled
        case "skipped": .missed
        default: .unknown(rawValue)
        }
    }
}

enum ScheduledSessionRunPresentation: Equatable, Sendable {
    case scheduled
    case due
    case queued
    case running
    case completed
    case failed
    case paused
    case cancelled
    case expired
    case missed
    case unknown(String)
}

struct ScheduledSessionRun: Identifiable, Codable, Equatable, Sendable {
    var id: String { runId }
    let runId: String
    let taskId: String
    let scheduledFor: String
    let triggerKind: String
    let triggerReason: String
    let status: ScheduledSessionRunStatus
    let attemptCount: Int
    let agentWorkItemId: String?
    let targetTurnId: String?
    let bindingId: String?
    let providerSessionId: String?
    let routingVersion: Int?
    let stages: [AutomationRunStage]?
    let actionResults: [AutomationActionResult]?
    let deadlineAt: String?
    let errorCode: String?
    let errorMessage: String?
    let claimedAt: String?
    let queuedAt: String?
    let startedAt: String?
    let completedAt: String?
    let createdAt: String
    let updatedAt: String

    init(
        runId: String,
        taskId: String,
        scheduledFor: String,
        triggerKind: String,
        triggerReason: String,
        status: ScheduledSessionRunStatus,
        attemptCount: Int,
        agentWorkItemId: String? = nil,
        targetTurnId: String? = nil,
        bindingId: String? = nil,
        providerSessionId: String? = nil,
        routingVersion: Int? = nil,
        stages: [AutomationRunStage]? = nil,
        actionResults: [AutomationActionResult]? = nil,
        deadlineAt: String? = nil,
        errorCode: String? = nil,
        errorMessage: String? = nil,
        claimedAt: String? = nil,
        queuedAt: String? = nil,
        startedAt: String? = nil,
        completedAt: String? = nil,
        createdAt: String,
        updatedAt: String
    ) {
        self.runId = runId
        self.taskId = taskId
        self.scheduledFor = scheduledFor
        self.triggerKind = triggerKind
        self.triggerReason = triggerReason
        self.status = status
        self.attemptCount = attemptCount
        self.agentWorkItemId = agentWorkItemId
        self.targetTurnId = targetTurnId
        self.bindingId = bindingId
        self.providerSessionId = providerSessionId
        self.routingVersion = routingVersion
        self.stages = stages
        self.actionResults = actionResults
        self.deadlineAt = deadlineAt
        self.errorCode = errorCode
        self.errorMessage = errorMessage
        self.claimedAt = claimedAt
        self.queuedAt = queuedAt
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

struct AutomationRunStage: Codable, Equatable, Sendable {
    let name: String
    let status: String
    let at: String
}

struct AutomationActionResult: Codable, Equatable, Sendable {
    let type: String
    let status: String
    let workItemId: String?
    let completedAt: String?
}

struct AutomationTrigger: Decodable, Equatable, Sendable {
    let type: String
    let at: String?
    let delaySeconds: Int?
    let startAt: String?
    let intervalSeconds: Int?
}

struct AutomationAction: Decodable, Equatable, Sendable {
    let type: String
    let title: String?
    let body: String?
}

struct AutomationPolicy: Decodable, Equatable, Sendable {
    let misfire: String
    let maxCatchUpRuns: Int
    let maxConcurrentRuns: Int
    let timeoutSeconds: Int
    let backpressureLimit: Int
}

struct AutomationRisk: Decodable, Equatable, Sendable {
    let level: String
    let summary: String?
    let remoteWrite: Bool
    let destructive: Bool
}

struct ScheduledSessionTask: Identifiable, Decodable, Equatable, Sendable {
    var id: String { taskId }
    let taskId: String
    let logicalSessionId: String
    let name: String
    let message: String
    let trigger: AutomationTrigger?
    let actions: [AutomationAction]
    let policy: AutomationPolicy?
    let risk: AutomationRisk?
    let scheduleType: ScheduledSessionScheduleType
    let runAt: String?
    let nextRunAt: String?
    let expiresAt: String
    let intervalSeconds: Int?
    let timezone: String
    let status: ScheduledSessionTaskStatus
    let missedPolicy: ScheduledSessionMissedPolicy
    let lastRunId: String?
    let lastRunStatus: ScheduledSessionRunStatus?
    let lastErrorCode: String?
    let lastErrorMessage: String?
    let lastRunAt: String?
    let resourceVersion: Int
    let createdAt: String
    let updatedAt: String
    let pausedAt: String?
    let cancelledAt: String?
    let completedAt: String?
    let runs: [ScheduledSessionRun]

    var presentationStatus: ScheduledSessionRunPresentation {
        if status == .cancelled { return .cancelled }
        if status == .completed { return .completed }
        if status == .expired { return .expired }
        if status == .error { return .failed }
        if let lastRunStatus {
            switch lastRunStatus.presentation {
            case .completed where scheduleType == .interval && nextRunAt != nil:
                return .scheduled
            default:
                return lastRunStatus.presentation
            }
        }
        return .scheduled
    }

    var operationsDisabledReason: String? {
        guard let lastErrorCode,
              ["SESSION_NOT_FOUND", "SESSION_ARCHIVED", "AGENT_NOT_FOUND", "ROUTE_UNAVAILABLE",
               "AUTHORIZATION_REVOKED", "ENVIRONMENT_MISMATCH"].contains(lastErrorCode) else { return nil }
        return [lastErrorCode, lastErrorMessage].compactMap { $0 }.joined(separator: " · ")
    }

    private enum CodingKeys: String, CodingKey {
        case taskId, logicalSessionId, name, message, trigger, actions, policy, risk
        case scheduleType, runAt, nextRunAt, expiresAt, intervalSeconds
        case timezone, status, missedPolicy, lastRunId, lastRunStatus, lastErrorCode
        case lastErrorMessage, lastRunAt, resourceVersion, createdAt, updatedAt, pausedAt
        case cancelledAt, completedAt, runs, runHistory
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try values.decode(String.self, forKey: .taskId)
        logicalSessionId = try values.decode(String.self, forKey: .logicalSessionId)
        if let text = try? values.decode(String.self, forKey: .message) {
            message = text
        } else {
            let structured = try values.decode(StructuredMessage.self, forKey: .message)
            message = structured.text
        }
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? message
        trigger = try values.decodeIfPresent(AutomationTrigger.self, forKey: .trigger)
        actions = try values.decodeIfPresent([AutomationAction].self, forKey: .actions) ?? []
        policy = try values.decodeIfPresent(AutomationPolicy.self, forKey: .policy)
        risk = try values.decodeIfPresent(AutomationRisk.self, forKey: .risk)
        scheduleType = try values.decode(ScheduledSessionScheduleType.self, forKey: .scheduleType)
        runAt = try values.decodeIfPresent(String.self, forKey: .runAt)
        nextRunAt = try values.decodeIfPresent(String.self, forKey: .nextRunAt)
        expiresAt = try values.decode(String.self, forKey: .expiresAt)
        intervalSeconds = try values.decodeIfPresent(Int.self, forKey: .intervalSeconds)
        timezone = try values.decode(String.self, forKey: .timezone)
        status = try values.decode(ScheduledSessionTaskStatus.self, forKey: .status)
        missedPolicy = try values.decode(ScheduledSessionMissedPolicy.self, forKey: .missedPolicy)
        lastRunId = try values.decodeIfPresent(String.self, forKey: .lastRunId)
        lastRunStatus = try values.decodeIfPresent(ScheduledSessionRunStatus.self, forKey: .lastRunStatus)
        lastErrorCode = try values.decodeIfPresent(String.self, forKey: .lastErrorCode)
        lastErrorMessage = try values.decodeIfPresent(String.self, forKey: .lastErrorMessage)
        lastRunAt = try values.decodeIfPresent(String.self, forKey: .lastRunAt)
        resourceVersion = try values.decodeIfPresent(Int.self, forKey: .resourceVersion) ?? 0
        createdAt = try values.decode(String.self, forKey: .createdAt)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
        pausedAt = try values.decodeIfPresent(String.self, forKey: .pausedAt)
        cancelledAt = try values.decodeIfPresent(String.self, forKey: .cancelledAt)
        completedAt = try values.decodeIfPresent(String.self, forKey: .completedAt)
        runs = try values.decodeIfPresent([ScheduledSessionRun].self, forKey: .runs)
            ?? values.decodeIfPresent([ScheduledSessionRun].self, forKey: .runHistory)
            ?? []
    }

    private struct StructuredMessage: Decodable {
        let text: String
    }

    init(
        taskId: String,
        logicalSessionId: String,
        name: String? = nil,
        message: String,
        trigger: AutomationTrigger? = nil,
        actions: [AutomationAction] = [],
        policy: AutomationPolicy? = nil,
        risk: AutomationRisk? = nil,
        scheduleType: ScheduledSessionScheduleType,
        runAt: String?,
        nextRunAt: String?,
        expiresAt: String = "2099-12-31T23:59:59.000Z",
        intervalSeconds: Int?,
        timezone: String,
        status: ScheduledSessionTaskStatus,
        missedPolicy: ScheduledSessionMissedPolicy,
        lastRunId: String? = nil,
        lastRunStatus: ScheduledSessionRunStatus? = nil,
        lastErrorCode: String? = nil,
        lastErrorMessage: String? = nil,
        lastRunAt: String? = nil,
        resourceVersion: Int = 1,
        createdAt: String,
        updatedAt: String,
        pausedAt: String? = nil,
        cancelledAt: String? = nil,
        completedAt: String? = nil,
        runs: [ScheduledSessionRun] = []
    ) {
        self.taskId = taskId
        self.logicalSessionId = logicalSessionId
        self.name = name ?? message
        self.message = message
        self.trigger = trigger
        self.actions = actions
        self.policy = policy
        self.risk = risk
        self.scheduleType = scheduleType
        self.runAt = runAt
        self.nextRunAt = nextRunAt
        self.expiresAt = expiresAt
        self.intervalSeconds = intervalSeconds
        self.timezone = timezone
        self.status = status
        self.missedPolicy = missedPolicy
        self.lastRunId = lastRunId
        self.lastRunStatus = lastRunStatus
        self.lastErrorCode = lastErrorCode
        self.lastErrorMessage = lastErrorMessage
        self.lastRunAt = lastRunAt
        self.resourceVersion = resourceVersion
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.pausedAt = pausedAt
        self.cancelledAt = cancelledAt
        self.completedAt = completedAt
        self.runs = runs
    }
}

struct ScheduledSessionTaskListEnvelope: Decodable, Sendable {
    let tasks: [ScheduledSessionTask]
}

struct ScheduledSessionTaskEnvelope: Decodable, Sendable {
    let task: ScheduledSessionTask
}

struct ScheduledSessionTaskDraft: Equatable, Sendable {
    var message: String
    var scheduleType: ScheduledSessionScheduleType
    var runAt: Date
    var intervalSeconds: Int
    var timezone: String
    var missedPolicy: ScheduledSessionMissedPolicy
    var expiresAt: Date = .distantFuture

    static func fresh(message: String = "", now: Date = Date(), timezone: TimeZone = .current) -> Self {
        Self(
            message: message,
            scheduleType: .once,
            runAt: now.addingTimeInterval(5 * 60),
            intervalSeconds: 60 * 60,
            timezone: timezone.identifier,
            missedPolicy: .coalesceOnce,
            expiresAt: now.addingTimeInterval(30 * 24 * 60 * 60)
        )
    }

    func validationError(now: Date = Date()) -> ScheduledSessionValidationError? {
        if message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .emptyMessage }
        guard TimeZone(identifier: timezone) != nil else { return .invalidTimezone }
        if expiresAt <= now { return .pastExpiration }
        switch scheduleType {
        case .once:
            if runAt <= now { return .pastRunAt }
            if runAt >= expiresAt { return .expirationBeforeRun }
        case .interval:
            if intervalSeconds < 60 || intervalSeconds > 31_536_000 { return .invalidInterval }
        case .condition, .process:
            return .unsupportedTrigger
        }
        return nil
    }

    func requestBody() -> [String: Any] {
        var body: [String: Any] = [
            "message": ["text": message.trimmingCharacters(in: .whitespacesAndNewlines)],
            "scheduleType": scheduleType.rawValue,
            "timezone": timezone,
            "missedPolicy": missedPolicy.rawValue,
            "expiresAt": ScheduledSessionDateFormatting.string(from: expiresAt)
        ]
        switch scheduleType {
        case .once: body["runAt"] = ScheduledSessionDateFormatting.string(from: runAt)
        case .interval: body["intervalSeconds"] = intervalSeconds
        case .condition, .process: break
        }
        return body
    }
}

enum ScheduledSessionValidationError: String, Error, Equatable, Sendable {
    case emptyMessage
    case pastRunAt
    case invalidInterval
    case invalidTimezone
    case pastExpiration
    case expirationBeforeRun
    case unsupportedTrigger
}

extension ScheduledSessionValidationError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .emptyMessage: "定时消息不能为空。"
        case .pastRunAt: "执行时间必须晚于当前时间。"
        case .invalidInterval: "固定间隔必须在 1 分钟到 365 天之间。"
        case .invalidTimezone: "请选择有效的 IANA 时区。"
        case .pastExpiration: "过期时间必须晚于当前时间。"
        case .expirationBeforeRun: "过期时间必须晚于首次执行时间。"
        case .unsupportedTrigger: "请在 Automations Tab 中管理该事件触发器。"
        }
    }
}

enum ScheduledSessionDateFormatting {
    private static func internet() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }

    static func string(from date: Date) -> String { internet().string(from: date) }

    static func date(from value: String?) -> Date? {
        guard let value else { return nil }
        if let parsed = internet().date(from: value) { return parsed }
        let fallback = ISO8601DateFormatter()
        fallback.formatOptions = [.withInternetDateTime]
        return fallback.date(from: value)
    }
}

enum ScheduledSessionManagementTimeFormatting {
    static func string(
        from value: String?,
        timeZone: TimeZone = .autoupdatingCurrent,
        locale: Locale = .current
    ) -> String? {
        guard let date = ScheduledSessionDateFormatting.date(from: value) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateStyle = .medium
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }

    static func timeZoneLabel(
        _ timeZone: TimeZone = .autoupdatingCurrent,
        at date: Date = Date()
    ) -> String {
        let offset = timeZone.secondsFromGMT(for: date)
        let sign = offset >= 0 ? "+" : "-"
        let absolute = abs(offset)
        return String(
            format: "%@ (UTC%@%02d:%02d)",
            timeZone.identifier,
            sign,
            absolute / 3_600,
            (absolute % 3_600) / 60
        )
    }
}

enum ScheduledSessionEventMapping {
    static let authoritativeEventNames: Set<String> = [
        "ScheduledSessionTaskCreated",
        "ScheduledSessionTaskUpdated",
        "ScheduledSessionTaskDue",
        "ScheduledSessionTaskPaused",
        "ScheduledSessionTaskResumed",
        "ScheduledSessionTaskCancelled",
        "ScheduledSessionTaskExpired",
        "ScheduledSessionRunMissed",
        "ScheduledSessionRunQueued",
        "ScheduledSessionRunStarted",
        "ScheduledSessionRunCompleted",
        "ScheduledSessionRunFailed",
        "ScheduledSessionRunCancelled"
    ]

    static func sessionId(from data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = object["payload"] as? [String: Any] else { return nil }
        return payload["logicalSessionId"] as? String
            ?? (payload["task"] as? [String: Any])?["logicalSessionId"] as? String
    }
}
