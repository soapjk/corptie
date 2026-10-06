import SwiftUI

public struct ConversationEnvironmentCard<ProviderContent: View, Actions: View, StatusContent: View>: View {
    public let agent: String?
    public let model: String?
    public let reasoning: String?
    public let workspacePath: String?
    private let providerContent: ProviderContent
    private let actions: Actions
    private let statusContent: StatusContent

    public init(@ViewBuilder provider: () -> ProviderContent, agent: String?, model: String?, reasoning: String?,
                workspacePath: String?, @ViewBuilder actions: () -> Actions,
                @ViewBuilder statusContent: () -> StatusContent) {
        self.providerContent = provider()
        self.agent = agent
        self.model = model
        self.reasoning = reasoning
        self.workspacePath = workspacePath
        self.actions = actions()
        self.statusContent = statusContent()
    }

    public var body: some View {
        ConversationDetailModuleCard(title: "工作空间与 Provider", systemImage: "cpu", headerActions: { actions }) {
            LabeledContent("Provider") { providerContent }
            if let agent, !agent.isEmpty { LabeledContent("Agent", value: agent) }
            if let model, !model.isEmpty { LabeledContent("模型", value: model) }
            if let reasoning, !reasoning.isEmpty { LabeledContent("推理强度", value: reasoning) }
            if let workspacePath, !workspacePath.isEmpty {
                LabeledContent("工作空间") {
                    Text(workspacePath).font(.caption.monospaced()).textSelection(.enabled)
                        .lineLimit(2).truncationMode(.middle)
                }
            }
            statusContent
        }
    }
}

public extension ConversationEnvironmentCard where StatusContent == EmptyView {
    init(@ViewBuilder provider: () -> ProviderContent, agent: String?, model: String?, reasoning: String?,
         workspacePath: String?, @ViewBuilder actions: () -> Actions) {
        self.init(provider: provider, agent: agent, model: model, reasoning: reasoning,
            workspacePath: workspacePath, actions: actions, statusContent: { EmptyView() })
    }
}
