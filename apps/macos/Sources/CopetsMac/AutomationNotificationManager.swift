import Combine
import Foundation
import OSLog
@preconcurrency import UserNotifications

enum AutomationTerminalNotificationKind: String, Equatable, Sendable {
    case completed
    case failed
    case cancelled
    case expired
}

struct AutomationTerminalNotificationEvent: Equatable, Sendable {
    let eventID: String
    let kind: AutomationTerminalNotificationKind
    let automationID: String
    let logicalSessionID: String
    let name: String
    let message: String
    let isPeriodic: Bool

    static func decode(eventName: String, data: String) -> Self? {
        guard let bytes = data.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let payload = object["payload"] as? [String: Any],
              let task = payload["task"] as? [String: Any],
              let automationID = nonEmpty(task["taskId"] as? String),
              let logicalSessionID = nonEmpty(task["logicalSessionId"] as? String) else { return nil }
        let kind: AutomationTerminalNotificationKind
        switch eventName {
        case "ScheduledSessionRunCompleted": kind = .completed
        case "ScheduledSessionRunFailed":
            guard payload["willRetry"] as? Bool != true else { return nil }
            kind = .failed
        case "ScheduledSessionTaskCancelled": kind = .cancelled
        case "ScheduledSessionTaskExpired": kind = .expired
        default: return nil
        }
        let event = payload["event"] as? [String: Any]
        guard let eventID = nonEmpty(event?["eventId"] as? String)
            ?? nonEmpty(object["id"] as? String) else { return nil }
        let structuredMessage = task["message"] as? [String: Any]
        let message = nonEmpty(structuredMessage?["text"] as? String)
            ?? nonEmpty(task["message"] as? String)
            ?? ""
        return Self(
            eventID: eventID,
            kind: kind,
            automationID: automationID,
            logicalSessionID: logicalSessionID,
            name: nonEmpty(task["name"] as? String) ?? message,
            message: message,
            isPeriodic: (task["scheduleType"] as? String) == "interval"
        )
    }

    var notificationIdentifier: String {
        if kind == .completed && isPeriodic {
            return "automation-periodic-completed:\(stableDigest(automationID))"
        }
        return "automation-terminal:\(stableDigest(eventID))"
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    private func stableDigest(_ value: String) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return String(format: "%016llx", hash)
    }
}

@MainActor
final class AutomationNotificationManager {
    private static let logger = Logger(subsystem: "com.corptie.mac", category: "AutomationNotifications")

    private let client: BackendClient
    private let preferences: SessionNotificationPreferences
    private let defaults: UserDefaults
    private let notificationCenter: UNUserNotificationCenter?
    private var history: SessionNotificationDeliveryHistory
    private var inFlight = Set<String>()
    private var cancellables = Set<AnyCancellable>()

    init(
        client: BackendClient,
        preferences: SessionNotificationPreferences = .shared,
        defaults: UserDefaults = CorptieAppEnvironment.userDefaults,
        notificationCenter: UNUserNotificationCenter? = SystemNotificationCenter.currentIfAvailable()
    ) {
        self.client = client
        self.preferences = preferences
        self.defaults = defaults
        self.notificationCenter = notificationCenter
        history = SessionNotificationDeliveryHistory(
            defaults: defaults,
            storageKey: "corptie.notifications.deliveredAutomationEventIds"
        )
    }

    func start() {
        client.automationTerminalEvents
            .receive(on: RunLoop.main)
            .sink { [weak self] event in self?.enqueue(event) }
            .store(in: &cancellables)
    }

    func stop() {
        cancellables.removeAll()
        inFlight.removeAll()
    }

    private func enqueue(_ event: AutomationTerminalNotificationEvent) {
        guard preferences.notifyOnAutomations,
              !history.contains(event.eventID),
              inFlight.insert(event.eventID).inserted else { return }
        Task { [weak self] in
            guard let self else { return }
            defer { self.inFlight.remove(event.eventID) }
            do {
                try await self.deliver(event)
                guard !Task.isCancelled else { return }
                self.history.recordDelivered(event.eventID)
            } catch {
                Self.logger.error("Automation notification failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func deliver(_ event: AutomationTerminalNotificationEvent) async throws {
        guard let notificationCenter else {
            throw SessionNotificationDeliveryError.notificationCenterUnavailable
        }
        let settings = await notificationCenter.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            guard try await notificationCenter.requestAuthorization(options: [.alert]) else {
                throw SessionNotificationDeliveryError.authorizationDenied
            }
        case .denied: throw SessionNotificationDeliveryError.authorizationDenied
        case .authorized, .provisional, .ephemeral: break
        @unknown default: throw SessionNotificationDeliveryError.authorizationStatusUnknown
        }
        let content = UNMutableNotificationContent()
        content.title = AutomationNotificationContent.title(for: event)
        content.body = AutomationNotificationContent.body(for: event)
        content.userInfo = [
            "destination": "automation",
            "automationId": event.automationID,
            "logicalSessionId": event.logicalSessionID
        ]
        try await notificationCenter.add(UNNotificationRequest(
            identifier: event.notificationIdentifier,
            content: content,
            trigger: nil
        ))
    }
}

@MainActor
enum AutomationNotificationContent {
    static func title(for event: AutomationTerminalNotificationEvent) -> String {
        switch event.kind {
        case .completed: L10n("计划任务已完成")
        case .failed: L10n("计划任务失败")
        case .cancelled: L10n("计划任务已取消")
        case .expired: L10n("计划任务已过期")
        }
    }

    static func body(for event: AutomationTerminalNotificationEvent) -> String {
        let message = event.message.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? event.name : "\(event.name)\n\(String(message.prefix(180)))"
    }
}
