import AppKit
import CorptieClientCore

extension ConversationProcessState {
        var color: NSColor {
            switch self {
            case .running: .controlAccentColor
            case .completed: .systemGreen
            case .failed: .systemRed
            case .cancelled: .secondaryLabelColor
            }
        }
}

