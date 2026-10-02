import SwiftUI

/// Reference identity and status are shared; each host supplies its authorized controls.
public struct ConversationReferenceRow<Controls: View>: View {
    public let title: String
    public let status: String
    public let systemImage: String
    public let enabled: Bool
    public let statusAvailable: Bool
    private let controls: Controls

    public init(title: String, status: String, systemImage: String, enabled: Bool,
                statusAvailable: Bool, @ViewBuilder controls: () -> Controls) {
        self.title = title
        self.status = status
        self.systemImage = systemImage
        self.enabled = enabled
        self.statusAvailable = statusAvailable
        self.controls = controls()
    }

    public var body: some View {
        HStack(spacing: 7) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(enabled ? Color.accentColor : Color.secondary)
                .frame(width: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 11, weight: .medium)).lineLimit(1)
                Text(status).font(.system(size: 9))
                    .foregroundStyle(statusAvailable ? Color.secondary : Color.orange)
            }
            Spacer(minLength: 2)
            controls
        }
        .opacity(enabled ? 1 : 0.55)
    }

}

public enum ConversationReferenceSymbol {
    public static func symbol(for targetType: String) -> String {
        switch targetType {
        case "localFile": "doc"
        case "webURL": "globe"
        case "work": "scope"
        case "task": "checklist"
        case "agent": "person.2"
        case "session": "bubble.left.and.bubble.right"
        default: "link"
        }
    }
}

public enum ConversationReferenceStatus {
    public static func label(for status: String) -> String {
        switch status {
        case "available": "可用"
        case "changed": "内容已变更"
        case "missing": "文件不存在"
        case "unavailable": "暂不可用"
        default: status
        }
    }
}
