import SwiftUI

public struct ConversationArtifactRow: View {
    public let title: String
    public let summary: String
    public let visibility: String
    public let version: Int
    public let revoked: Bool
    public let required: Bool
    public let pendingVersion: Bool

    public init(title: String, summary: String, visibility: String, version: Int,
                revoked: Bool, required: Bool, pendingVersion: Bool) {
        self.title = title
        self.summary = summary
        self.visibility = visibility
        self.version = version
        self.revoked = revoked
        self.required = required
        self.pendingVersion = pendingVersion
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: visibility == "repository_tracked" ? "point.3.connected.trianglepath.dotted" : "lock.doc")
                .foregroundStyle(revoked ? Color.red : Color.accentColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 11, weight: .medium)).lineLimit(1)
                if !summary.isEmpty {
                    Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Text("v\(version) · \(visibility)").font(.system(size: 9)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 2)
            if required {
                Text("必需").font(.system(size: 8, weight: .semibold)).foregroundStyle(.orange)
            }
            if pendingVersion {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    .accessibilityLabel("有待处理版本")
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
}
