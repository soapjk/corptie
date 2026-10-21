import SwiftUI
import Observation
import CorptieClientCore

/// Window-owned presentation only. Never retains a transport, credential or View.
@MainActor public final class ConversationDetailPresentationRepository {
    private var entries: [(ClientDetailBusinessScope, ConversationDetailPresentation)] = []
    private let arrangement: ConversationDetailCardArrangement
    public init(defaults: UserDefaults = .standard) {
        arrangement = ConversationDetailCardArrangement(defaults: defaults)
    }
    func entry(for scope: ClientDetailBusinessScope) -> ConversationDetailPresentation {
        entries.removeAll { $0.0.ownerID != scope.ownerID || $0.0.serverID != scope.serverID || $0.0.principalID != scope.principalID }
        if let index = entries.firstIndex(where: { $0.0 == scope }) {
            let entry = entries.remove(at: index); entries.append(entry); return entry.1
        }
        // Do not reuse presentation across an authority or resource binding change.
        entries.removeAll { $0.0.sessionID == scope.sessionID && $0.0 != scope }
        let value = ConversationDetailPresentation(arrangement: arrangement)
        entries.append((scope, value))
        if entries.count > 32 { entries.removeFirst(entries.count - 32) }
        return value
    }
}

@MainActor final class ConversationDetailPresentation {
    let arrangement: ConversationDetailCardArrangement
    init(arrangement: ConversationDetailCardArrangement) { self.arrangement = arrangement }
    private var sections: [(String, ConversationDetailExpansion)] = []
    private var drafts: [(String, ConversationDetailDraft)] = []
    func draft(_ key: String) -> ConversationDetailDraft? {
        if let value = drafts.first(where: { $0.0 == key }) { return value.1 }
        // Never evict an unsaved draft to admit another editor.
        if drafts.count >= 8 {
            drafts.removeAll { !$0.1.editing }
            guard drafts.count < 8 else { return nil }
        }
        let value = ConversationDetailDraft(); drafts.append((key, value)); return value
    }
    func section(_ key: String) -> ConversationDetailExpansion {
        if let value = sections.first(where: { $0.0 == key }) { return value.1 }
        let value = ConversationDetailExpansion()
        if sections.count >= 256 { sections.removeFirst() }
        sections.append((key, value)); return value
    }
}

/// Presentation order only: never mutates the wire document or retains card payloads.
@MainActor @Observable final class ConversationDetailCardArrangement {
    private static let storageKey = "corptie.detail.cardKindOrder.v1"
    private let defaults: UserDefaults
    private var kinds: [String]

    init(defaults: UserDefaults) {
        self.defaults = defaults
        var restored: [String] = []
        for kind in (defaults.stringArray(forKey: Self.storageKey) ?? []).prefix(64)
            where ClientDetailCardKind(rawValue: kind) != nil && !restored.contains(kind) {
            restored.append(kind)
        }
        kinds = restored
    }

    func ordered(_ cards: [ClientDetailBusinessCardState]) -> [ClientDetailBusinessCardState] {
        let order = completeOrder(cards)
        return cards.sorted {
            (order.firstIndex(of: $0.card.kind) ?? order.count) < (order.firstIndex(of: $1.card.kind) ?? order.count)
        }
    }

    func move(_ sources: [String], before destination: String?, cards: [ClientDetailBusinessCardState]) {
        guard !sources.isEmpty, sources.allSatisfy({ id in cards.contains { $0.id == id } }),
              destination == nil || cards.contains(where: { $0.id == destination }),
              !sources.contains(where: { $0 == destination }) else { return }
        let moving = ordered(cards).filter { sources.contains($0.id) }.map { $0.card.kind }
        var order = completeOrder(cards).filter { !moving.contains($0) }
        let targetKind = cards.first { $0.id == destination }?.card.kind
        let index = targetKind.flatMap { order.firstIndex(of: $0) } ?? order.endIndex
        order.insert(contentsOf: moving, at: index)
        guard kinds != order else { return }
        kinds = order
        // Only the explicit user move writes a bounded array of known card kinds.
        defaults.set(order, forKey: Self.storageKey)
    }

    private func completeOrder(_ cards: [ClientDetailBusinessCardState]) -> [String] {
        var order = kinds
        for card in cards where ClientDetailCardKind(rawValue: card.card.kind) != nil && !order.contains(card.card.kind) {
            order.append(card.card.kind)
        }
        return order
    }
}
@MainActor @Observable final class ConversationDetailExpansion { var expanded = false }
@MainActor @Observable final class ConversationDetailDraft {
    var editing = false
    var text = ""
    var revision: String?
}
private struct DetailPresentationKey: EnvironmentKey {
    static let defaultValue: ConversationDetailPresentation? = nil
}
private struct DetailSectionPrefixKey: EnvironmentKey { static let defaultValue = "" }
private struct DetailArrangingKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var detailArranging: Bool {
        get { self[DetailArrangingKey.self] } set { self[DetailArrangingKey.self] = newValue }
    }
    var detailPresentation: ConversationDetailPresentation? {
        get { self[DetailPresentationKey.self] } set { self[DetailPresentationKey.self] = newValue }
    }
    var detailSectionPrefix: String {
        get { self[DetailSectionPrefixKey.self] } set { self[DetailSectionPrefixKey.self] = newValue }
    }
}
