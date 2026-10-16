import SwiftUI
import Observation
import CorptieClientCore

/// Window-owned presentation only. Never retains a transport, credential or View.
@MainActor public final class ConversationDetailPresentationRepository {
    private var entries: [(ClientDetailBusinessScope, ConversationDetailPresentation)] = []
    public init() {}
    func entry(for scope: ClientDetailBusinessScope) -> ConversationDetailPresentation {
        entries.removeAll { $0.0.ownerID != scope.ownerID || $0.0.serverID != scope.serverID || $0.0.principalID != scope.principalID }
        if let index = entries.firstIndex(where: { $0.0 == scope }) {
            let entry = entries.remove(at: index); entries.append(entry); return entry.1
        }
        // Do not reuse presentation across an authority or resource binding change.
        entries.removeAll { $0.0.sessionID == scope.sessionID && $0.0 != scope }
        let value = ConversationDetailPresentation()
        entries.append((scope, value))
        if entries.count > 32 { entries.removeFirst(entries.count - 32) }
        return value
    }
}

@MainActor final class ConversationDetailPresentation {
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
extension EnvironmentValues {
    var detailPresentation: ConversationDetailPresentation? {
        get { self[DetailPresentationKey.self] } set { self[DetailPresentationKey.self] = newValue }
    }
    var detailSectionPrefix: String {
        get { self[DetailSectionPrefixKey.self] } set { self[DetailSectionPrefixKey.self] = newValue }
    }
}
