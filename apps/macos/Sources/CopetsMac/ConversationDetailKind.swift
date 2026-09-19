import Foundation

/// Presentation classification only. Session remains the executor and owner
/// of runtime capabilities; no new backend actor or lifecycle is introduced.
enum ConversationDetailKind: String {
    case chatDetail, workDetail, taskDetail

    static func resolve(_ kind: SessionKind) -> Self? {
        switch kind {
        case .assistantChat: .chatDetail
        case .workChat: .workDetail
        case .worker: .taskDetail
        case .legacy: nil
        }
    }

    static func nonempty(_ text: String?) -> String? {
        guard let value = text?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}
