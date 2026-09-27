import Foundation

public enum ConversationInspectorKind: String, Sendable {
    case chat, work, task, legacy
    public static func resolve(sessionKind: String?, taskID: String?, workID: String?) -> Self {
        switch sessionKind {
        case "assistantChat": return .chat
        case "workChat": return .work
        case "worker": return .task
        default: return .legacy
        }
    }
}
