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
    let close: () -> Void
    private var session: ClientSession? { workspace.sessionsByID[sessionID] }
    private var kind: ConversationInspectorKind {
        .resolve(sessionKind: session?.sessionKind, taskID: session?.taskId, workID: session?.workId)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Detail").font(.headline).accessibilityAddTraits(.isHeader)
                Spacer()
                Button(action: close) { Image(systemName: "sidebar.right").frame(width: 44, height: 44) }
                    .accessibilityLabel("关闭详情")
            }.padding(.horizontal, 16)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if let session {
                        Text(session.title).font(.title3.weight(.semibold)).textSelection(.enabled)
                        if kind == .task, let task = workspace.tasks.first(where: { $0.id == session.taskId }) {
                            ConversationTaskDefinition(description: inspector.snapshot?.taskDefinition?["description"].text ?? task.description ?? "",
                                acceptance: inspector.snapshot?.taskDefinition?["acceptanceCriteria"].text ?? task.acceptanceCriteria ?? "",
                                verification: inspector.snapshot?.taskDefinition?["verificationCriteria"].text ?? task.verificationCriteria ?? "")
                        }
                        if kind == .chat, let summary = inspector.snapshot?.summary ?? session.summary, !summary.isEmpty {
                            ConversationInspectorSection(title: "会话摘要", systemImage: "text.alignleft") {
                                ConversationDetailText(text: summary)
                            }
                        }
                        if kind == .work, let work = workspace.works.first(where: { $0.id == session.workId }) {
                            ConversationInspectorSection(title: "Work 概述", systemImage: "scope") {
                                if let description = inspector.snapshot?.workDescription ?? work.description {
                                    if description.isEmpty { Text("尚未填写概述").foregroundStyle(.secondary) }
                                    else { ConversationDetailText(text: description) }
                                } else { unavailable("正在等待 Work 概述…") }
                            }
                            ConversationInspectorSection(title: "重点 Task", systemImage: "checklist") {
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
                        ConversationInspectorSection(title: "执行状态", systemImage: "waveform.path.ecg") {
                            Text(executionLabel(session.executionStatus))
                            if let activity = session.activityStatus, !activity.isEmpty {
                                ConversationDetailText(text: activity)
                            }
                        }
                        ConversationInspectorSection(title: "会话信息", systemImage: "info.circle") {
                            Text(session.id).font(.caption.monospaced()).textSelection(.enabled)
                            if let work = workspace.works.first(where: { $0.id == session.workId }) { Text(work.name) }
                        }
                        if workspace.selection == sessionID {
                            ConversationInspectorSection(title: "运行环境", systemImage: "cpu") {
                                if let provider = workspace.usage?.account?.provider { LabeledContent("Provider", value: provider) }
                                if let model = workspace.composerConfiguration?.currentModel ?? workspace.usage?.account?.model {
                                    LabeledContent("模型", value: model)
                                }
                                if let reasoning = workspace.composerConfiguration?.currentReasoningLevel {
                                    LabeledContent("推理强度", value: reasoning)
                                }
                            }
                        }
                        PadInspectorResources(store: inspector, connection: connection, sessionID: sessionID, workspace: workspace)
                    } else {
                        ContentUnavailableView("会话尚未同步", systemImage: "bubble.left.and.bubble.right")
                    }
                }.padding(16)
            }
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .accessibilityIdentifier("conversation-detail-inspector")
        .task(id: "\(connection.serverID):\(connection.address):\(sessionID)") {
            await inspector.observe(sessionID: sessionID, connection: connection)
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
