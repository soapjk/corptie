import AppKit
import Combine
import Foundation
import UserNotifications

struct SessionCompletionNotificationSummary: Equatable {
    let completed: Int
    let pending: Int
    let failed: Int

    static func make(from sessions: [TaskSession]) -> Self {
        Self(
            completed: sessions.lazy.filter { $0.status == .complete }.count,
            pending: sessions.lazy.filter {
                ($0.lastAgentMessageSequence ?? 0) > ($0.lastReadMessageSequence ?? 0)
            }.count,
            failed: sessions.lazy.filter { $0.status == .failed }.count
        )
    }
}

struct SessionCompletionSystemNotification: Equatable {
    let identifier: String
    let sessionID: String
    let title: String
    let body: String
}

struct SessionCompletionSoundOption: Identifiable, Equatable {
    let id: String
    let label: String
    let systemSoundName: String?
}

@MainActor
final class SessionCompletionSoundManager {
    typealias NotificationDelivery = (SessionCompletionSystemNotification) -> Void
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
    private static let deliveredNotificationsKey = "corptie.sessionCompletionNotifications.delivered"
    private static var activeSound: NSSound?

    private let client: BackendClient
    private let defaults: UserDefaults
    private let notificationDelivery: NotificationDelivery
    private var cancellables = Set<AnyCancellable>()
    private var previousStatusesBySessionId: [String: TaskStatus] = [:]
    private var hasObservedInitialSnapshot = false

    init(
        client: BackendClient,
        defaults: UserDefaults = CorptieAppEnvironment.userDefaults,
        notificationDelivery: NotificationDelivery? = nil
    ) {
        self.client = client
        self.defaults = defaults
        self.notificationDelivery = notificationDelivery ?? Self.deliverSystemNotification
    }

    func start() {
        client.sessionsDidChange
            .receive(on: RunLoop.main)
            .sink { [weak self] sessions in
                self?.handleSessionsUpdate(sessions)
            }
            .store(in: &cancellables)
    }

    func stop() {
        cancellables.removeAll()
        previousStatusesBySessionId.removeAll()
        hasObservedInitialSnapshot = false
    }

    static func selectedSoundId(for sessionId: String) -> String {
        storedSoundIdsBySessionId()[sessionId] ?? defaultSoundId
    }

    static func setSelectedSoundId(_ soundId: String, for sessionId: String) {
        var stored = storedSoundIdsBySessionId()
        if soundId == defaultSoundId {
            stored.removeValue(forKey: sessionId)
        } else {
            stored[sessionId] = soundId
        }
        CorptieAppEnvironment.userDefaults.set(stored, forKey: storageKey)
    }

    static func option(for soundId: String) -> SessionCompletionSoundOption {
        options.first { $0.id == soundId } ?? options[0]
    }

    static func previewSound(_ soundId: String) {
        playSound(named: option(for: soundId).systemSoundName)
    }

    static func playGitHubPushSuccess() {
        playSound(named: "Hero")
    }

    private static func playSound(named soundName: String?) {
        activeSound?.stop()
        activeSound = nil
        guard let soundName else {
            return
        }
        if let sound = NSSound(named: NSSound.Name(soundName)) {
            activeSound = sound
            sound.play()
        } else {
            NSSound.beep()
        }
    }

    private func handleSessionsUpdate(_ sessions: [TaskSession]) {
        let currentIds = Set(sessions.map(\.id))
        previousStatusesBySessionId = previousStatusesBySessionId.filter { currentIds.contains($0.key) }

        guard hasObservedInitialSnapshot else {
            previousStatusesBySessionId = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0.status) })
            hasObservedInitialSnapshot = true
            return
        }

        for session in sessions {
            let previousStatus = previousStatusesBySessionId[session.id]
            if previousStatus == .running && shouldNotifyCompletion(for: session.status) {
                playCompletionSound(for: session)
                deliverCompletionNotification(for: session, sessions: sessions)
            }
            previousStatusesBySessionId[session.id] = session.status
        }
    }

    private func shouldNotifyCompletion(for status: TaskStatus) -> Bool {
        status == .complete || status == .blocked || status == .failed
    }

    private func playCompletionSound(for session: TaskSession) {
        Self.previewSound(Self.selectedSoundId(for: session.id))
    }

    private func deliverCompletionNotification(for session: TaskSession, sessions: [TaskSession]) {
        let fingerprint = [
            session.status.rawValue,
            String(session.lastAgentMessageSequence ?? 0),
            session.updatedAt
        ].joined(separator: ":")
        var delivered = defaults.dictionary(forKey: Self.deliveredNotificationsKey) as? [String: String] ?? [:]
        guard delivered[session.id] != fingerprint else { return }
        delivered[session.id] = fingerprint
        defaults.set(delivered, forKey: Self.deliveredNotificationsKey)

        let summary = SessionCompletionNotificationSummary.make(from: sessions)
        notificationDelivery(SessionCompletionSystemNotification(
            identifier: "session-completion-\(session.id)-\(session.lastAgentMessageSequence ?? 0)",
            sessionID: session.id,
            title: L10n("Session update"),
            body: L10nFormat(
                "%d completed · %d pending · %d failed",
                summary.completed,
                summary.pending,
                summary.failed
            )
        ))
    }

    private static func deliverSystemNotification(_ notification: SessionCompletionSystemNotification) {
        guard CodexResetSystemNotificationManager.canUseUserNotificationCenter else {
            deliverDevelopmentNotification(notification)
            return
        }
        Task {
            let center = UNUserNotificationCenter.current()
            let allowed = (try? await center.requestAuthorization(options: [.alert, .sound])) == true
            guard allowed else { return }
            let content = UNMutableNotificationContent()
            content.title = notification.title
            content.body = notification.body
            content.sound = .default
            content.userInfo = ["sessionId": notification.sessionID]
            try? await center.add(UNNotificationRequest(
                identifier: notification.identifier,
                content: content,
                trigger: nil
            ))
        }
    }

    private static func deliverDevelopmentNotification(_ notification: SessionCompletionSystemNotification) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = [
            "-e", "on run argv",
            "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e", "end run",
            "--",
            notification.title,
            notification.body
        ]
        try? process.run()
    }

    private static func storedSoundIdsBySessionId() -> [String: String] {
        CorptieAppEnvironment.userDefaults.dictionary(forKey: storageKey) as? [String: String] ?? [:]
    }
}
