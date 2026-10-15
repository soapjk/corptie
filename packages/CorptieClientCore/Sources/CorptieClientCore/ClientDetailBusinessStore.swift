import Foundation
import Observation

@MainActor @Observable public final class ClientDetailBusinessCardState: Identifiable {
    public let id: String
    public private(set) var card: ClientDetailBusinessCard
    public fileprivate(set) var loading = false
    public fileprivate(set) var pageError: String?
    public fileprivate(set) var windowClipped = false
    fileprivate var editingResources: Set<String> = []
    public func setEditing(resourceID: String, _ editing: Bool) {
        if editing { editingResources.insert(resourceID) } else { editingResources.remove(resourceID) }
    }
    @ObservationIgnored fileprivate var requestedCursors: Set<String> = []
    init(_ card: ClientDetailBusinessCard) { id = card.id; self.card = card }
    fileprivate func replace(_ value: ClientDetailBusinessCard) {
        card = value; pageError = nil; windowClipped = false; requestedCursors = []
        if case .memories(let list) = value.payload { editingResources.formIntersection(Set(list.items.map(\.id))) }
        else { editingResources = [] }
    }
    fileprivate func append(_ value: ClientDetailBusinessCard) throws {
        func merge<Row: Identifiable>(_ old: [Row], _ next: [Row], cost: (Row) -> Int) -> [Row] where Row.ID == String {
            var rows = old, ids = Set(old.map(\.id))
            for row in next where ids.insert(row.id).inserted { rows.append(row) }
            var bytes = rows.reduce(0) { $0 + cost($1) }
            while rows.count > 100 || bytes > 2 * 1024 * 1024 && rows.count > 1 {
                bytes -= cost(rows.removeFirst()); windowClipped = true
            }
            return rows
        }
        let payload: ClientDetailBusinessCard.Payload
        switch (card.payload, value.payload) {
        case (.artifacts(let old), .artifacts(let next)):
            payload = .artifacts(.init(items: merge(old.items, next.items, cost: { $0.title.utf8.count + $0.summary.utf8.count + 1024 }), hasMore: next.hasMore))
        case (.references(let old), .references(let next)):
            payload = .references(.init(items: merge(old.items, next.items, cost: { $0.title.utf8.count + 1024 }), hasMore: next.hasMore))
        case (.memories(let old), .memories(let next)):
            payload = .memories(.init(items: merge(old.items, next.items, cost: { $0.content.utf8.count + 1024 }), hasMore: next.hasMore))
        case (.hits(let old), .hits(let next)):
            payload = .hits(.init(items: merge(old.items, next.items, cost: { $0.content.utf8.count + 1024 }), hasMore: next.hasMore))
        case (.schedules(let old), .schedules(let next)):
            payload = .schedules(.init(items: merge(old.items, next.items, cost: { $0.name.utf8.count + 1024 }), hasMore: next.hasMore))
        default: throw ClientDetailFailure.invalidGraph
        }
        let currentIDs: Set<String>
        switch payload {
        case .artifacts(let list): currentIDs = Set(list.items.map(\.id))
        case .references(let list): currentIDs = Set(list.items.map(\.id))
        case .memories(let list), .hits(let list): currentIDs = Set(list.items.map(\.id))
        case .schedules(let list): currentIDs = Set(list.items.map(\.id))
        default: currentIDs = []
        }
        var actions = Dictionary(uniqueKeysWithValues: card.actions.map { ($0.id, $0) })
        for action in value.actions { actions[action.id] = action }
        let retained = actions.values.filter { $0.target?.resourceType == "session" || currentIDs.contains($0.target?.id ?? "") }.sorted { $0.id < $1.id }
        card = .init(id: card.id, kind: card.kind, version: card.version, revision: card.revision, loadState: value.loadState,
                     payload: payload, actions: retained, nextCursor: value.nextCursor)
        if requestedCursors.count > 256 { requestedCursors = [] }
    }
}

@MainActor @Observable public final class ClientDetailBusinessStore {
    public private(set) var sessionID: String?
    public private(set) var documentID: String?
    public private(set) var generation: String?
    public private(set) var order: [String] = []
    public private(set) var error: String?
    public private(set) var selected = false
    private var cards: [String: ClientDetailBusinessCardState] = [:]
    @ObservationIgnored private var token = UUID()
    public init() {}
    public var orderedCards: [ClientDetailBusinessCardState] { order.compactMap { cards[$0] } }
    public func begin() {
        token = UUID(); sessionID = nil; documentID = nil; generation = nil; order = []; cards = [:]; error = nil; selected = false
    }
    public func fail(_ message: String, clear: Bool = true) {
        error = message
        if clear { token = UUID(); cards = [:]; order = [] }
    }
    public func receive(_ document: ClientDetailBusinessDocument, resetPages: Bool = false) throws {
        if let sessionID, sessionID != document.sessionId { throw ClientDetailFailure.invalidGraph }
        if generation != document.generation { token = UUID(); cards = [:] }
        sessionID = document.sessionId; documentID = document.documentId; generation = document.generation; selected = true; error = nil
        let incoming = Set(document.order)
        cards = cards.filter { incoming.contains($0.key) }
        for card in document.cards {
            if let existing = cards[card.id] {
                if resetPages || existing.card.revision != card.revision { existing.replace(card) }
            } else { cards[card.id] = ClientDetailBusinessCardState(card) }
        }
        if order != document.order { order = document.order }
    }
    public func loadMore(cardID: String, api: ClientDetailAPI, retry: Bool = false) async {
        guard let state = cards[cardID], !state.loading, let cursor = state.card.nextCursor,
              let action = state.card.actions.first(where: { $0.operation == "detail.collection.page" && $0.available }),
              let sessionID, let documentID, let generation else { return }
        guard state.editingResources.isEmpty else { state.pageError = "请先保存或关闭正在编辑的草稿，再继续加载"; return }
        if !retry && (state.pageError != nil || state.requestedCursors.contains(cursor)) { return }
        state.loading = true; state.pageError = nil; state.requestedCursors.insert(cursor)
        let current = token, revision = state.card.revision
        defer { if current == token { state.loading = false } }
        do {
            let request = ClientDetailActionRequest(requestId: UUID().uuidString, documentId: documentID, cardId: cardID,
                actionId: action.id, fields: ["collectionName": .string("resources"), "cursor": .string(cursor)])
            let value = try await api.nativeBusinessPolicy.actionTransport.read(sessionID: sessionID, request: request)
            let page = try ClientDetailBusinessDocument.decode(JSONEncoder().encode(value))
            try Task.checkCancellation()
            guard current == token, cards[cardID] === state, state.card.revision == revision,
                  page.documentId == documentID, page.sessionId == sessionID, page.generation == generation,
                  page.cards.count == 1, let card = page.cards.first, card.id == cardID, card.revision == revision,
                  card.nextCursor != cursor else { throw ClientDetailFailure.invalidGraph }
            try state.append(card)
        } catch {
            guard current == token, cards[cardID] === state else { return }
            if let failure = error as? ClientServiceFailure, [401, 403, 404].contains(failure.statusCode) {
                fail("访问已失效，请重新连接"); return
            }
            state.pageError = "未能加载更多；原有内容已保留"
        }
    }
}
