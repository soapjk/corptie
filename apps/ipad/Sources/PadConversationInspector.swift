#if os(iOS)
import SwiftUI
import CorptieClientCore
import CorptieConversation

/// Pure resident-state projection. Opening the rail never requests a timeline.
struct PadConversationInspector: View {
    @Bindable var workspace: PadWorkspace
    let connection: PadConnection
    @State private var inspector = PadInspectorStore()
    let sessionID: String
    private var session: ClientSession? { workspace.sessionsByID[sessionID] }
    private var kind: ConversationInspectorKind {
        .resolve(sessionKind: session?.sessionKind, taskID: session?.taskId, workID: session?.workId)
    }
    var body: some View {
        ConversationDetailDashboard(actions: { EmptyView() }) {
            if let session {
                Text(session.title).font(.title3.weight(.semibold)).textSelection(.enabled)
                    .padding(.horizontal, 4)
                PadInspectorResources(store: inspector, connection: connection, sessionID: sessionID, workspace: workspace) {
                    ConversationDetailCompactPair {
                        ConversationDetailModuleCard(title: "执行状态", systemImage: "waveform.path.ecg") {
                            Text(executionLabel(session.executionStatus))
                            if let activity = session.activityStatus, !activity.isEmpty {
                                ConversationDetailText(text: activity)
                            }
                        }
                    } trailing: {
                        ConversationDetailModuleCard(title: "会话信息", systemImage: "info.circle") {
                            Text(session.id).font(.caption.monospaced()).lineLimit(1)
                                .truncationMode(.middle).textSelection(.enabled)
                            if let work = workspace.works.first(where: { $0.id == session.workId }) {
                                Text(work.name).lineLimit(2)
                            }
                        }
                    }
                } secondary: {
                    primaryDetail(for: session)
                }
            } else {
                ContentUnavailableView("会话尚未同步", systemImage: "bubble.left.and.bubble.right")
            }
        }
        .accessibilityIdentifier("conversation-detail-inspector")
        .task(id: "\(connection.serverID):\(connection.address):\(sessionID)") {
            await inspector.observe(sessionID: sessionID, connection: connection)
        }
    }
    @ViewBuilder private func primaryDetail(for session: ClientSession) -> some View {
        if kind == .task {
            let task = workspace.tasks.first { $0.id == session.taskId }
            let description = inspector.snapshot?.taskDefinition?["description"].text ?? task?.description ?? ""
            let acceptance = inspector.snapshot?.taskDefinition?["acceptanceCriteria"].text ?? task?.acceptanceCriteria ?? ""
            let verification = inspector.snapshot?.taskDefinition?["verificationCriteria"].text ?? task?.verificationCriteria ?? ""
            if ConversationTaskDefinition.hasContent(description: description, acceptance: acceptance, verification: verification) {
                ConversationDetailModuleCard(title: "Task 定义", systemImage: "checklist") {
                    ConversationTaskDefinition(description: description, acceptance: acceptance, verification: verification)
                }
            }
        }
        if kind == .chat, let summary = inspector.snapshot?.summary ?? session.summary, !summary.isEmpty {
            ConversationDetailModuleCard(title: "会话摘要", systemImage: "text.alignleft") {
                ConversationDetailText(text: summary)
            }
        }
        if kind == .work, let work = workspace.works.first(where: { $0.id == session.workId }) {
            ConversationDetailModuleCard(title: "Work 概述", systemImage: "scope") {
                if let description = inspector.snapshot?.workDescription ?? work.description {
                    if description.isEmpty { Text("尚未填写概述").foregroundStyle(.secondary) }
                    else { ConversationDetailText(text: description) }
                } else { unavailable("正在等待 Work 概述…") }
            }
            ConversationDetailModuleCard(title: "重点 Task", systemImage: "checklist") {
                let tasks = inspector.sections["focusTasks"]?.items ?? []
                ForEach(tasks, id: \.inspectorID) { task in
                    let resident = workspace.tasks.first { $0.id == task["id"].text }
                    Button {
                        if let id = resident?.currentSessionId { workspace.selection = id }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(task["title"].text ?? "Task")
                            Text(task["summary"]["content"][task["needsIntervention"].flag ? "nextAction" : "focus"].text ?? "")
                                .font(.caption).foregroundStyle(task["needsIntervention"].flag ? Color.orange : Color.secondary)
                        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }.disabled(resident?.currentSessionId == nil)
                }
                if tasks.isEmpty && inspector.snapshot != nil { Text("暂无进行中的 Task").foregroundStyle(.secondary) }
            }
        }
    }
    private func unavailable(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(.secondary)
    }
    private func executionLabel(_ status: String) -> String {
        switch SessionExecutionState(executionStatus: status) {
        case .running: "执行中"
        case .blocked: "等待处理"
        case .complete: "已完成"
        case .failed: "执行失败"
        case .cancelled: "已中断"
        case nil: status
        }
    }
}
#endif
