import Combine
import SwiftUI

// Sessions Tab：三栏布局，对齐 Codex 桌面端 App Server。
//   左 sidebar  — 会话列表（CompactSessionRow，选中走 backendClient.select）
//   中 content  — 对话（复用旧版 DetailView）
//   右 detail   — 会话详细信息（SessionDetailPanel）
struct SessionsView: View {
    @ObservedObject private var backendClient = BackendClient.shared
    @ObservedObject private var sessionListStore = BackendClient.shared.sessionListStore
    @StateObject private var layoutState = PanelLayoutState()
    @State private var composerDraftRepository = ComposerDraftRepository()
    @EnvironmentObject private var router: AppTabRouter

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            NavigationSplitView {
                sessionListSidebar
                    .navigationSplitViewColumnWidth(min: w * 0.22, ideal: w * 0.30, max: w * 0.42)
            } content: {
                sessionConversation
                    .navigationSplitViewColumnWidth(min: w * 0.28, ideal: w * 0.40, max: w * 0.55)
            } detail: {
                sessionDetailPanel
                    .navigationSplitViewColumnWidth(min: w * 0.22, ideal: w * 0.30, max: w * 0.42)
            }
        }
        .environmentObject(backendClient)
        .environmentObject(layoutState)
        .environment(\.isLiquidGlass, false)
        .onAppear {
            // DetailView 依赖 canRenderDetailMessages 决定是否渲染消息区
            layoutState.canRenderDetailMessages = true
            // 轻量场景：关掉 usage/worktree 后台轮询，减少整树刷新
            backendClient.suppressBackgroundPolling = true
            attemptPendingSelection(backendClient.sessions)
        }
        .onDisappear {
            backendClient.suppressBackgroundPolling = false
        }
        .onReceive(backendClient.sessionsDidChange) { sessions in
            attemptPendingSelection(sessions)
        }
    }

    // 控制台「打开对话」→ 切到本 Tab 后，选中目标会话（sessions 加载完成后）。
    private func attemptPendingSelection(_ sessions: [TaskSession]) {
        guard let pendingId = router.pendingSessionId else { return }
        guard let session = sessions.first(where: { $0.id == pendingId }) else { return }
        backendClient.select(session: session)
        router.pendingSessionId = nil
    }

    // MARK: - 左：会话列表

    private var sessionListSidebar: some View {
        List {
            if sessionListStore.rows.isEmpty {
                Text("暂无会话")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(sessionListStore.rows) { row in
                    CompactSessionRow(session: row.session)
                        .listRowInsets(EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 8))
                        .listRowSeparator(.hidden)
                        .listRowBackground(
                            backendClient.selectedSession?.id == row.session.id
                                ? Color(nsColor: .selectedContentBackgroundColor)
                                : Color.clear
                        )
                }
            }
        }
        .listStyle(.sidebar)
    }

    // MARK: - 中：对话

    @ViewBuilder
    private var sessionConversation: some View {
        if let session = backendClient.selectedSession {
            DetailView(
                sessionId: session.id,
                preheatedDisplayCache: nil,
                composerDraftRepository: composerDraftRepository,
                renderer: .swiftUIVStack
            )
        } else {
            ContentUnavailableView(
                "选择会话",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("从左侧选择一个会话查看对话")
            )
        }
    }

    // MARK: - 右：详情

    @ViewBuilder
    private var sessionDetailPanel: some View {
        if let session = backendClient.selectedSession {
            SessionDetailPanel(session: session)
        } else {
            ContentUnavailableView("会话详情", systemImage: "sidebar.right")
        }
    }
}

// 会话详细信息面板（Sessions Tab 右栏）
struct SessionDetailPanel: View {
    @ObservedObject private var backendClient = BackendClient.shared
    let session: TaskSession

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(session.title)
                    .font(.title3.bold())
                    .textSelection(.enabled)

                HStack(spacing: 8) {
                    Circle()
                        .fill(session.status.color)
                        .frame(width: 8, height: 8)
                    Text(session.status.label)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                if !session.summary.isEmpty {
                    Text(session.summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    detailRow("Agent", session.agent)
                    if let provider = session.external?.provider {
                        detailRow("Provider", provider)
                    }
                    if let model = session.external?.currentModel {
                        detailRow("模型", model)
                    }
                    if let reasoning = session.external?.currentReasoningLevel {
                        detailRow("推理", reasoning)
                    }
                    if let cwd = session.external?.cwd {
                        detailRow("工作目录", cwd)
                    }
                    if session.progress > 0 {
                        detailRow("进度", "\(Int(session.progress * 100))%")
                    }
                    detailRow("更新时间", session.updatedAt)
                }

                Divider()

                if session.canInterruptNow {
                    Button("中断") {
                        backendClient.interrupt(session: session)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout)
                .textSelection(.enabled)
        }
    }
}
