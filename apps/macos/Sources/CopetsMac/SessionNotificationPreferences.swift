import Combine
import Foundation

@MainActor
final class SessionNotificationPreferences: ObservableObject {
    static let shared = SessionNotificationPreferences()

    private enum Key {
        static let complete = "corptie.notifications.sessionComplete"
        static let blocked = "corptie.notifications.sessionBlocked"
        static let failed = "corptie.notifications.sessionFailed"
        static let allWaiting = "corptie.notifications.allSessionsWaiting"
    }

    private let defaults: UserDefaults

    @Published var notifyOnComplete: Bool {
        didSet { defaults.set(notifyOnComplete, forKey: Key.complete) }
    }
    @Published var notifyOnBlocked: Bool {
        didSet { defaults.set(notifyOnBlocked, forKey: Key.blocked) }
    }
    @Published var notifyOnFailed: Bool {
        didSet { defaults.set(notifyOnFailed, forKey: Key.failed) }
    }
    @Published var notifyWhenAllSessionsWaiting: Bool {
        didSet { defaults.set(notifyWhenAllSessionsWaiting, forKey: Key.allWaiting) }
    }

    init(defaults: UserDefaults = CorptieAppEnvironment.userDefaults) {
        self.defaults = defaults
        notifyOnComplete = defaults.object(forKey: Key.complete) as? Bool ?? false
        notifyOnBlocked = defaults.object(forKey: Key.blocked) as? Bool ?? false
        notifyOnFailed = defaults.object(forKey: Key.failed) as? Bool ?? false
        notifyWhenAllSessionsWaiting = defaults.object(forKey: Key.allWaiting) as? Bool ?? true
    }

    var configuration: SessionNotificationConfiguration {
        SessionNotificationConfiguration(
            notifyOnComplete: notifyOnComplete,
            notifyOnBlocked: notifyOnBlocked,
            notifyOnFailed: notifyOnFailed,
            notifyWhenAllSessionsWaiting: notifyWhenAllSessionsWaiting
        )
    }
}
