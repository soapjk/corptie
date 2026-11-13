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

/// One generation owns both the indicator gate and the native height envelope.
/// Interrupted SwiftUI animations still call completion; they must not reopen it.
struct ChecklistDisclosureVisibility {
    private var generation = UUID()
    private var presented = false
    private(set) var settled = false
    private(set) var retainsExpandedEnvelope = false

    func allowsIndicators(expanded: Bool) -> Bool { presented && settled && expanded }

    mutating func begin(animated: Bool) -> UUID {
        generation = UUID()
        settled = !animated
        retainsExpandedEnvelope = animated
        return generation
    }

    mutating func complete(_ token: UUID) {
        guard presented, generation == token else { return }
        settled = true
        retainsExpandedEnvelope = false
    }

    mutating func setPresented(_ value: Bool) {
        generation = UUID()
        presented = value
        settled = value
        retainsExpandedEnvelope = false
    }

    mutating func settleImmediately() {
        generation = UUID()
        settled = presented
        retainsExpandedEnvelope = false
    }
}

/// A sibling of the message scroller, so reading history cannot hide it.
struct PinnedExecutionChecklistCard: View {
    let plan: ConversationExecutionPlan
    var jumpControl: AnyView? = nil
    var active = true
    @State private var width: CGFloat = 300
    @State private var expanded = false
    @State private var disclosureVisibility = ChecklistDisclosureVisibility()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func height(plan: ConversationExecutionPlan, width: CGFloat, expanded: Bool) -> CGFloat {
        guard expanded else { return 36 }
        let contentWidth = width - 20
        let full = NativePlanChecklistHeightCache.shared.height(of: plan, width: contentWidth, expanded: true)
        let oldDisclosure: CGFloat = plan.closed != true && plan.steps.count > TaskExecutionChecklist.columns(for: contentWidth) * 2 ? 24 : 0
        return min(280, full - oldDisclosure + 16)
    }

    var body: some View {
        let allowsIndicator = active && disclosureVisibility.allowsIndicators(expanded: expanded)
        let expandedHeight = expanded || disclosureVisibility.retainsExpandedEnvelope
            ? Self.height(plan: plan, width: width, expanded: true) : 36
        ScrollView(.vertical) {
            if let taskID = plan.taskId {
                DesktopExecutionChecklistContent(plan: plan, taskID: taskID, width: width - 20,
                    isExpanded: expanded, onToggleExpansion: toggleExpansion, compact: true)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    // Probe the floating card's own scroll content, never the
                    // transcript or Detail rail. Use the exact Work navigation
                    // drawing/fading policy used by ConsoleFlatSessionList.
                    .background(ConsoleOverlayScroller(usesWorkStyle: true, allowsVerticalIndicator: allowsIndicator))
            }
        }
        // SwiftUI and the native configuration receive the same gate, including
        // first layout; neither can reopen it during disclosure animation.
        .scrollIndicators(allowsIndicator ? .automatic : .hidden)
        .frame(height: Self.height(plan: plan, width: width, expanded: expanded))
        .frame(maxWidth: 780)
        .onGeometryChange(for: CGFloat.self) { max(148, $0.size.width) } action: { width = $0 }
        .platformGlassSurface(in: RoundedRectangle(cornerRadius: 14, style: .continuous), variant: .regular)
        .overlay(alignment: .top) {
            if let jumpControl {
                jumpControl.offset(y: -(ComposerQuickMessagesBar.jumpControlSize + 8))
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: expanded)
        // Native ideal size changes only at expansion start / collapse end.
        // The interpolated card stays bottom-aligned inside that safe envelope.
        .frame(height: expanded || disclosureVisibility.retainsExpandedEnvelope ? expandedHeight : 36, alignment: .bottom)
        // Keep the native envelope discrete even though the disclosure uses an
        // explicit completion transaction. Only the inner card animates above.
        .transaction { $0.animation = nil }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { disclosureVisibility.setPresented(active) }
        .onDisappear { disclosureVisibility.setPresented(false) }
        .onChange(of: active) { _, active in disclosureVisibility.setPresented(active) }
        .onChange(of: reduceMotion) { _, reduced in
            if reduced { disclosureVisibility.settleImmediately() }
        }
        .accessibilityIdentifier("conversation.pinned-execution-checklist")
    }

    private func toggleExpansion() {
        guard active else { return }
        // Close the gate outside the animation transaction, including collapse.
        let token = disclosureVisibility.begin(animated: !reduceMotion)
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2), completionCriteria: .removed) {
            expanded.toggle()
        } completion: {
            disclosureVisibility.complete(token)
        }
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
