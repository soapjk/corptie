#if os(iOS)
import SwiftUI
import CorptieClientCore
import CorptieConversation

/// Pure resident-state projection. Opening the rail never requests a timeline.
struct PadConversationInspector: View {
    @Bindable var workspace: PadWorkspace
    let connection: PadConnection
    let sessionID: String
    private var inspector: PadInspectorStore { workspace.inspectorStore(for: sessionID) }
    private var session: ClientSession? { workspace.sessionsByID[sessionID] }
    private var kind: ConversationInspectorKind {
        .resolve(sessionKind: session?.sessionKind, taskID: session?.taskId, workID: session?.workId)
    }
    var body: some View {
        ConversationDetailDashboard {
            if let session {
                PadInspectorResources(store: inspector, connection: connection, sessionID: sessionID, workspace: workspace, kind: kind) {
                    ConversationSessionInformationCard(sessionID: session.id,
                        workName: workspace.works.first(where: { $0.id == session.workId })?.name)
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
        if kind == .chat {
            ConversationChatSummaryCard(summary: inspector.snapshot?.summary ?? session.summary)
        }
        if kind == .work, let work = workspace.works.first(where: { $0.id == session.workId }) {
            ConversationWorkOverviewCard(description: inspector.snapshot?.workDescription ?? work.description)
            let tasks = (inspector.sections["focusTasks"]?.items ?? []).compactMap { value -> ConversationFocusTask? in
                let resident = workspace.tasks.first { $0.id == value["id"].text }
                return ConversationFocusTask(inspectorValue: value, sessionID: resident?.currentSessionId)
            }
            ConversationFocusTasksCard(tasks: tasks) { _, sessionID in
                workspace.selection = sessionID
            }
        }
    }
}
#endif
