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

/// Prepared when message data changes, never while scrolling or expanding.
struct ConversationChecklistDockProjection {
    var timelineRows: [AppKitChatTimelineRow] = []
    var checklist: ConversationExecutionPlan?

    init(rows: [AppKitChatTimelineRow]) {
        timelineRows.reserveCapacity(rows.count)
        for row in rows {
            if let plan = row.executionPlan, plan.taskId != nil {
                checklist = plan
            } else {
                timelineRows.append(row)
            }
        }
    }
}

/// A sibling of the message scroller, so reading history cannot hide it.
struct PinnedExecutionChecklistCard: View {
    let plan: ConversationExecutionPlan
    @State private var width: CGFloat = 300
    @State private var expanded = false

    static func height(plan: ConversationExecutionPlan, width: CGFloat, expanded: Bool) -> CGFloat {
        min(280, NativePlanChecklistHeightCache.shared.height(of: plan, width: width - 28, expanded: expanded) + 28)
    }

    var body: some View {
        ScrollView(.vertical) {
            if let taskID = plan.taskId {
                DesktopExecutionChecklistContent(plan: plan, taskID: taskID, width: width - 28,
                    isExpanded: expanded, onToggleExpansion: { expanded.toggle() })
                    .padding(14)
            }
        }
        .frame(height: Self.height(plan: plan, width: width, expanded: expanded))
        .frame(maxWidth: 780)
        .onGeometryChange(for: CGFloat.self) { max(148, $0.size.width) } action: { width = $0 }
        .modifier(ConversationSkinSurface(role: .plan, radius: 14,
            legacyFill: Color.secondary.opacity(0.06), legacyBorder: Color.secondary.opacity(0.2)))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("conversation.pinned-execution-checklist")
    }
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
    var isExpanded: Bool? = nil
    var onToggleExpansion: (() -> Void)? = nil
    @State private var savedPlan: ConversationExecutionPlan?
    var body: some View {
        TaskExecutionChecklist(plan: currentPlan, width: width, canEdit: canEdit,
                               isExpanded: isExpanded, onToggleExpansion: onToggleExpansion) { command in
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
