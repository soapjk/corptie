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
            if let task {
                let work = entityClient.works.first { $0.id == task.workId }
                CorptieTaskDetailView(
                    task: task,
                    contributorAgentIds: work?.contributorAgentIds ?? [],
                    onRequestReload: {
                        Task { await entityClient.refreshWorks() }
                    },
                    showsHeader: showsHeader,
                    embedsInParentScroll: embedsInParentScroll
                )
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
        .modifier(DetailRailSurfaceModifier(enabled: decoratesSurface))
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
}

struct DetailRailSurfaceModifier: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        // Decorate the same content identity when switching workspace modes.
        content
            // A surface is also a containment boundary: a fixed frame alone
            // does not prevent native children or overlays drawing outside it.
            // Keep one content identity across modes; disabled surfaces have
            // no rounded corners, as before.
            .clipShape(RoundedRectangle(cornerRadius: enabled ? 12 : 0, style: .continuous))
            .background {
                if enabled {
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.regularMaterial)
                }
            }
            .overlay {
                if enabled {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color(nsColor: .separatorColor).opacity(0.42), lineWidth: 1)
                }
            }
            .shadow(color: Color.black.opacity(enabled ? 0.055 : 0), radius: enabled ? 9 : 0, x: 0, y: enabled ? 3 : 0)
    }
}
