import Foundation

/// Shared bounded Session storage used by every Apple client. The transport
/// and presentation layers stay platform-specific; residency and eviction do not.
public struct ResidentSessionCache<Value> {
    private var values: [String: Value] = [:]
    private var recency: [String] = []
    private var pinnedKeys: Set<String> = []
    private let capacity: Int

    public init(capacity: Int = 48) {
        self.capacity = max(1, capacity)
    }

    public var keys: Set<String> { Set(values.keys) }

    public func peek(_ key: String) -> Value? {
        values[key]
    }

    public mutating func value(for key: String) -> Value? {
        guard let value = values[key] else { return nil }
        touch(key)
        return value
    }

    public mutating func value(for key: String, create: () -> Value) -> Value {
        if let value = values[key] {
            touch(key)
            return value
        }
        let value = create()
        values[key] = value
        touch(key)
        trimIfNeeded()
        return value
    }

    public mutating func store(_ value: Value, for key: String) {
        values[key] = value
        touch(key)
        trimIfNeeded()
    }

    public mutating func remove(_ key: String) {
        guard !pinnedKeys.contains(key) else { return }
        discard(key)
    }

    public mutating func discard(_ key: String) {
        values[key] = nil
        recency.removeAll { $0 == key }
        pinnedKeys.remove(key)
    }

    public mutating func pin(_ keys: Set<String>) {
        pinnedKeys = keys
        trimIfNeeded()
    }

    public mutating func prune(to validKeys: Set<String>) {
        values = values.filter { validKeys.contains($0.key) }
        recency.removeAll { !validKeys.contains($0) }
        pinnedKeys.formIntersection(validKeys)
    }

    private mutating func touch(_ key: String) {
        recency.removeAll { $0 == key }
        recency.append(key)
    }

    private mutating func trimIfNeeded() {
        while values.count > capacity,
              let index = recency.firstIndex(where: { !pinnedKeys.contains($0) }) {
            let evicted = recency.remove(at: index)
            values[evicted] = nil
        }
    }
}

public struct TimelineRevisionChange<Item: Sendable>: Sendable {
    public let revision: Int
    public let itemID: String
    public let operation: String
    public let item: Item?

    public init(revision: Int, itemID: String, operation: String, item: Item?) {
        self.revision = revision
        self.itemID = itemID
        self.operation = operation
        self.item = item
    }
}

public enum TimelineRevisionMergeResult<Item: Sendable>: Sendable {
    case applied(items: [Item], revision: Int)
    case duplicate
    case requiresSnapshot
}

/// The shared macOS/iPadOS authority for ordered Timeline revision merging.
public enum TimelineRevisionMerger {
    public static func merge<Item: Sendable>(
        currentItems: [Item],
        localRevision: Int,
        baseRevision: Int,
        revision: Int,
        changes: [TimelineRevisionChange<Item>],
        itemID: (Item) -> String,
        precedes: (Item, Item) -> Bool
    ) -> TimelineRevisionMergeResult<Item> {
        if revision <= localRevision { return .duplicate }
        guard baseRevision == localRevision else { return .requiresSnapshot }

        var itemsByID = Dictionary(
            currentItems.map { (itemID($0), $0) },
            uniquingKeysWith: { _, latest in latest }
        )
        var expectedRevision = localRevision
        let finalOperations = Dictionary(changes.filter { ["upsert", "delete"].contains($0.operation) }
            .map { ($0.itemID, $0.revision) }, uniquingKeysWith: max)
        for change in changes {
            guard change.revision == expectedRevision + 1 else { return .requiresSnapshot }
            expectedRevision = change.revision
            switch change.operation {
            case "upsert":
                guard let item = change.item, itemID(item) == change.itemID else {
                    return .requiresSnapshot
                }
                itemsByID[change.itemID] = item
            case "delete":
                itemsByID[change.itemID] = nil
            case "noop":
                // Negotiated coalescing retains contiguous revision coverage.
                guard change.item == nil,
                      (finalOperations[change.itemID] ?? 0) > change.revision else {
                    return .requiresSnapshot
                }
            default:
                return .requiresSnapshot
            }
        }
        guard expectedRevision == revision else { return .requiresSnapshot }
        return .applied(items: itemsByID.values.sorted(by: precedes), revision: revision)
    }
}

public struct ClientResidentTimeline: Sendable {
    public var messages: [ClientMessage]
    public var before: String?
    public var revision: Int?
    public var capabilities: ClientSessionCapabilities?
    public var usage: ClientSessionUsage?
    public var composer: ClientComposerConfiguration?

    public init(
        messages: [ClientMessage],
        before: String?,
        revision: Int?,
        capabilities: ClientSessionCapabilities?,
        usage: ClientSessionUsage?,
        composer: ClientComposerConfiguration?
    ) {
        self.messages = messages
        self.before = before
        self.revision = revision
        self.capabilities = capabilities
        self.usage = usage
        self.composer = composer
    }
}

public enum ClientTimelineApplyResult: Sendable {
    case applied(ClientResidentTimeline)
    case duplicate
    case requiresSnapshot
}

/// Provider-neutral resident Timeline repository for remote Apple clients.
/// Selection reads this repository; selection never owns synchronization.
public struct ClientTimelineRepository {
    private var cache: ResidentSessionCache<ClientResidentTimeline>

    public init(capacity: Int = 48) {
        cache = ResidentSessionCache(capacity: capacity)
    }

    public var sessionIDs: Set<String> { cache.keys }

    public func peek(sessionID: String) -> ClientResidentTimeline? {
        cache.peek(sessionID)
    }

    public mutating func state(for sessionID: String) -> ClientResidentTimeline? {
        cache.value(for: sessionID)
    }

    public mutating func store(_ state: ClientResidentTimeline, for sessionID: String) {
        cache.store(state, for: sessionID)
    }

    public mutating func remove(_ sessionID: String) {
        cache.discard(sessionID)
    }

    public mutating func retainActiveSessions(
        _ sessionIDs: Set<String>,
        pinnedSessionIDs: Set<String> = []
    ) {
        cache.pin(pinnedSessionIDs.intersection(sessionIDs))
        cache.prune(to: sessionIDs)
    }

    public mutating func pinSessions(_ sessionIDs: Set<String>) {
        cache.pin(sessionIDs)
    }

    public mutating func apply(
        _ snapshot: ClientTimelineSnapshot,
        sessionKey: String? = nil
    ) -> ClientTimelineApplyResult {
        guard snapshot.schemaVersion == 2 else { return .requiresSnapshot }
        let key = sessionKey ?? snapshot.sessionId
        let existing = cache.peek(key)
        if let revision = existing?.revision, snapshot.revision < revision { return .duplicate }

        var messages = snapshot.messages.items
        var before = snapshot.messages.nextBefore
        if let existing, let first = messages.first?.id,
           let overlap = existing.messages.firstIndex(where: { $0.id == first }) {
            messages = Array(existing.messages.prefix(overlap)) + messages
            if overlap > 0 { before = existing.before }
        }
        let state = ClientResidentTimeline(
            messages: messages,
            before: before,
            revision: snapshot.revision,
            capabilities: snapshot.capabilities,
            usage: snapshot.usage ?? existing?.usage,
            composer: snapshot.composer
        )
        cache.store(state, for: key)
        return .applied(state)
    }

    public mutating func apply(
        _ delta: ClientTimelineDelta,
        sessionKey: String? = nil
    ) -> ClientTimelineApplyResult {
        guard delta.schemaVersion == 2, delta.snapshotRequired == false else {
            return .requiresSnapshot
        }
        let key = sessionKey ?? delta.sessionId
        guard var state = cache.peek(key), let localRevision = state.revision else {
            return .requiresSnapshot
        }
        let changes = delta.changes.map {
            TimelineRevisionChange(
                revision: $0.revision,
                itemID: $0.itemId,
                operation: $0.operation,
                item: $0.item
            )
        }
        switch TimelineRevisionMerger.merge(
            currentItems: state.messages,
            localRevision: localRevision,
            baseRevision: delta.baseRevision,
            revision: delta.revision,
            changes: changes,
            itemID: { $0.id },
            precedes: Self.messagePrecedes
        ) {
        case .applied(let messages, let revision):
            state.messages = messages
            state.revision = revision
            if let usage = delta.usage { state.usage = usage }
            cache.store(state, for: key)
            return .applied(state)
        case .duplicate:
            // Usage can change without a message revision (for example quota updates).
            if let usage = delta.usage, usage != state.usage {
                state.usage = usage
                cache.store(state, for: key)
                return .applied(state)
            }
            return .duplicate
        case .requiresSnapshot:
            return .requiresSnapshot
        }
    }

    private static func messagePrecedes(_ left: ClientMessage, _ right: ClientMessage) -> Bool {
        let leftCreatedAt = left.createdAt ?? ""
        let rightCreatedAt = right.createdAt ?? ""
        if leftCreatedAt != rightCreatedAt { return leftCreatedAt < rightCreatedAt }
        return left.id < right.id
    }
}
