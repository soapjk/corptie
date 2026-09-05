import Foundation

enum SessionInterruptSurface: String, Codable, Sendable {
    case sessionListRowControl = "session_list.row_control"
    case sessionDetailComposerControl = "session_detail.composer_control"
    case sessionDetailToolbar = "session_detail.toolbar"
    case taskDetailExecutionControl = "task_detail.execution_control"
}

struct SessionInterruptSource: Codable, Equatable, Sendable {
    let type: String
    let surface: String
    let action: String
    let trigger: String
    let interactionId: String
    let clientTimestampMs: Int64

    static func userAction(
        surface: SessionInterruptSurface,
        interactionId: String = "interrupt:\(UUID().uuidString.lowercased())",
        clientTimestampMs: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)
    ) -> SessionInterruptSource {
        SessionInterruptSource(
            type: "desktop",
            surface: surface.rawValue,
            action: "interrupt_session",
            trigger: "button",
            interactionId: interactionId,
            clientTimestampMs: clientTimestampMs
        )
    }
}

struct SessionInterruptRequest: Codable, Equatable, Sendable {
    let source: SessionInterruptSource
}
