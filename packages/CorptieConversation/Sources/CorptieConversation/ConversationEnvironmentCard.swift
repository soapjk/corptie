import SwiftUI

public struct ConversationEnvironmentCard<Actions: View>: View {
    public let provider: String?
    public let agent: String?
    public let model: String?
    public let reasoning: String?
    public let workspacePath: String?
    private let actions: Actions

    public init(provider: String?, agent: String?, model: String?, reasoning: String?,
                workspacePath: String?, @ViewBuilder actions: () -> Actions) {
        self.provider = provider
        self.agent = agent
        self.model = model
        self.reasoning = reasoning
        self.workspacePath = workspacePath
        self.actions = actions()
    }

    public var body: some View {
        ConversationDetailModuleCard(title: "工作空间与 Provider", systemImage: "cpu") {
            if let provider, !provider.isEmpty { LabeledContent("Provider", value: provider) }
            if let agent, !agent.isEmpty { LabeledContent("Agent", value: agent) }
            if let model, !model.isEmpty { LabeledContent("模型", value: model) }
            if let reasoning, !reasoning.isEmpty { LabeledContent("推理强度", value: reasoning) }
            if let workspacePath, !workspacePath.isEmpty {
                LabeledContent("工作空间") {
                    Text(workspacePath).font(.caption.monospaced()).textSelection(.enabled)
                        .lineLimit(2).truncationMode(.middle)
                }
            }
            actions
        }
    }
}
