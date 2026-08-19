import SwiftUI

// Agent 管理页面（顶层 Tab「Agents」）：网格卡片 + 加号创建 + 右键/点击打开详情（详情内增删改/启停/设为助手）。
// Agent 是低频变更的基础设施，单独一个 Tab 管理，控制台侧栏不再列出 Agent。
struct AgentManagementView: View {
    @ObservedObject private var client = EntityAPIClient.shared
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
            await client.refreshAgents()
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
    let agent: Agent
    var onStartSession: (() -> Void)? = nil

    private enum Metrics {
        static let cardHeight: CGFloat = 244
        static let descriptionHeight: CGFloat = 54
    }

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
            Group {
                if agent.description.isEmpty {
                    Color.clear
                        .accessibilityHidden(true)
                } else {
                    Text(agent.description)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity, minHeight: Metrics.descriptionHeight, maxHeight: Metrics.descriptionHeight, alignment: .topLeading)

            // 能力标签
            FlowTags(tags: agent.capabilities)

            Spacer(minLength: 0)

            // 底部：Session action + 状态文字
            HStack(spacing: 6) {
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
        .frame(maxWidth: .infinity, minHeight: Metrics.cardHeight, maxHeight: Metrics.cardHeight, alignment: .leading)
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

// 最多展示两行标签；超出行数或单标签宽度时显示“…”入口，完整内容在 Popover 中查看。
struct FlowTags: View {
    let tags: [String]
    @State private var isShowingAllTags = false

    var body: some View {
        Group {
            if tags.isEmpty {
                Text(L10n("无能力标签"))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                CappedFlowLayout(spacing: 6, maxRows: 2) {
                    ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
                        Text(tag)
                            .font(.caption2)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(.quaternary, in: Capsule())
                    }

                    Button {
                        isShowingAllTags = true
                    } label: {
                        Text("…")
                            .font(.caption.bold())
                            .frame(minWidth: 18)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 3)
                            .background(.quaternary, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .help(L10n("查看全部标签"))
                    .accessibilityLabel(L10n("查看全部标签"))
                    .popover(isPresented: $isShowingAllTags, arrowEdge: .bottom) {
                        allTagsPopover
                    }
                }
            }
        }
        .frame(height: CappedFlowLayout.regionHeight, alignment: .topLeading)
        .clipped()
    }

    private var allTagsPopover: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L10n("全部能力标签"))
                .font(.headline)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
                        Text(tag)
                            .font(.callout)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
            }
            .frame(maxHeight: 260)
        }
        .padding(14)
        .frame(minWidth: 260, idealWidth: 320, maxWidth: 380)
    }
}

// 最后一个子视图固定为溢出入口。Layout 会先尝试完整排布；只有内容确实溢出时才放置入口。
struct CappedFlowLayout: Layout {
    static let regionHeight: CGFloat = 46

    var spacing: CGFloat = 6
    var maxRows: Int = 2

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: proposal.width ?? 260, height: Self.regionHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let overflowSubview = subviews.last else { return }
        let tagSubviews = subviews.dropLast()
        let tagSizes = tagSubviews.map { $0.sizeThatFits(.unspecified) }
        let overflowSize = overflowSubview.sizeThatFits(.unspecified)
        let result = CappedFlowLayoutEngine.layout(
            itemSizes: tagSizes,
            overflowSize: overflowSize,
            availableWidth: bounds.width,
            maxRows: maxRows,
            spacing: spacing
        )

        for (index, frame) in result.itemFrames.enumerated() {
            if let frame {
                tagSubviews[index].place(
                    at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                    proposal: ProposedViewSize(frame.size)
                )
            } else {
                tagSubviews[index].place(
                    at: CGPoint(x: bounds.maxX + 1, y: bounds.maxY + 1),
                    proposal: .zero
                )
            }
        }
        if let frame = result.overflowFrame {
            overflowSubview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size)
            )
        } else {
            overflowSubview.place(
                at: CGPoint(x: bounds.maxX + 1, y: bounds.maxY + 1),
                proposal: .zero
            )
        }
    }
}

struct CappedFlowLayoutResult: Equatable {
    let itemFrames: [CGRect?]
    let overflowFrame: CGRect?

    var visibleItemCount: Int { itemFrames.compactMap { $0 }.count }
    var isOverflowing: Bool { overflowFrame != nil }
}

enum CappedFlowLayoutEngine {
    static func layout(
        itemSizes: [CGSize],
        overflowSize: CGSize,
        availableWidth: CGFloat,
        maxRows: Int,
        spacing: CGFloat
    ) -> CappedFlowLayoutResult {
        let width = max(0, availableWidth)
        let rows = max(1, maxRows)
        let firstPass = place(itemSizes: itemSizes, availableWidth: width, maxRows: rows, spacing: spacing)
        let hasTruncatedItem = itemSizes.contains { $0.width > width }
        guard firstPass.visibleItemCount < itemSizes.count || hasTruncatedItem else {
            return CappedFlowLayoutResult(itemFrames: firstPass.frames, overflowFrame: nil)
        }

        let indicatorWidth = min(max(0, overflowSize.width), width)
        let finalRowWidth = max(0, width - indicatorWidth - spacing)
        let capped = place(
            itemSizes: itemSizes,
            availableWidth: width,
            maxRows: rows,
            spacing: spacing,
            finalRowWidth: finalRowWidth
        )
        let rowHeight = max(capped.rowHeight, overflowSize.height)
        let finalRowY = CGFloat(rows - 1) * (rowHeight + spacing)
        let lastVisibleFrame = capped.frames.compactMap { $0 }.last
        let indicatorX: CGFloat
        if let lastVisibleFrame, abs(lastVisibleFrame.minY - finalRowY) < 0.5 {
            indicatorX = min(width - indicatorWidth, lastVisibleFrame.maxX + spacing)
        } else {
            indicatorX = 0
        }
        let overflowFrame = CGRect(x: max(0, indicatorX), y: finalRowY, width: indicatorWidth, height: overflowSize.height)
        return CappedFlowLayoutResult(itemFrames: capped.frames, overflowFrame: overflowFrame)
    }

    private static func place(
        itemSizes: [CGSize],
        availableWidth: CGFloat,
        maxRows: Int,
        spacing: CGFloat,
        finalRowWidth: CGFloat? = nil
    ) -> (frames: [CGRect?], visibleItemCount: Int, rowHeight: CGFloat) {
        let rowHeight = itemSizes.map(\.height).max() ?? 0
        var frames = Array<CGRect?>(repeating: nil, count: itemSizes.count)
        var row = 0
        var x: CGFloat = 0

        for (index, naturalSize) in itemSizes.enumerated() {
            var rowWidth = row == maxRows - 1 ? (finalRowWidth ?? availableWidth) : availableWidth
            rowWidth = max(0, rowWidth)
            var itemWidth = min(max(0, naturalSize.width), rowWidth)
            if x > 0, x + itemWidth > rowWidth {
                row += 1
                x = 0
                guard row < maxRows else { break }
                rowWidth = row == maxRows - 1 ? (finalRowWidth ?? availableWidth) : availableWidth
                itemWidth = min(max(0, naturalSize.width), max(0, rowWidth))
            }
            guard itemWidth > 0 else { break }
            let y = CGFloat(row) * (rowHeight + spacing)
            frames[index] = CGRect(x: x, y: y, width: itemWidth, height: naturalSize.height)
            x += itemWidth + spacing
        }

        return (frames, frames.compactMap { $0 }.count, rowHeight)
    }
}
