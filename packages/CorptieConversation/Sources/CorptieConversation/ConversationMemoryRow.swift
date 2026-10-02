import SwiftUI

public struct ConversationMemoryRow<Actions: View>: View {
    public let kind: String
    public let content: String
    public let sourceType: String
    public let trustLevel: String
    private let actions: Actions

    public init(kind: String, content: String, sourceType: String, trustLevel: String,
                @ViewBuilder actions: () -> Actions) {
        self.kind = kind
        self.content = content
        self.sourceType = sourceType
        self.trustLevel = trustLevel
        self.actions = actions()
    }

    public var body: some View {
        DisclosureGroup(kind) {
            ConversationDetailText(text: content)
            if !sourceType.isEmpty || !trustLevel.isEmpty {
                Text([sourceType, trustLevel].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            actions
        }
    }
}
