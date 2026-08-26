import AppKit
import Combine
import Foundation
import OSLog
@preconcurrency import UserNotifications

struct SessionCompletionSoundOption: Identifiable, Equatable {
    let id: String
    let label: String
    let systemSoundName: String?
}

/// Coordinates task-state notifications and the legacy per-session completion sound setting.
/// The historical type name is retained so existing session settings remain source-compatible.
@MainActor
final class SessionCompletionSoundManager: NSObject, @preconcurrency UNUserNotificationCenterDelegate {
    static let defaultSoundId = "glass"
    static let noneSoundId = "none"

    static let options: [SessionCompletionSoundOption] = [
        SessionCompletionSoundOption(id: defaultSoundId, label: "Default", systemSoundName: "Glass"),
        SessionCompletionSoundOption(id: "ping", label: "Ping", systemSoundName: "Ping"),
        SessionCompletionSoundOption(id: "pop", label: "Pop", systemSoundName: "Pop"),
        SessionCompletionSoundOption(id: "tink", label: "Tink", systemSoundName: "Tink"),
        SessionCompletionSoundOption(id: "hero", label: "Hero", systemSoundName: "Hero"),
        SessionCompletionSoundOption(id: "submarine", label: "Submarine", systemSoundName: "Submarine"),
        SessionCompletionSoundOption(id: noneSoundId, label: "Off", systemSoundName: nil)
    ]

    private static let storageKey = "corptie.sessionCompletionSounds"
    private static var activeSound: NSSound?
    private static let logger = Logger(subsystem: "com.corptie.mac", category: "SessionNotifications")

    private let client: BackendClient
    private let preferences: SessionNotificationPreferences
    private let defaults: UserDefaults
    private let notificationCenter: UNUserNotificationCenter?
    private let isSessionVisible: (String) -> Bool
    private let isOverviewVisible: () -> Bool
    private var reducer = SessionNotificationReducer()
    private var soundTransitionTracker = SessionCompletionSoundTransitionTracker()
    private var cancellables = Set<AnyCancellable>()
    private let deliveryCoordinator: SessionNotificationDeliveryCoordinator
    private var deliveryTasksByEventID: [String: Task<Void, Never>] = [:]

    init(
        client: BackendClient,
        preferences: SessionNotificationPreferences = .shared,
        defaults: UserDefaults = CorptieAppEnvironment.userDefaults,
        notificationCenter: UNUserNotificationCenter? = SystemNotificationCenter.currentIfAvailable(),
        isSessionVisible: @escaping (String) -> Bool = { _ in false },
        isOverviewVisible: @escaping () -> Bool = { false }
    ) {
        self.client = client
        self.preferences = preferences
        self.defaults = defaults
        self.notificationCenter = notificationCenter
        self.isSessionVisible = isSessionVisible
        self.isOverviewVisible = isOverviewVisible
        deliveryCoordinator = SessionNotificationDeliveryCoordinator(defaults: defaults) { event in
            try await Self.deliverSystemNotification(event, notificationCenter: notificationCenter)
        }
        super.init()
    }

    func start() {
        notificationCenter?.delegate = self
        requestAuthorizationIfNeeded()
        client.sessionsDidChange
            .receive(on: RunLoop.main)
            .sink { [weak self] sessions in
                self?.handleSessionsUpdate(sessions)
            }
            .store(in: &cancellables)
    }

    func stop() {
        cancellables.removeAll()
        deliveryTasksByEventID.values.forEach { $0.cancel() }
        deliveryTasksByEventID.removeAll()
        notificationCenter?.delegate = nil
        reducer = SessionNotificationReducer()
        soundTransitionTracker = SessionCompletionSoundTransitionTracker()
    }

    static func selectedSoundId(
        for sessionId: String,
        defaults: UserDefaults = CorptieAppEnvironment.userDefaults
    ) -> String {
        guard let storedSoundId = storedSoundIdsBySessionId(defaults: defaults)[sessionId],
              options.contains(where: { $0.id == storedSoundId }) else {
            return noneSoundId
        }
        return storedSoundId
    }

    static func setSelectedSoundId(
        _ soundId: String,
        for sessionId: String,
        defaults: UserDefaults = CorptieAppEnvironment.userDefaults
    ) {
        guard options.contains(where: { $0.id == soundId }) else { return }
        var stored = storedSoundIdsBySessionId(defaults: defaults)
        stored[sessionId] = soundId
        defaults.set(stored, forKey: storageKey)
    }

    static func enabledSoundId(
        for sessionId: String,
        defaults: UserDefaults = CorptieAppEnvironment.userDefaults
    ) -> String? {
        let soundId = selectedSoundId(for: sessionId, defaults: defaults)
        return option(for: soundId).systemSoundName == nil ? nil : soundId
    }

    static func option(for soundId: String) -> SessionCompletionSoundOption {
        options.first { $0.id == soundId }
            ?? options.first { $0.id == noneSoundId }!
    }

    static func previewSound(_ soundId: String) {
        playSound(named: option(for: soundId).systemSoundName)
    }

    static func playGitHubPushSuccess() {
        playSound(named: "Hero")
    }

    static func sendTestNotification() {
        guard let center = SystemNotificationCenter.currentIfAvailable() else {
            playSound(named: option(for: defaultSoundId).systemSoundName)
            return
        }
        Task {
            _ = try? await center.requestAuthorization(options: [.alert])
            let content = UNMutableNotificationContent()
            content.title = L10n("Notification Test")
            content.body = L10n("Corptie task notifications are enabled.")
            try? await center.add(UNNotificationRequest(
                identifier: "corptie-notification-test-\(UUID().uuidString)",
                content: content,
                trigger: nil
            ))
        }
        playSound(named: option(for: defaultSoundId).systemSoundName)
    }

    private static func playSound(named soundName: String?) {
        activeSound?.stop()
        activeSound = nil
        guard let soundName else { return }
        if let sound = NSSound(named: NSSound.Name(soundName)) {
            activeSound = sound
            sound.play()
        } else {
            NSSound.beep()
        }
    }

    private func requestAuthorizationIfNeeded() {
        guard let notificationCenter else {
            Self.logger.notice("System Notification Center is unavailable; task notifications cannot be delivered")
            return
        }
        Task {
            let settings = await notificationCenter.notificationSettings()
            guard settings.authorizationStatus == .notDetermined else { return }
            do {
                let allowed = try await notificationCenter.requestAuthorization(options: [.alert])
                Self.logger.info("Notification authorization request completed; allowed=\(allowed, privacy: .public)")
            } catch {
                Self.logger.error("Notification authorization request failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func handleSessionsUpdate(_ sessions: [TaskSession]) {
        let activeSnapshots = SessionNotificationScope.activeSnapshots(from: sessions)
        for sessionID in soundTransitionTracker.completedSessionIDs(for: activeSnapshots) {
            guard let soundId = Self.enabledSoundId(for: sessionID, defaults: defaults) else {
                continue
            }
            Self.previewSound(soundId)
        }
        let events = reducer.events(
            for: activeSnapshots,
            configuration: preferences.configuration
        )
        if !events.isEmpty {
            Self.logger.info(
                "Generated \(events.count, privacy: .public) notification event(s); activeSessions=\(activeSnapshots.count, privacy: .public), runningSessions=\(activeSnapshots.filter { $0.status == .running }.count, privacy: .public)"
            )
        }
        for event in events {
            enqueueDelivery(event)
        }
    }

    private func enqueueDelivery(_ event: SessionNotificationEvent) {
        guard deliveryTasksByEventID[event.id] == nil else {
            Self.logger.debug("Skipped in-flight notification \(event.id, privacy: .public)")
            return
        }

        deliveryTasksByEventID[event.id] = Task { [weak self] in
            guard let self else { return }
            defer { self.deliveryTasksByEventID[event.id] = nil }
            let outcome = await self.deliveryCoordinator.deliver(event)
            switch outcome {
            case .delivered:
                Self.logger.info(
                    "Delivered notification \(event.id, privacy: .public), kind=\(event.kind.rawValue, privacy: .public)"
                )
            case .skippedPreviouslyDelivered:
                Self.logger.debug("Skipped previously delivered notification \(event.id, privacy: .public)")
            case .skippedInFlight:
                Self.logger.debug("Skipped in-flight notification \(event.id, privacy: .public)")
            case let .failed(message):
                Self.logger.error(
                    "Notification delivery failed \(event.id, privacy: .public), kind=\(event.kind.rawValue, privacy: .public): \(message, privacy: .public)"
                )
            }
        }
    }

    private static func deliverSystemNotification(
        _ event: SessionNotificationEvent,
        notificationCenter: UNUserNotificationCenter?
    ) async throws {
        guard let notificationCenter else {
            throw SessionNotificationDeliveryError.notificationCenterUnavailable
        }
        let settings = await notificationCenter.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            let allowed = try await notificationCenter.requestAuthorization(options: [.alert])
            guard allowed else { throw SessionNotificationDeliveryError.authorizationDenied }
        case .denied:
            throw SessionNotificationDeliveryError.authorizationDenied
        case .authorized, .provisional, .ephemeral:
            break
        @unknown default:
            throw SessionNotificationDeliveryError.authorizationStatusUnknown
        }

        let content = UNMutableNotificationContent()
        content.title = SessionNotificationContent.title(for: event)
        content.body = SessionNotificationContent.body(for: event)
        if let sessionID = event.session?.id {
            content.userInfo = ["sessionId": sessionID, "destination": "session"]
        } else {
            content.userInfo = ["destination": "overview"]
        }

        try await notificationCenter.add(UNNotificationRequest(
            identifier: event.id,
            content: content,
            trigger: nil
        ))
    }

}

enum SessionNotificationDeliveryError: LocalizedError {
    case notificationCenterUnavailable
    case authorizationDenied
    case authorizationStatusUnknown

    var errorDescription: String? {
        switch self {
        case .notificationCenterUnavailable:
            "System Notification Center is unavailable for this executable."
        case .authorizationDenied:
            "System notification authorization is denied."
        case .authorizationStatusUnknown:
            "System notification authorization status is unknown."
        }
    }
}

@MainActor
enum SessionNotificationContent {
    static func title(for event: SessionNotificationEvent) -> String {
        switch event.kind {
        case .completed: L10n("Task Completed")
        case .blocked: L10n("Task Waiting for Interaction")
        case .failed: L10n("Task Failed")
        case .allSessionsWaiting: L10n("All Sessions Have Finished Processing")
        }
    }

    static func body(for event: SessionNotificationEvent) -> String {
        if let session = event.session {
            let summary = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            let detail = summary.isEmpty ? session.title : String(summary.prefix(180))
            return "\(session.agent) · \(session.title)\n\(detail)"
        }
        guard let counts = event.counts else { return "" }
        return L10nFormat(
            "All sessions have finished processing. Sessions needing your attention: %lld.",
            counts.pendingUserAttention
        )
    }
}

extension SessionCompletionSoundManager {

    private static func storedSoundIdsBySessionId(defaults: UserDefaults) -> [String: String] {
        defaults.dictionary(forKey: storageKey) as? [String: String] ?? [:]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let userInfo = notification.request.content.userInfo
        if let sessionID = userInfo["sessionId"] as? String, isSessionVisible(sessionID) {
            completionHandler([])
        } else if userInfo["destination"] as? String == "overview", isOverviewVisible() {
            completionHandler([])
        } else {
            completionHandler([.banner])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        switch SessionNotificationNavigation.destination(for: userInfo) {
        case let .session(sessionID):
            NotificationCenter.default.post(
                name: .openSessionConversation,
                object: nil,
                userInfo: ["sessionId": sessionID]
            )
        case .overview:
            NotificationCenter.default.post(name: .openSessionOverview, object: nil)
        }
        completionHandler()
    }
}
