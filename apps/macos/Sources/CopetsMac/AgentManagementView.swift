import SwiftUI

// Agent 管理页面（顶层 Tab「Agents」）：网格卡片 + 加号创建 + 右键/点击打开详情（详情内增删改/启停/设为助手）。
// Agent 是低频变更的基础设施，单独一个 Tab 管理，控制台侧栏不再列出 Agent。
struct AgentManagementView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @EnvironmentObject private var router: AppTabRouter
    @State private var isCreatingAgent = false
    @State private var selectedAgentForDetail: Agent?
    @State private var agentForSessionCreation: Agent?

    // 自适应网格：卡片最小 260pt，随窗口宽度自动增减列数。
    private let columns = [GridItem(.adaptive(minimum: 260, maximum: 420), spacing: 16)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(L10n("Agents"))
                    .font(.title2.bold())
                Spacer()
                Button {
                    isCreatingAgent = true
                } label: {
                    Label(L10n("新建 Agent"), systemImage: "plus")
                }
            }
            .padding()

            Divider()

            if client.isLoading && client.agents.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if client.agents.isEmpty {
                ContentUnavailableView(
                    "暂无 Agent",
                    systemImage: "person.2",
                    description: Text(L10n("点击右上角「新建 Agent」创建第一个"))
                )
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        agentSection(
                            title: "Assistant",
                            agents: client.agents.filter(\.isAssistant)
                        )

                        agentSection(
                            title: "Independent Contributor",
                            agents: client.agents.filter(\.isIndependentContributor)
                        )
                    }
                    .padding()
                }
            }
        }
        .sheet(isPresented: $isCreatingAgent) {
            AgentCreateView()
        }
        .sheet(item: $selectedAgentForDetail) { agent in
            AgentDetailView(agent: agent)
        }
        .sheet(item: $agentForSessionCreation) { agent in
            NewSessionCreationSheet(fixedAgent: agent) { session in
                router.openSession(session.id)
            }
        }
        .task {
            if client.agents.isEmpty {
                await client.refreshAgents()
            }
            if backendClient.agentProviders.isEmpty {
                await backendClient.loadProviders()
            }
        }
    }

    @ViewBuilder
    private func agentSection(title: String, agents: [Agent]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.headline)
                Text("\(agents.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            }

            if agents.isEmpty {
                Text(L10nFormat("No %@", title))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 72, alignment: .center)
                    .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                LazyVGrid(columns: columns, alignment: .leading, spacing: 16) {
                    ForEach(agents) { agent in
                        AgentCard(agent: agent, onStartSession: { agentForSessionCreation = agent })
                            .contextMenu {
                                Button(L10n("开始新会话")) {
                                    agentForSessionCreation = agent
                                }
                                Button(L10n("打开详情")) {
                                    selectedAgentForDetail = agent
                                }
                            }
                            .onTapGesture {
                                selectedAgentForDetail = agent
                            }
                    }
                }
            }
        }
    }

}

// 单个 Agent 的网格卡片：Assistant 直接建聊天；IC 选择 WorkItem 后建 Worker Session。
struct AgentCard: View {
    @ObservedObject private var backendClient = BackendClient.shared
    let agent: Agent
    var onStartSession: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // 顶部：头像 + 名字/角色 + 状态点
            HStack(alignment: .top, spacing: 10) {
                Text(avatarInitial)
                    .font(.title3.bold())
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(avatarColor, in: Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.name)
                        .font(.headline)
                        .lineLimit(1)
                    Text(roleLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)

                Circle()
                    .fill(statusColor)
                    .frame(width: 9, height: 9)
                    .padding(.top, 4)
                    .help(agent.statusReason ?? statusText)
            }

            // 描述
            if !agent.description.isEmpty {
                Text(agent.description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // 能力标签
            if !agent.capabilities.isEmpty {
                FlowTags(tags: agent.capabilities)
            }

            Spacer(minLength: 0)

            // 底部：provider + 状态文字
            HStack(spacing: 6) {
                if let provider = agent.provider, !provider.isEmpty {
                    Text(backendClient.providerDisplayName(for: provider) ?? provider)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                Spacer()
                if let onStartSession {
                    Button {
                        onStartSession()
                    } label: {
                        Label(L10n("开始新会话"), systemImage: "bubble.left.and.bubble.right")
                            .font(.caption)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(statusColor)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.quaternary, lineWidth: 1)
        )
    }

    private var avatarInitial: String {
        String(agent.name.prefix(1)).uppercased()
    }

    private var avatarColor: Color {
        agent.isAssistant ? .accentColor : .blue
    }

    private var roleLabel: String {
        L10n(agent.isAssistant ? "Assistant" : "Independent Contributor")
    }

    private var statusColor: Color {
        switch agent.status {
        case "unavailable": .red
        default: .green
        }
    }

    private var statusText: String {
        switch agent.status {
        case "unavailable": L10n("Unavailable")
        default: L10n("Available")
        }
    }
}

// 简单流式标签容器：按可用宽度自动换行。
struct FlowTags: View {
    let tags: [String]

    var body: some View {
        // 通过 Layout 协议自定义流式换行布局。
        FlowLayout(spacing: 6) {
            ForEach(tags, id: \.self) { tag in
                Text(tag)
                    .font(.caption2)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
            }
        }
    }
}

// 流式布局：从左到右排布子视图，超出宽度后换行。
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }

        return CGSize(width: maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
