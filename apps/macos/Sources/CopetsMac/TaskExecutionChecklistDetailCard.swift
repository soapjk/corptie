import SwiftUI
import CorptieClientCore
import CorptieConversation

extension Notification.Name {
    static let executionChecklistChanged = Notification.Name("executionChecklistChanged")
}

@MainActor
func desktopExecutionChecklistAPI() throws -> ClientExecutionChecklistAPI {
    ClientExecutionChecklistAPI(transport: try BackendTransport(endpoint: BackendEndpoint(CorptieAppEnvironment.backendBaseURL)))
}

/// Independent Detail module. It observes only its Task's committed checklist
/// changes, never token streams or the complete global entity collection.
struct TaskExecutionChecklistDetailCard: View {
    let taskID: String
    let width: CGFloat
    var active = true
    @State private var plan: ConversationExecutionPlan?
    @State private var writesAllowed = false
    @State private var error: String?
    @State private var refreshTask: Task<Void, Never>?
    @State private var requestGeneration = UUID()
    var body: some View {
        Group {
            if let plan {
                DesktopExecutionChecklistContent(plan: plan, taskID: taskID, width: width, canEdit: writesAllowed)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Label("执行清单", systemImage: "list.bullet.clipboard").font(.system(size: 12, weight: .semibold))
                    Text(error == nil ? "模型开始执行时将在这里建立清单" : "清单暂时无法加载")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                    if error != nil { Button("重试") { refresh() }.font(.system(size: 11)) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: active ? taskID : nil) {
            guard active else { return }
            requestGeneration = UUID(); plan = nil
            await load()
        }
        .onReceive(NotificationCenter.default.publisher(for: .executionChecklistChanged)) { event in
            guard active, event.object as? String == taskID else { return }
            refresh()
        }
        .onDisappear { requestGeneration = UUID(); refreshTask?.cancel() }
    }
    private func refresh() {
        refreshTask?.cancel()
        refreshTask = Task { await load() }
    }
    private func load() async {
        let generation = requestGeneration
        do {
            let response = try await desktopExecutionChecklistAPI().read(taskID: taskID)
            guard !Task.isCancelled, generation == requestGeneration else { return }
            if (response.checklist?.revision ?? 0) >= (plan?.revision ?? 0) { plan = response.checklist }
            writesAllowed = response.writesAllowed == true
            error = nil
        } catch {
            guard !Task.isCancelled, generation == requestGeneration else { return }
            self.error = error.localizedDescription
        }
    }
}

struct DesktopExecutionChecklistContent: View {
    let plan: ConversationExecutionPlan
    let taskID: String
    let width: CGFloat
    var canEdit = true
    @State private var savedPlan: ConversationExecutionPlan?
    var body: some View {
        TaskExecutionChecklist(plan: currentPlan, width: width, canEdit: canEdit) { command in
            do {
                let response = try await desktopExecutionChecklistAPI().update(taskID: taskID, command: command)
                accept(response.checklist)
            } catch {
                if let response = try? await desktopExecutionChecklistAPI().read(taskID: taskID) { accept(response.checklist) }
                throw error
            }
        }
        .id(plan.planId)
        .onChange(of: plan.planId) { _, _ in savedPlan = nil }
        .onChange(of: plan.revision) { _, _ in accept(plan) }
    }
    private var currentPlan: ConversationExecutionPlan { savedPlan?.planId == plan.planId ? savedPlan ?? plan : plan }
    private func accept(_ next: ConversationExecutionPlan?) {
        guard let next, next.planId == plan.planId, next.revision >= currentPlan.revision else { return }
        savedPlan = next
    }
}
