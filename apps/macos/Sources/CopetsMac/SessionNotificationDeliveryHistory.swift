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

    mutating func claim(_ eventID: String) -> Bool {
        guard !eventIDs.contains(eventID) else { return false }
        orderedEventIDs.append(eventID)
        orderedEventIDs = Array(orderedEventIDs.suffix(limit))
        eventIDs = Set(orderedEventIDs)
        defaults.set(orderedEventIDs, forKey: Self.storageKey)
        return true
    }
}
