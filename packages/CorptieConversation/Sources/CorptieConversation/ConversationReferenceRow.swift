import SwiftUI

/// Reference identity and status are shared; each host supplies its authorized controls.
public struct ConversationReferenceRow<Controls: View>: View {
    public let title: String
    public let status: String
    public let systemImage: String
    public let enabled: Bool
    public let statusAvailable: Bool
    public let localPath: String?
    public let checkError: String?
    private let controls: Controls

    public init(title: String, status: String, systemImage: String, enabled: Bool,
                statusAvailable: Bool, localPath: String? = nil, checkError: String? = nil,
                @ViewBuilder controls: () -> Controls) {
        self.title = title
        self.status = status
        self.systemImage = systemImage
        self.enabled = enabled
        self.statusAvailable = statusAvailable
        self.localPath = localPath
        self.checkError = checkError
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
                if let localPath {
                    Text(localPath).font(.system(size: 9)).foregroundStyle(.secondary)
                        .lineLimit(2).truncationMode(.middle)
                    Text("仅提供 Mac 文件路径，由 Agent 按需读取")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                }
                if let checkError {
                    Text(checkError).font(.system(size: 9)).foregroundStyle(.orange).lineLimit(2)
                }
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
    public static func label(for status: String, targetType: String? = nil, enabled: Bool = true) -> String {
        if !enabled { return "已停用" }
        if targetType == "localFile" {
            switch status {
            case "available", "changed": return "已引用"
            case "unavailable": return "无法检查文件"
            default: break
            }
        }
        return switch status {
        case "available": "可用"
        case "changed": "内容已变更"
        case "missing": "文件不存在"
        case "unavailable": "暂不可用"
        default: status
        }
    }
}
