import Combine
import CorptieConversation
import AppKit
import SwiftUI

func sessionAgentDisplayName(session: TaskSession, agents: [Agent]) -> String {
    guard let agentId = session.agentId?.trimmingCharacters(in: .whitespacesAndNewlines),
          !agentId.isEmpty else {
        return "未挂载"
    }
    return agents.first(where: { $0.agentId == agentId })?.name ?? agentId
}

struct SessionCorptieTaskDetailCard: View {
    @ObservedObject private var entityClient = EntityAPIClient.shared
    let taskId: String
    var decoratesSurface = true
    var showsHeader = true
    var embedsInParentScroll = false
    @State private var task: CorptieTask?
    @State private var isLoading = true

    var body: some View {
        Group {
            if let task, decoratesSurface {
                ConversationDetailDashboard {
                    taskDetail(task, embedsInParentScroll: true)
                }
            } else if let task {
                taskDetail(task, embedsInParentScroll: embedsInParentScroll)
            } else if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView(
                    L10n("Unable to Load CorptieTask"),
                    systemImage: "exclamationmark.triangle",
                    description: Text(L10n("绑定记录可能已不存在"))
                )
            }
        }
        .frame(maxHeight: embedsInParentScroll ? nil : .infinity)
        .task(id: taskId) {
            isLoading = true
            if entityClient.works.isEmpty {
                await entityClient.refreshWorks()
            }
            if entityClient.repositories.isEmpty {
                await entityClient.refreshRepositories()
            }
            if let cached = entityClient.tasks.first(where: { $0.id == taskId }) {
                task = cached
            } else {
                task = await entityClient.task(id: taskId)
            }
            isLoading = false
        }
        .onChange(of: entityClient.tasksRevision) { _, _ in
            if let refreshed = entityClient.tasks.first(where: { $0.id == taskId }) {
                task = refreshed
            }
        }
    }

    private func taskDetail(_ task: CorptieTask, embedsInParentScroll: Bool) -> some View {
        let work = entityClient.works.first { $0.id == task.workId }
        return CorptieTaskDetailView(
            task: task,
            contributorAgentIds: work?.contributorAgentIds ?? [],
            onRequestReload: {
                Task { await entityClient.refreshWorks() }
            },
            showsHeader: showsHeader,
            embedsInParentScroll: embedsInParentScroll
        )
    }
}
