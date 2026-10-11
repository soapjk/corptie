import Foundation
import Observation

public struct ClientDetailText: Codable, Equatable, Sendable {
    public let key: String?
    public let fallback: String
    public var parameters: [String: String]? = nil
}

public struct ClientDetailNode: Codable, Equatable, Identifiable, Sendable {
    public struct Props: Codable, Equatable, Sendable {
        public let text: ClientDetailText?
        public let label: ClientDetailText?
        public let semantic: String?
        public let actionId: String?
    }
    public let id: String
    public let kind: String
    public let props: Props
    public let children: [String]
    public let binding: String?

    private enum CodingKeys: String, CodingKey { case id, kind, props, children, binding }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(String.self, forKey: .kind)
        children = try container.decode([String].self, forKey: .children)
        binding = try container.decodeIfPresent(String.self, forKey: .binding)
        // Future component props have their own shape. Never decode them as a
        // known component and blank the whole Detail instead of local fallback.
        if ClientDetailProtocol.componentKinds.contains(kind) {
            props = try container.decode(Props.self, forKey: .props)
        } else {
            guard case .object = try container.decode(ClientInspectorValue.self, forKey: .props) else { throw ClientDetailFailure.invalidGraph }
            props = Props(text: nil, label: nil, semantic: nil, actionId: nil)
        }
    }
}

public struct ClientDetailAction: Codable, Equatable, Identifiable, Sendable {
    public struct Target: Codable, Equatable, Sendable {
        public let resourceType: String
        public let id: String
    }
    public let id: String
    public let kind: String
    public let operation: String
    public let label: ClientDetailText
    public let available: Bool
    public var target: Target? = nil
    public var reason: ClientDetailText? = nil
    public var confirmation: String? = nil
    public var expectedResourceRevision: String? = nil
}

/// Immutable native-v1 tokens. New rendering semantics use a new catalog profile
/// or a new kind token; never silently redefine an installed client's component.
public enum ClientDetailProtocol {
    public static let schemaVersion = 1
    public static let catalogProfile = "native-v1"
    public static let componentKinds: Set<String> = ["column", "row", "section", "text", "markdown", "divider", "disclosure"]
    public static let maxRevision = 9_007_199_254_740_991
    public static let maxDocumentBytes = 256 * 1024
    public static let maxFrameBytes = maxDocumentBytes + 1024
}

public struct ClientDetailActionRequest: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let requestId: String
    public let documentId: String
    public let cardId: String
    public let actionId: String
    public let expectedResourceRevision: String?
    public let fields: [String: ClientInspectorValue]
    public init(requestId: String, documentId: String, cardId: String, actionId: String,
                expectedResourceRevision: String? = nil, fields: [String: ClientInspectorValue] = [:]) {
        schemaVersion = ClientDetailProtocol.schemaVersion; self.requestId = requestId
        self.documentId = documentId; self.cardId = cardId; self.actionId = actionId
        self.expectedResourceRevision = expectedResourceRevision; self.fields = fields
    }
    public func validate() throws {
        guard schemaVersion == 1, (8...128).contains(requestId.utf8.count),
              requestId.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
              [documentId, cardId, actionId].allSatisfy({ !$0.isEmpty && $0.unicodeScalars.count <= 512 }),
              expectedResourceRevision.map({ !$0.isEmpty && $0.unicodeScalars.count <= 256 }) ?? true,
              fields.count <= 64, try JSONEncoder().encode(self).count <= 64 * 1024 else { throw ClientDetailFailure.limit }
    }
}

public struct ClientDetailCard: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let templateRevision: Int
    public let dataRevision: String
    public let title: ClientDetailText
    public let semanticKind: String
    public let rootNodeId: String
    public let nodes: [ClientDetailNode]
    public let data: [String: ClientInspectorValue]
    public let actions: [ClientDetailAction]
    public let fallback: ClientDetailText

    public func value(for node: ClientDetailNode) -> String {
        guard let binding = node.binding else { return node.props.text?.fallback ?? "" }
        return binding.split(separator: ".").reduce(ClientInspectorValue.object(data)) { $0[String($1)] }.text ?? ""
    }
}

public struct ClientDetailDocument: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let documentId: String
    public let sessionId: String
    public let generation: String
    public let revision: Int
    public let cards: [ClientDetailCard]
    public let order: [String]

    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= ClientDetailProtocol.maxDocumentBytes else { throw ClientDetailFailure.limit }
        let document = try JSONDecoder().decode(Self.self, from: data)
        try document.validate()
        return document
    }

    public func validate() throws {
        guard schemaVersion == 1 else { throw ClientDetailFailure.unsupportedSchema }
        guard [documentId, sessionId, generation].allSatisfy({ !$0.isEmpty && $0.unicodeScalars.count <= 512 }), revision > 0, revision <= ClientDetailProtocol.maxRevision,
              cards.count <= 30, cards.reduce(0, { $0 + $1.nodes.count }) <= 500 else { throw ClientDetailFailure.limit }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]
        guard try encoder.encode(self).count <= ClientDetailProtocol.maxDocumentBytes else { throw ClientDetailFailure.limit }
        let ids = Set(cards.map(\.id))
        guard ids.count == cards.count, order.count == ids.count, Set(order) == ids else { throw ClientDetailFailure.invalidGraph }
        for card in cards {
            func idValid(_ value: String) -> Bool { !value.isEmpty && value.unicodeScalars.count <= 512 }
            func textValid(_ text: ClientDetailText) -> Bool {
                text.fallback.unicodeScalars.count <= 4096 && (text.key?.unicodeScalars.count ?? 0) <= 256 &&
                (text.parameters?.count ?? 0) <= 16 && (text.parameters?.values.allSatisfy({ $0.unicodeScalars.count <= 1024 }) ?? true)
            }
            guard idValid(card.id), idValid(card.semanticKind), textValid(card.title), textValid(card.fallback),
                  !card.dataRevision.isEmpty, card.dataRevision.unicodeScalars.count <= 256,
                  card.templateRevision > 0, card.templateRevision <= ClientDetailProtocol.maxRevision, card.actions.count <= 32,
                  Set(card.actions.map(\.id)).count == card.actions.count else { throw ClientDetailFailure.invalidGraph }
            for action in card.actions {
                guard idValid(action.id), idValid(action.kind), idValid(action.operation), textValid(action.label),
                      action.reason.map(textValid) ?? true,
                      action.target.map({ idValid($0.resourceType) && idValid($0.id) }) ?? true,
                      action.confirmation.map({ ["none", "required", "destructive"].contains($0) }) ?? true,
                      action.expectedResourceRevision.map({ !$0.isEmpty && $0.unicodeScalars.count <= 256 }) ?? true else { throw ClientDetailFailure.invalidGraph }
            }
            let nodes = Dictionary(card.nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            guard nodes.count == card.nodes.count, nodes[card.rootNodeId] != nil else { throw ClientDetailFailure.invalidGraph }
            var parents: [String: Int] = [:]
            for node in card.nodes {
                for child in node.children { parents[child, default: 0] += 1 }
            }
            // A rooted tree prevents a small DAG from expanding exponentially
            // into views, and gives every rendered node exactly one identity.
            guard parents[card.rootNodeId] == nil,
                  nodes.keys.filter({ $0 != card.rootNodeId }).allSatisfy({ parents[$0] == 1 }) else { throw ClientDetailFailure.invalidGraph }
            var heights: [String: Int] = [:]
            func visit(_ id: String, ancestors: Set<String>) throws -> Int {
                if let height = heights[id] { return height }
                guard let node = nodes[id], !ancestors.contains(id), idValid(id), idValid(node.kind),
                      node.props.text.map(textValid) ?? true, node.props.label.map(textValid) ?? true,
                      node.props.semantic.map({ $0.unicodeScalars.count <= 256 }) ?? true,
                      node.props.actionId.map({ actionId in card.actions.contains { $0.id == actionId } }) ?? true else { throw ClientDetailFailure.invalidGraph }
                guard Set(node.children).count == node.children.count else { throw ClientDetailFailure.invalidGraph }
                if let path = node.binding {
                    guard path.count <= 256, path.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ part in
                        !part.isEmpty && part.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 }
                    }) else { throw ClientDetailFailure.invalidBinding }
                }
                var height = 1
                for child in node.children { height = max(height, 1 + (try visit(child, ancestors: ancestors.union([id])))) }
                guard height <= 6 else { throw ClientDetailFailure.limit }
                heights[id] = height
                return height
            }
            // Also validate disconnected nodes; a later template must not activate a hidden cycle.
            for node in card.nodes { _ = try visit(node.id, ancestors: []) }
        }
    }
}

public struct ClientDetailPatch: Codable, Equatable, Sendable {
    public let documentId: String
    public let sessionId: String
    public let generation: String
    public let baseRevision: Int
    public let revision: Int
    public let upsertCards: [ClientDetailCard]
    public let removeCardIds: [String]
    public let order: [String]?
}

public extension ClientDetailDocument {
    func accepting(_ snapshot: Self) throws -> Self {
        try snapshot.validate()
        guard documentId == snapshot.documentId, sessionId == snapshot.sessionId else { throw ClientDetailFailure.wrongScope }
        if generation != snapshot.generation { return snapshot }
        if snapshot.revision < revision { return self }
        if snapshot.revision == revision {
            guard order == snapshot.order, cards.sorted(by: { $0.id < $1.id }) == snapshot.cards.sorted(by: { $0.id < $1.id }) else { throw ClientDetailFailure.revisionConflict }
            return self
        }
        try validateCardVersions(snapshot.cards)
        return snapshot
    }

    private func validateCardVersions(_ nextCards: [ClientDetailCard]) throws {
        let previous = Dictionary(uniqueKeysWithValues: cards.map { ($0.id, $0) })
        for next in nextCards {
            guard let old = previous[next.id] else { continue }
            guard next.templateRevision >= old.templateRevision else { throw ClientDetailFailure.revisionConflict }
            if next.templateRevision == old.templateRevision {
                guard next.nodes == old.nodes, next.rootNodeId == old.rootNodeId, next.title == old.title,
                      next.semanticKind == old.semanticKind, next.fallback == old.fallback else { throw ClientDetailFailure.revisionConflict }
            }
            if next.dataRevision == old.dataRevision {
                guard next.data == old.data, next.actions == old.actions else { throw ClientDetailFailure.revisionConflict }
            }
        }
    }

    func applying(_ patch: ClientDetailPatch) throws -> Self {
        guard patch.documentId == documentId, patch.sessionId == sessionId, patch.generation == generation else { throw ClientDetailFailure.wrongScope }
        if patch.revision <= revision { return self }
        guard patch.baseRevision == revision, patch.revision > patch.baseRevision,
              patch.revision <= ClientDetailProtocol.maxRevision else { throw ClientDetailFailure.revisionGap }
        guard Set(patch.upsertCards.map(\.id)).count == patch.upsertCards.count,
              Set(patch.removeCardIds).count == patch.removeCardIds.count,
              Set(patch.removeCardIds).isSubset(of: Set(order)),
              Set(patch.removeCardIds).isDisjoint(with: patch.upsertCards.map(\.id)) else { throw ClientDetailFailure.invalidGraph }
        try validateCardVersions(patch.upsertCards)
        var members = Dictionary(uniqueKeysWithValues: cards.map { ($0.id, $0) })
        for id in patch.removeCardIds { members.removeValue(forKey: id) }
        for card in patch.upsertCards { members[card.id] = card }
        let next = Self(schemaVersion: 1, documentId: documentId, sessionId: sessionId, generation: generation,
            revision: patch.revision, cards: Array(members.values), order: patch.order ?? order.filter { members[$0] != nil })
        try next.validate()
        return next
    }
}

public enum ClientDetailFailure: Error, Equatable, Sendable {
    case unsupportedSchema, limit, invalidGraph, invalidBinding, revisionGap, revisionConflict, wrongScope, bufferOverflow
}

public enum ClientDetailEvent: Sendable {
    case snapshot(ClientDetailDocument), patch(ClientDetailPatch)
}

/// Separate instances keep data-only changes from invalidating unrelated cards.
@MainActor @Observable public final class ClientDetailCardState: Identifiable {
    public let id: String
    public private(set) var card: ClientDetailCard
    public private(set) var nodes: [String: ClientDetailNode]
    public var expandedNodes: Set<String> = []
    init(_ card: ClientDetailCard) {
        id = card.id; self.card = card
        nodes = Dictionary(uniqueKeysWithValues: card.nodes.map { ($0.id, $0) })
    }
    func update(_ next: ClientDetailCard) {
        if next.nodes != card.nodes { nodes = Dictionary(uniqueKeysWithValues: next.nodes.map { ($0.id, $0) }) }
        if next != card { card = next }
    }
}

@MainActor @Observable public final class ClientDetailStore {
    public private(set) var orderedCards: [ClientDetailCardState] = []
    public private(set) var error: String?
    @ObservationIgnored private var document: ClientDetailDocument?
    @ObservationIgnored private var scopeKey = ""
    @ObservationIgnored private var token = UUID()
    public init() {}

    public func refresh(sessionID: String, api: @escaping @Sendable () async throws -> ClientDetailAPI) async {
        let generation = token
        do {
            let snapshot = try await api().renderingSnapshot(sessionID: sessionID)
            guard generation == token, !Task.isCancelled else { return }
            try apply(.snapshot(snapshot), expectedSessionID: document?.sessionId)
        } catch {
            guard generation == token, !Task.isCancelled else { return }
            self.error = "Detail 刷新失败，可重试"
        }
    }

    public func apply(_ event: ClientDetailEvent, expectedSessionID: String? = nil) throws {
        let next: ClientDetailDocument
        switch event {
        case .snapshot(let snapshot):
            if let expectedSessionID, snapshot.sessionId != expectedSessionID { throw ClientDetailFailure.wrongScope }
            next = try document?.accepting(snapshot) ?? snapshot
        case .patch(let patch):
            guard let previous = document else { throw ClientDetailFailure.wrongScope }
            next = try previous.applying(patch)
        }
        try next.validate()
        let previous = Dictionary(uniqueKeysWithValues: orderedCards.map { ($0.id, $0) })
        let cards = Dictionary(uniqueKeysWithValues: next.cards.map { ($0.id, $0) })
        let ordered = next.order.map { id -> ClientDetailCardState in
            let card = cards[id]!
            if let state = previous[id] { state.update(card); return state }
            return ClientDetailCardState(card)
        }
        if orderedCards.map(\.id) != next.order { orderedCards = ordered }
        document = next; error = nil
    }

    public func observe(scope: String, sessionID: String,
                        api: @escaping @Sendable () async throws -> ClientDetailAPI) async {
        if scope != scopeKey { scopeKey = scope; document = nil; orderedCards = []; error = nil }
        let generation = UUID(); token = generation
        var failures = 0
        while !Task.isCancelled, token == generation {
            do {
                let events = await ClientDetailSubscriptionPool.shared.subscribe(scope: scope, sessionID: sessionID, api: api)
                for try await event in events {
                    guard token == generation, !Task.isCancelled else { return }
                    // The server canonicalizes legacy routes to a logical Session. The first
                    // snapshot binds this authenticated transport scope; patches must match it.
                    try apply(event, expectedSessionID: document?.sessionId)
                    failures = 0
                }
            } catch {
                guard token == generation, !Task.isCancelled else { return }
                if ClientDetailAPI.isAccessFailure(error) {
                    document = nil; orderedCards = []; self.error = "Detail 访问已失效"; return
                }
                self.error = "Detail 正在重新同步"
            }
            failures += 1
            do { try await Task.sleep(for: .seconds(min(15, pow(2, Double(min(failures, 4)))))) }
            catch { return }
        }
    }
}
