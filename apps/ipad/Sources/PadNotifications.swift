import Foundation
import Observation
import CorptieClientCore

enum PadSessionNotificationKind: String, Equatable {
    case completed
    case blocked
    case failed
    case allSessionsWaiting
}

struct PadSessionNotificationConfiguration: Equatable {
    var notifyOnComplete: Bool
    var notifyOnBlocked: Bool
    var notifyOnFailed: Bool
    var notifyWhenAllSessionsWaiting: Bool
}

struct PadSessionNotificationSnapshot: Equatable {
    let id: String
    let title: String
    let status: SessionExecutionState
    let updatedAt: String
    let lastAgentMessageSequence: Int
    let lastReadMessageSequence: Int
    let resourceContext: NotificationResourceContext

    init?(_ session: ClientSession, resourceContext: NotificationResourceContext = .init()) {
        guard let status = SessionExecutionState(executionStatus: session.executionStatus) else { return nil }
        id = session.id
        title = session.title
        self.status = status
        updatedAt = session.updatedAt
        lastAgentMessageSequence = session.lastAgentMessageSequence
        lastReadMessageSequence = session.lastReadMessageSequence
        self.resourceContext = resourceContext
    }

    init(
        id: String,
        title: String,
        status: SessionExecutionState,
        updatedAt: String,
        lastAgentMessageSequence: Int = 0,
        lastReadMessageSequence: Int = 0,
        resourceContext: NotificationResourceContext = .init()
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.updatedAt = updatedAt
        self.lastAgentMessageSequence = lastAgentMessageSequence
        self.lastReadMessageSequence = lastReadMessageSequence
        self.resourceContext = resourceContext
    }

    var needsUserAttention: Bool {
        SessionReadAttention.needsUserAttention(
            executionStatus: status.rawValue,
            lastAgentMessageSequence: lastAgentMessageSequence,
            lastReadMessageSequence: lastReadMessageSequence
        )
    }
}

struct PadSessionNotificationCounts: Equatable {
    let completed: Int
    let blocked: Int
    let failed: Int
    let pendingUserAttention: Int
    var total: Int { completed + blocked + failed }
}

struct PadSessionNotificationEvent: Equatable {
    let id: String
    let kind: PadSessionNotificationKind
    let session: PadSessionNotificationSnapshot?
    let counts: PadSessionNotificationCounts?
}

enum PadNotificationIdentity {
    static func allSessionsWaiting(for sessions: [PadSessionNotificationSnapshot]) -> String {
        let fingerprint = sessions
            .sorted { $0.id < $1.id }
            .map { "\($0.id):\($0.status.rawValue):\($0.updatedAt)" }
            .joined(separator: "|")
        return "all-sessions-waiting:v2:\(stableDigest(fingerprint))"
    }

    static func stableDigest(_ value: String) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return String(format: "%016llx", hash)
    }
}

/// The same transition reducer used by macOS: the first snapshot establishes a
/// baseline, completion waits for durable unread agent output, and the final
/// individual transition is replaced by one aggregate notification.
struct PadSessionNotificationReducer {
    private var previousStatusesBySessionID: [String: SessionExecutionState] = [:]
    private var previousAttentionBySessionID: [String: Bool] = [:]
    private var hasObservedInitialSnapshot = false

    mutating func events(
        for sessions: [PadSessionNotificationSnapshot],
        configuration: PadSessionNotificationConfiguration
    ) -> [PadSessionNotificationEvent] {
        let hasRunningSession = sessions.contains { $0.status == .running }

        guard hasObservedInitialSnapshot else {
            previousStatusesBySessionID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0.status) })
            previousAttentionBySessionID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0.needsUserAttention) })
            hasObservedInitialSnapshot = true
            return []
        }

        let terminalTransitions = sessions.filter { session in
            let previousStatus = previousStatusesBySessionID[session.id]
            switch session.status {
            case .complete:
                return session.needsUserAttention && previousAttentionBySessionID[session.id] != true
            case .blocked, .failed:
                return previousStatus == .running
            case .running, .cancelled:
                return false
            }
        }

        let currentIDs = Set(sessions.map(\.id))
        previousStatusesBySessionID = previousStatusesBySessionID.filter { currentIDs.contains($0.key) }
        previousAttentionBySessionID = previousAttentionBySessionID.filter { currentIDs.contains($0.key) }
        for session in sessions {
            previousStatusesBySessionID[session.id] = session.status
            previousAttentionBySessionID[session.id] = session.needsUserAttention
        }

        if configuration.notifyWhenAllSessionsWaiting,
           !hasRunningSession,
           !terminalTransitions.isEmpty {
            let counts = PadSessionNotificationCounts(
                completed: sessions.filter { $0.status == .complete }.count,
                blocked: sessions.filter { $0.status == .blocked }.count,
                failed: sessions.filter { $0.status == .failed }.count,
                pendingUserAttention: sessions.filter(\.needsUserAttention).count
            )
            if counts.total > 0 {
                return [PadSessionNotificationEvent(
                    id: PadNotificationIdentity.allSessionsWaiting(for: sessions),
                    kind: .allSessionsWaiting,
                    session: nil,
                    counts: counts
                )]
            }
        }

        return terminalTransitions.compactMap { session in
            let kind: PadSessionNotificationKind
            let enabled: Bool
            switch session.status {
            case .complete: kind = .completed; enabled = configuration.notifyOnComplete
            case .blocked: kind = .blocked; enabled = configuration.notifyOnBlocked
            case .failed: kind = .failed; enabled = configuration.notifyOnFailed
            case .running, .cancelled: return nil
            }
            guard enabled else { return nil }
            let revision = session.status == .complete
                ? String(session.lastAgentMessageSequence)
                : session.updatedAt
            return PadSessionNotificationEvent(
                id: "session:\(session.id):\(session.status.rawValue):\(revision)",
                kind: kind,
                session: session,
                counts: nil
            )
        }
    }
}

enum PadAutomationNotificationKind: String, Equatable {
    case completed, failed, cancelled, expired
}

struct PadAutomationNotificationEvent: Equatable {
    let id: String
    let kind: PadAutomationNotificationKind
    let automationID: String
    let logicalSessionID: String?
    let name: String
    let resourceContext: NotificationResourceContext
}

/// Device clients receive the provider-neutral Automation projection rather
/// than raw backend events. Its updatedAt + terminal status form the durable
/// event identity; periodic completions intentionally reuse one identifier.
struct PadAutomationNotificationReducer {
    private var fingerprintsByID: [String: String] = [:]
    private var hasObservedInitialSnapshot = false

    mutating func events(
        for items: [ClientControlItem],
        resourceIndex: NotificationResourceIndex = .init()
    ) -> [PadAutomationNotificationEvent] {
        let current = Dictionary(uniqueKeysWithValues: items.map { item in
            (item.id, "\(item.lastRunStatus ?? ""):\(item.updatedAt ?? "")")
        })
        guard hasObservedInitialSnapshot else {
            fingerprintsByID = current
            hasObservedInitialSnapshot = true
            return []
        }
        defer { fingerprintsByID = current }

        return items.compactMap { item in
            let fingerprint = current[item.id] ?? ""
            guard fingerprintsByID[item.id] != fingerprint,
                  let kind = Self.kind(item.lastRunStatus, taskStatus: item.status) else { return nil }
            let id = kind == .completed && item.scheduleType == "interval"
                ? "automation-periodic-completed:\(PadNotificationIdentity.stableDigest(item.id))"
                : "automation-terminal:\(PadNotificationIdentity.stableDigest("\(item.id):\(fingerprint)"))"
            return PadAutomationNotificationEvent(
                id: id,
                kind: kind,
                automationID: item.id,
                logicalSessionID: item.logicalSessionId,
                name: item.name,
                resourceContext: resourceIndex.context(forSessionID: item.logicalSessionId)
            )
        }
    }

    private static func kind(_ runStatus: String?, taskStatus: String?) -> PadAutomationNotificationKind? {
        switch runStatus?.lowercased() {
        case "completed": .completed
        case "failed", "missed", "skipped": .failed
        case "cancelled", "canceled": .cancelled
        default:
            switch taskStatus?.lowercased() {
            case "expired": .expired
            case "cancelled", "canceled": .cancelled
            default: nil
            }
        }
    }
}

enum PadNotificationContent {
    static func sessionBody(_ session: PadSessionNotificationSnapshot) -> String {
        [session.resourceContext.displayLine(), "会话：\(session.title)"]
            .compactMap { $0 }
            .joined(separator: "\n")
    }

    static func automationBody(_ event: PadAutomationNotificationEvent) -> String {
        [event.resourceContext.displayLine(), "计划任务：\(event.name)"]
            .compactMap { $0 }
            .joined(separator: "\n")
    }
}

struct PadNotificationDeliveryHistory {
    private let defaults: UserDefaults
    private let key: String
    private let limit: Int
    private var orderedIDs: [String]
    private var ids: Set<String>

    init(defaults: UserDefaults = .standard, key: String, limit: Int = 256) {
        self.defaults = defaults
        self.key = key
        self.limit = limit
        orderedIDs = defaults.stringArray(forKey: key) ?? []
        ids = Set(orderedIDs)
    }

    func contains(_ id: String) -> Bool { ids.contains(id) }

    mutating func record(_ id: String) {
        guard ids.insert(id).inserted else { return }
        orderedIDs.append(id)
        orderedIDs = Array(orderedIDs.suffix(limit))
        ids = Set(orderedIDs)
        defaults.set(orderedIDs, forKey: key)
    }
}

@MainActor @Observable
final class PadNotificationPreferences {
    static let shared = PadNotificationPreferences()

    private enum Key {
        static let complete = "corptie.notifications.sessionComplete"
        static let blocked = "corptie.notifications.sessionBlocked"
        static let failed = "corptie.notifications.sessionFailed"
        static let allWaiting = "corptie.notifications.allSessionsWaiting"
        static let automations = "corptie.notifications.automations"
        static let waitingSound = "corptie.allSessionsWaitingNotificationSound"
    }

    @ObservationIgnored private let defaults: UserDefaults
    var notifyOnComplete: Bool { didSet { defaults.set(notifyOnComplete, forKey: Key.complete) } }
    var notifyOnBlocked: Bool { didSet { defaults.set(notifyOnBlocked, forKey: Key.blocked) } }
    var notifyOnFailed: Bool { didSet { defaults.set(notifyOnFailed, forKey: Key.failed) } }
    var notifyWhenAllSessionsWaiting: Bool { didSet { defaults.set(notifyWhenAllSessionsWaiting, forKey: Key.allWaiting) } }
    var notifyOnAutomations: Bool { didSet { defaults.set(notifyOnAutomations, forKey: Key.automations) } }
    var waitingSoundEnabled: Bool { didSet { defaults.set(waitingSoundEnabled ? "default" : "none", forKey: Key.waitingSound) } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        notifyOnComplete = defaults.object(forKey: Key.complete) as? Bool ?? false
        notifyOnBlocked = defaults.object(forKey: Key.blocked) as? Bool ?? false
        notifyOnFailed = defaults.object(forKey: Key.failed) as? Bool ?? false
        notifyWhenAllSessionsWaiting = defaults.object(forKey: Key.allWaiting) as? Bool ?? true
        notifyOnAutomations = defaults.object(forKey: Key.automations) as? Bool ?? true
        waitingSoundEnabled = defaults.string(forKey: Key.waitingSound) != "none"
    }

    var configuration: PadSessionNotificationConfiguration {
        PadSessionNotificationConfiguration(
            notifyOnComplete: notifyOnComplete,
            notifyOnBlocked: notifyOnBlocked,
            notifyOnFailed: notifyOnFailed,
            notifyWhenAllSessionsWaiting: notifyWhenAllSessionsWaiting
        )
    }
}

#if canImport(UIKit)
import UIKit
@preconcurrency import UserNotifications

extension Notification.Name {
    static let padNotificationNavigationRequested = Notification.Name("PadNotificationNavigationRequested")
}

@MainActor
final class PadNotificationManager {
    static let shared = PadNotificationManager()

    private let center = UNUserNotificationCenter.current()
    private let preferences = PadNotificationPreferences.shared
    private var sessionReducer = PadSessionNotificationReducer()
    private var automationReducer = PadAutomationNotificationReducer()
    private var sessionHistory = PadNotificationDeliveryHistory(
        key: "corptie.notifications.deliveredEventIds"
    )
    private var automationHistory = PadNotificationDeliveryHistory(
        key: "corptie.notifications.deliveredAutomationEventIds"
    )
    private var inFlight = Set<String>()
    private var scope = ""
    private var pendingNavigation: [AnyHashable: Any]?
    private(set) var visibleSessionID: String?
    private(set) var visibleTab: PadTab = .workspace
    private(set) var sceneIsActive = false

    func setScope(_ scope: String) {
        guard self.scope != scope else { return }
        self.scope = scope
        sessionReducer = PadSessionNotificationReducer()
        automationReducer = PadAutomationNotificationReducer()
        inFlight.removeAll()
    }

    func updateVisibility(sessionID: String?, tab: PadTab, sceneIsActive: Bool) {
        visibleSessionID = sessionID
        visibleTab = tab
        self.sceneIsActive = sceneIsActive
    }

    func requestAuthorizationIfNeeded() async {
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func syncSessions(_ sessions: [ClientSession], works: [ClientWork], tasks: [ClientTask]) {
        let resourceIndex = NotificationResourceIndex(works: works, tasks: tasks, sessions: sessions)
        let snapshots = sessions.compactMap {
            PadSessionNotificationSnapshot($0, resourceContext: resourceIndex.context(forSessionID: $0.id))
        }
        for event in sessionReducer.events(for: snapshots, configuration: preferences.configuration) {
            enqueue(event)
        }
    }

    func syncAutomations(
        _ items: [ClientControlItem],
        works: [ClientWork],
        tasks: [ClientTask],
        sessions: [ClientSession]
    ) {
        let resourceIndex = NotificationResourceIndex(works: works, tasks: tasks, sessions: sessions)
        let events = automationReducer.events(for: items, resourceIndex: resourceIndex)
        guard preferences.notifyOnAutomations else { return }
        for event in events { enqueue(event) }
    }

    func sendTestNotification() async {
        await requestAuthorizationIfNeeded()
        let content = UNMutableNotificationContent()
        content.title = "通知测试"
        content.body = "Corptie 任务通知已启用。"
        content.sound = preferences.waitingSoundEnabled ? .default : nil
        try? await center.add(UNNotificationRequest(
            identifier: "corptie-notification-test-\(UUID().uuidString)",
            content: content,
            trigger: nil
        ))
    }

    func presentationOptions(for notification: UNNotification) -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        if let sessionID = info["sessionId"] as? String,
           sceneIsActive, visibleTab == .workspace, visibleSessionID == sessionID {
            return []
        }
        if info["destination"] as? String == "overview",
           sceneIsActive, visibleTab == .workspace {
            return []
        }
        if info["destination"] as? String == "automation",
           sceneIsActive, visibleTab == .automations {
            return []
        }
        return [.banner, .list, .sound]
    }

    func handleResponse(_ response: UNNotificationResponse) {
        let info = response.notification.request.content.userInfo
        pendingNavigation = info
        NotificationCenter.default.post(
            name: .padNotificationNavigationRequested,
            object: nil,
            userInfo: info
        )
    }

    func takePendingNavigation() -> [AnyHashable: Any]? {
        defer { pendingNavigation = nil }
        return pendingNavigation
    }

    private func enqueue(_ event: PadSessionNotificationEvent) {
        guard !sessionHistory.contains(event.id), inFlight.insert(event.id).inserted else { return }
        Task { [weak self] in
            guard let self else { return }
            defer { self.inFlight.remove(event.id) }
            guard await self.ensureAuthorization() else { return }
            let content = UNMutableNotificationContent()
            switch event.kind {
            case .completed: content.title = "任务已完成"
            case .blocked: content.title = "任务等待交互"
            case .failed: content.title = "任务失败"
            case .allSessionsWaiting: content.title = "所有会话已结束处理"
            }
            if let session = event.session {
                content.body = PadNotificationContent.sessionBody(session)
                content.userInfo = ["sessionId": session.id, "destination": "session"]
            } else {
                content.body = "所有会话均已结束处理。需要你查看的会话：\(event.counts?.pendingUserAttention ?? 0)。"
                content.userInfo = ["destination": "overview"]
            }
            if event.kind == .allSessionsWaiting, self.preferences.waitingSoundEnabled {
                content.sound = .default
            }
            do {
                try await self.center.add(UNNotificationRequest(identifier: event.id, content: content, trigger: nil))
                self.sessionHistory.record(event.id)
            } catch { }
        }
    }

    private func enqueue(_ event: PadAutomationNotificationEvent) {
        guard !automationHistory.contains(event.id), inFlight.insert(event.id).inserted else { return }
        Task { [weak self] in
            guard let self else { return }
            defer { self.inFlight.remove(event.id) }
            guard await self.ensureAuthorization() else { return }
            let content = UNMutableNotificationContent()
            switch event.kind {
            case .completed: content.title = "计划任务已完成"
            case .failed: content.title = "计划任务失败"
            case .cancelled: content.title = "计划任务已取消"
            case .expired: content.title = "计划任务已过期"
            }
            content.body = PadNotificationContent.automationBody(event)
            var info = ["destination": "automation", "automationId": event.automationID]
            if let logicalSessionID = event.logicalSessionID { info["logicalSessionId"] = logicalSessionID }
            content.userInfo = info
            do {
                try await self.center.add(UNNotificationRequest(identifier: event.id, content: content, trigger: nil))
                self.automationHistory.record(event.id)
            } catch { }
        }
    }

    private func ensureAuthorization() async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true
        case .denied: return false
        @unknown default: return false
        }
    }
}

@MainActor
final class PadAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler(PadNotificationManager.shared.presentationOptions(for: notification))
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        PadNotificationManager.shared.handleResponse(response)
        completionHandler()
    }
}
#endif
