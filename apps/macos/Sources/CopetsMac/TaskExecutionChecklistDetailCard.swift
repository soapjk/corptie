import SwiftUI
import CorptieClientCore
import CorptieConversation

extension Notification.Name {
    static let executionChecklistAssignmentChanged = Notification.Name("executionChecklistAssignmentChanged")
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
    var latestChecklist: ConversationExecutionPlan?
    var timelineIndexByRowID: [String: Int] = [:]
    var disclosureRowIndices: [String: Int] = [:]
    private var timelineSourceIndices: [Int] = []

    /// Only structural inputs and committed checklist revisions invalidate indices.
    /// Refresh row values even when structure is reusable: text may have streamed.
    @discardableResult
    mutating func update(rows: [AppKitChatTimelineRow], previousRows: [AppKitChatTimelineRow]) -> Bool {
        let sameStructure = rows.count == previousRows.count && zip(previousRows, rows).allSatisfy { old, next in
            old.id == next.id && old.expandableTurnId == next.expandableTurnId
                && old.executionPlan?.planId == next.executionPlan?.planId
                && old.executionPlan?.revision == next.executionPlan?.revision
                && old.executionPlan?.taskId == next.executionPlan?.taskId
                && old.executionPlan?.closed == next.executionPlan?.closed
        }
        guard sameStructure else {
            self = Self(rows: rows)
            return true
        }
        timelineRows = timelineSourceIndices.map { rows[$0] }
        return false
    }

    init(rows: [AppKitChatTimelineRow]) {
        timelineRows.reserveCapacity(rows.count)
        for (index, row) in rows.enumerated() {
            if let turnID = row.expandableTurnId, disclosureRowIndices[turnID] == nil {
                disclosureRowIndices[turnID] = index
            }
            if let plan = row.executionPlan, plan.taskId != nil,
               plan.revision > (latestChecklist?.revision ?? -1) { latestChecklist = plan }
            if let plan = row.executionPlan, plan.taskId != nil, plan.closed != true {
                checklist = plan
            } else {
                timelineIndexByRowID[row.id] = timelineRows.count
                timelineRows.append(row)
                timelineSourceIndices.append(index)
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
        guard expanded else { return 36 }
        let contentWidth = width - 20
        let full = NativePlanChecklistHeightCache.shared.height(of: plan, width: contentWidth, expanded: true)
        let oldDisclosure: CGFloat = plan.closed != true && plan.steps.count > TaskExecutionChecklist.columns(for: contentWidth) * 2 ? 24 : 0
        return min(280, full - oldDisclosure + 16)
    }

    var body: some View {
        ScrollView(.vertical) {
            if let taskID = plan.taskId {
                DesktopExecutionChecklistContent(plan: plan, taskID: taskID, width: width - 20,
                    isExpanded: expanded, onToggleExpansion: { expanded.toggle() }, compact: true)
                    .padding(.horizontal, 10).padding(.vertical, 8)
            }
        }
        .frame(height: Self.height(plan: plan, width: width, expanded: expanded))
        .frame(maxWidth: 780)
        .onGeometryChange(for: CGFloat.self) { max(148, $0.size.width) } action: { width = $0 }
        .platformGlassSurface(in: RoundedRectangle(cornerRadius: 14, style: .continuous), variant: .regular)
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
            if plan?.closed != true {
                Group {
                    if let plan {
                        DesktopExecutionChecklistContent(plan: plan, taskID: taskID, width: width, canEdit: writesAllowed, compact: true, observesAssignments: false)
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("执行清单", systemImage: "list.bullet.clipboard").font(.system(size: 12, weight: .semibold))
                            Text(error == nil ? "模型开始执行时将在这里建立清单" : "清单暂时无法加载")
                                .font(.system(size: 12)).foregroundStyle(.secondary)
                            if error != nil { Button("重试") { refresh() }.font(.system(size: 11)) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    }.modifier(ConversationDetailModuleSurface())
            }
        }
        .task(id: active ? taskID : nil) {
            guard active else { return }
            requestGeneration = UUID(); plan = nil
            await load()
        }
        .onReceive(NotificationCenter.default.publisher(for: .executionChecklistChanged).whilePresented(active)) { event in
            guard active, event.object as? String == taskID else { return }
            if let next = event.userInfo?["checklist"] as? ConversationExecutionPlan,
               next.revision >= (plan?.revision ?? 0) { plan = next }
            else { refresh() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .executionChecklistAssignmentChanged).whilePresented(active)) { event in
            guard active, event.object as? String == taskID,
                  plan?.steps.contains(where: { $0.assignment != nil }) == true else { return }
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
    var compact = false
    var observesAssignments = true
    @State private var assignmentRefresh: Task<Void, Never>?
    @State private var savedPlan: ConversationExecutionPlan?
    var body: some View {
        TaskExecutionChecklist(plan: currentPlan, width: width, canEdit: canEdit,
                               isExpanded: isExpanded, onToggleExpansion: onToggleExpansion,
                               compactSummary: compact ? NativePlanChecklistHeightCache.shared.summary(of: currentPlan, width: width) : nil, openAssignment: { assignment in
                                   guard let childID = assignment.taskId, let childSessionID = assignment.sessionId else { return }
                                   AppTabRouter.shared.openTaskSession(taskId: childID, sessionId: childSessionID, source: .userSelection)
                               }) { command in
            do {
                let response = try await desktopExecutionChecklistAPI().update(taskID: taskID, command: command)
                accept(response.checklist)
                if command.action == "close", let next = response.checklist {
                    NotificationCenter.default.post(name: .executionChecklistChanged, object: taskID,
                        userInfo: ["checklist": next])
                }
            } catch {
                if let response = try? await desktopExecutionChecklistAPI().read(taskID: taskID) { accept(response.checklist) }
                throw error
            }
        }
        .id(plan.planId)
        .onChange(of: plan.planId) { _, _ in savedPlan = nil }
        .onChange(of: plan.revision) { _, _ in accept(plan) }
        .task(id: plan.revision) {
            if observesAssignments && plan.steps.contains(where: { $0.assignment != nil }) { await loadAssignments() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .executionChecklistAssignmentChanged).whilePresented(observesAssignments)) { event in
            guard observesAssignments, event.object as? String == taskID,
                  currentPlan.steps.contains(where: { $0.assignment != nil }) else { return }
            assignmentRefresh?.cancel()
            assignmentRefresh = Task { await loadAssignments() }
        }
        .onDisappear { assignmentRefresh?.cancel() }
    }
    private func loadAssignments() async {
        if let response = try? await desktopExecutionChecklistAPI().read(taskID: taskID), !Task.isCancelled {
            accept(response.checklist)
        }
    }
    private var currentPlan: ConversationExecutionPlan { savedPlan?.planId == plan.planId ? savedPlan ?? plan : plan }
    private func accept(_ next: ConversationExecutionPlan?) {
        guard let next, next.planId == plan.planId, next.revision >= currentPlan.revision else { return }
        savedPlan = next
    }
}
