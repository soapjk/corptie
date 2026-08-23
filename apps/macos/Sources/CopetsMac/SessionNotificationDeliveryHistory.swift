import Foundation

struct SessionNotificationDeliveryHistory {
    static let storageKey = "corptie.notifications.deliveredEventIds"

    private let defaults: UserDefaults
    private let limit: Int
    private var orderedEventIDs: [String]
    private var eventIDs: Set<String>

    init(defaults: UserDefaults, limit: Int = 256) {
        self.defaults = defaults
        self.limit = limit
        let stored = defaults.stringArray(forKey: Self.storageKey) ?? []
        orderedEventIDs = stored
        eventIDs = Set(stored)
    }

    func contains(_ eventID: String) -> Bool {
        eventIDs.contains(eventID)
    }

    mutating func recordDelivered(_ eventID: String) {
        guard !eventIDs.contains(eventID) else { return }
        orderedEventIDs.append(eventID)
        orderedEventIDs = Array(orderedEventIDs.suffix(limit))
        eventIDs = Set(orderedEventIDs)
        defaults.set(orderedEventIDs, forKey: Self.storageKey)
    }
}

@MainActor
final class SessionNotificationDeliveryCoordinator {
    typealias Delivery = @MainActor (SessionNotificationEvent) async throws -> Void

    enum Outcome: Equatable {
        case delivered
        case skippedPreviouslyDelivered
        case skippedInFlight
        case failed(String)
    }

    private var history: SessionNotificationDeliveryHistory
    private var inFlightEventIDs = Set<String>()
    private let delivery: Delivery

    init(defaults: UserDefaults, delivery: @escaping Delivery) {
        history = SessionNotificationDeliveryHistory(defaults: defaults)
        self.delivery = delivery
    }

    func deliver(_ event: SessionNotificationEvent) async -> Outcome {
        guard !history.contains(event.id) else { return .skippedPreviouslyDelivered }
        guard inFlightEventIDs.insert(event.id).inserted else { return .skippedInFlight }
        defer { inFlightEventIDs.remove(event.id) }

        do {
            try await delivery(event)
            guard !Task.isCancelled else { throw CancellationError() }
            history.recordDelivered(event.id)
            return .delivered
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    func hasDelivered(_ eventID: String) -> Bool {
        history.contains(eventID)
    }
}
