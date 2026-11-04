import SwiftUI
import Combine
import CorptieConversation

enum AutomationCategory: String, CaseIterable, Identifiable {
    case all
    case running
    case failed
    case history

    var id: String { rawValue }
    @MainActor var title: String {
        switch self {
        case .all: L10n("当前任务")
        case .running: L10n("Running")
        case .failed: L10n("Failed")
        case .history: L10n("History")
        }
    }
    var symbol: String {
        switch self {
        case .all: "bolt.badge.clock"
        case .running: "bolt.circle"
        case .failed: "exclamationmark.triangle"
        case .history: "clock.arrow.circlepath"
        }
    }
}

enum AutomationOverviewPolicy {
    static func items(in category: AutomationCategory, from automations: [ScheduledSessionTask]) -> [ScheduledSessionTask] {
        switch category {
        case .all: automations.filter {
            $0.status == .active || $0.status == .error
                || [.claimed, .queued, .running].contains($0.lastRunStatus ?? .missed)
        }
        case .running: automations.filter {
            [.claimed, .queued, .running].contains($0.lastRunStatus ?? .missed)
        }
        case .failed: automations.filter { $0.status == .error || $0.lastRunStatus == .failed }
        case .history: automations.filter {
            $0.status != .active && $0.status != .error || !$0.runs.isEmpty
        }
        }
    }
    static func sortedItems(in category: AutomationCategory, from automations: [ScheduledSessionTask]) -> [ScheduledSessionTask] {
        items(in: category, from: automations).sorted { left, right in
            let leftRank = left.status == .error ? 0 : (left.lastRunStatus == .running ? 1 : 2)
            let rightRank = right.status == .error ? 0 : (right.lastRunStatus == .running ? 1 : 2)
            if leftRank != rightRank { return leftRank < rightRank }
            if category != .history {
                let leftNext = left.nextRunAt.flatMap(ScheduledSessionDateFormatting.date(from:)) ?? .distantFuture
                let rightNext = right.nextRunAt.flatMap(ScheduledSessionDateFormatting.date(from:)) ?? .distantFuture
                if leftNext != rightNext { return leftNext < rightNext }
            }
            if left.updatedAt != right.updatedAt { return left.updatedAt > right.updatedAt }
            return left.id < right.id
        }
    }

}

private struct AutomationTarget: Equatable {
    let sessionID: String
    let title: String?
}

struct AutomationsView: View {
    private let router = AppTabRouter.shared
    @EnvironmentObject private var sidebarState: TabSidebarState
    private let backendClient = BackendClient.shared
    @ObservedObject private var scheduling = BackendClient.shared.scheduledTaskController
    @State private var category: AutomationCategory? = .all
    @State private var editingAutomation: ScheduledSessionTask?
    @State private var focusedAutomationID: String?
    @State private var searchText = ""
    @State private var showsCreationHelp = false
    @State private var focusRevision = 0
    @State private var categoryItems: [AutomationCategory: [ScheduledSessionTask]] = [:]
    @State private var visibleAutomations: [ScheduledSessionTask] = []
    @State private var targets: [String: AutomationTarget] = [:]
    @AppStorage("ui.automations.cards", store: CorptieAppEnvironment.userDefaults) private var showsCards = false

    private func tasks(in category: AutomationCategory) -> [ScheduledSessionTask] {
        categoryItems[category] ?? []
    }

    // Sorting is tied to source changes, never a geometry/body evaluation or
    // returning to this cached page. Category switches reuse prepared arrays.
    private func rebuildCategories(_ automations: [ScheduledSessionTask]) {
        categoryItems = Dictionary(uniqueKeysWithValues: AutomationCategory.allCases.map {
            ($0, AutomationOverviewPolicy.sortedItems(in: $0, from: automations))
        })
        updateVisibleAutomations()
        focusPendingAutomation()
    }

    private func updateVisibleAutomations() {
        let items = tasks(in: category ?? .all)
        visibleAutomations = searchText.isEmpty ? items : items.filter {
            "\($0.name) \($0.message) \(targetName(for: $0))".localizedCaseInsensitiveContains(searchText)
        }
    }

    private func updateTargets() {
        var next: [String: AutomationTarget] = [:]
        // AppStateStore already caches its stable Session order. Preserve the
        // existing first matching active Session when aliases overlap.
        for session in backendClient.sessions {
            let key = session.external?.logicalSessionId ?? session.id
            if next[key] == nil { next[key] = AutomationTarget(sessionID: session.id, title: session.title) }
        }
        guard next != targets else { return }
        targets = next
        if !searchText.isEmpty { updateVisibleAutomations() }
    }

    var body: some View {
        GeometryReader { geometry in
            let inlineSidebar = geometry.size.width >= 820 && sidebarState.isVisible
            HStack(spacing: 0) {
                if inlineSidebar {
                    categoryList
                        .padding(.top, MainWindowLayoutMetrics.titlebarHeight)
                        .frame(width: 284)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .background(WorkbenchStyle.sidebarColor)
                    Divider()
                }
                VStack(spacing: 0) {
                    header
                    HStack(spacing: 12) {
                        if !inlineSidebar {
                            Picker(L10n("Automations"), selection: $category) {
                                ForEach(AutomationCategory.allCases) { item in
                                    Text(item.title).tag(Optional(item))
                                }
                            }
                            .labelsHidden()
                            .frame(maxWidth: 160)
                            .accessibilityLabel(L10n("Automations"))
                        }
                        TextField(L10n("搜索自动化名称、消息或会话"), text: $searchText)
                            .textFieldStyle(.roundedBorder)
                        Picker(L10n("视图"), selection: $showsCards) {
                            Text(L10n("列表")).tag(false)
                            Text(L10n("卡片")).tag(true)
                        }.pickerStyle(.segmented).labelsHidden().frame(width: 120)
                    }.padding(.horizontal, 16).padding(.bottom, 12)
                    Divider()
                    content
                }
                .padding(.top, MainWindowLayoutMetrics.titlebarHeight)
                .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(WorkbenchStyle.canvas)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(WorkbenchStyle.canvas.ignoresSafeArea(.container, edges: .vertical))
        .ignoresSafeArea(.container, edges: .top)
        .safeAreaInset(edge: .bottom) {
            if let error = scheduling.automationsError {
                HStack {
                    Label(error, systemImage: "exclamationmark.triangle").textSelection(.enabled)
                    Spacer()
                    Button(L10n("Retry")) { Task { await scheduling.loadAutomations() } }
                }.font(WorkbenchTypography.font(for: .help)).padding(12).background(WorkbenchStyle.canvas)
            }
        }
        .task { await scheduling.loadAutomations() }
        .onChange(of: scheduling.automations, initial: true) { _, values in rebuildCategories(values) }
        .onReceive(router.$pendingAutomationId.removeDuplicates().receive(on: DispatchQueue.main)) { _ in focusPendingAutomation() }
        .onReceive(backendClient.appState.$state.map(\.sessions).removeDuplicates().receive(on: DispatchQueue.main)) { _ in updateTargets() }
        .onChange(of: category) { _, _ in updateVisibleAutomations() }
        .onChange(of: searchText) { _, _ in updateVisibleAutomations() }
        .sheet(item: $editingAutomation) { automation in
            if let session = targetSession(for: automation) {
                ScheduledTaskEditorSheet(
                    session: session,
                    existingTask: automation,
                    onSaved: { Task { await scheduling.loadAutomations() } }
                )
                .environmentObject(backendClient)
            }
        }
    }

    private var categoryList: some View {
        List(AutomationCategory.allCases, selection: $category) { item in
            ManagementCategoryRow(title: "\(item.title) · \(tasks(in: item).count)", systemImage: item.symbol,
                                  isSelected: category == item)
                .padding(.vertical, 2)
                .tag(Optional(item))
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 36)
        .padding(16)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(category?.title ?? L10n("Automations"))
                    .font(WorkbenchTypography.font(for: .pageTitle))
                Text(L10n("View scheduled and event-driven tasks and their run history."))
                    .font(WorkbenchTypography.font(for: .help))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(L10n("创建自动化")) { showsCreationHelp = true }
                .popover(isPresented: $showsCreationHelp) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(L10n("选择承载自动化的会话")).font(.headline)
                        Text(L10n("在会话输入区的更多菜单中创建定时或条件触发任务。结果会保留在对应会话中。"))
                        Button(L10n("前往工作台选择会话")) {
                            showsCreationHelp = false
                            router.selectTab(.console)
                        }
                    }.padding(20).frame(width: 320)
                }
            .buttonStyle(.borderedProminent)
            if scheduling.isLoadingAutomations { ProgressView().controlSize(.small) }
            Button {
                Task { await scheduling.loadAutomations() }
            } label: {
                Label(L10n("Refresh"), systemImage: "arrow.clockwise")
            }
        }
        .padding(16)
        .controlSize(.small)
    }

    @ViewBuilder
    private var content: some View {
        if scheduling.isLoadingAutomations && scheduling.automations.isEmpty {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if visibleAutomations.isEmpty {
            ContentUnavailableView {
                Label(L10n(scheduling.automations.isEmpty ? "No Automations" : "No matching Automations"),
                      systemImage: "bolt.badge.clock")
                    .font(WorkbenchTypography.font(for: .cardTitle))
            } description: {
                Text(L10n(scheduling.automations.isEmpty
                    ? "Create an Automation from a Session’s message composer."
                    : "Tasks in this category will appear here."))
                    .font(WorkbenchTypography.font(for: .help))
            } actions: {
                if category != .history && !scheduling.automations.isEmpty {
                    Button(L10n("查看执行历史")) { category = .history; searchText = "" }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVGrid(
                        columns: showsCards
                            ? [GridItem(.adaptive(minimum: 340, maximum: 520), spacing: 12, alignment: .top)]
                            : [GridItem(.flexible(), alignment: .top)],
                        alignment: .leading,
                        spacing: 12
                    ) {
                        ForEach(visibleAutomations) { automation in
                            AutomationMutationCard(
                                automation: automation,
                                targetName: targetName(for: automation),
                                openTarget: { openTarget(automation) },
                                edit: { edit(automation) },
                                perform: { action in
                                    Task { await scheduling.performAutomationAction(action, task: automation) }
                                }, isList: !showsCards
                            )
                            .id(automation.id)
                            .overlay {
                                if focusedAutomationID == automation.id {
                                    RoundedRectangle(cornerRadius: 14).stroke(.tint, lineWidth: 2)
                                }
                            }
                        }
                    }
                    .padding(16)
                }
                .onChange(of: focusRevision, initial: true) { _, _ in
                    guard let focusedAutomationID else { return }
                    proxy.scrollTo(focusedAutomationID, anchor: .center)
                }
            }

        }
    }

    private func focusPendingAutomation() {
        guard let id = router.pendingAutomationId,
              scheduling.automations.contains(where: { $0.id == id }) else { return }
        category = tasks(in: .history).contains(where: { $0.id == id }) ? .history : .all
        searchText = ""
        focusedAutomationID = id
        focusRevision += 1
        router.consumeAutomation(id)
    }

    private func targetName(for automation: ScheduledSessionTask) -> String {
        targets[automation.logicalSessionId]?.title ?? automation.logicalSessionId
    }

    private func targetSession(for automation: ScheduledSessionTask) -> TaskSession? {
        guard let target = targets[automation.logicalSessionId],
              let session = backendClient.appState.session(target.sessionID),
              session.archived != true,
              (session.external?.logicalSessionId ?? session.id) == automation.logicalSessionId else { return nil }
        return session
    }

    private func edit(_ automation: ScheduledSessionTask) {
        guard targetSession(for: automation) != nil else {
            router.navigationError = L10n("The target Logical Session is unavailable.")
            return
        }
        editingAutomation = automation
    }

    private func openTarget(_ automation: ScheduledSessionTask) {
        guard let session = targetSession(for: automation) else {
            router.navigationError = L10n("The target Logical Session is unavailable.")
            return
        }
        router.openSession(session.id, source: .userSelection)
    }
}

// The mutation publisher affects only the matching visible card, not the
// whole grid, its filtering or its other rows.
private struct AutomationMutationCard: View {
    let automation: ScheduledSessionTask
    let targetName: String
    let openTarget: () -> Void
    let edit: () -> Void
    let perform: (ScheduledSessionTaskAction) -> Void
    let isList: Bool
    @State private var isMutating = false

    var body: some View {
        AutomationCard(automation: automation, targetName: targetName, isMutating: isMutating,
                       openTarget: openTarget, edit: edit, perform: perform, isList: isList)
            .onReceive(BackendClient.shared.sessionCommandController.$scheduledTaskMutationIds
                .map { $0.contains(automation.id) }.removeDuplicates()) { isMutating = $0 }
    }
}

private struct AutomationCard: View {
    let automation: ScheduledSessionTask
    let targetName: String
    let isMutating: Bool
    let openTarget: () -> Void
    let edit: () -> Void
    let perform: (ScheduledSessionTaskAction) -> Void
    @State private var isShowingDetails = false

    var isList = false

    var body: some View {
        Group {
            if isList { listBody }
            else { cardBody }
        }
    }

    private var cardBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Text(automation.name)
                    .font(WorkbenchTypography.font(for: .cardTitle))
                    .lineLimit(2)
                Spacer()
                statusBadge
            }

            Button(action: openTarget) {
                Label(targetName, systemImage: "bubble.left.and.bubble.right")
                    .lineLimit(1)
            }
            .buttonStyle(.link)
            .font(WorkbenchTypography.font(for: .help))

            HStack(spacing: 8) {
                Label(triggerLabel, systemImage: "bolt.badge.clock")
                    .lineLimit(1)
                Spacer(minLength: 4)
                if automation.scheduleType.hasPredictableNextRun,
                   let nextRunLabel = optionalDateLabel(automation.nextRunAt) {
                    Label(nextRunLabel, systemImage: "calendar")
                        .lineLimit(1)
                }
            }
            .font(WorkbenchTypography.font(for: .metadata))
            .foregroundStyle(.secondary)

            Text(automation.message)
                .font(WorkbenchTypography.font(for: .body))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .textSelection(.enabled)

            if isShowingDetails { details }

            Divider()
            HStack(spacing: 8) {
                Button {
                    isShowingDetails.toggle()
                } label: {
                    Label(
                        L10n("详情"),
                        systemImage: isShowingDetails ? "chevron.up" : "chevron.down"
                    )
                }
                .buttonStyle(.borderless)

                Spacer(minLength: 4)
                compactActionButton(L10n("Edit"), systemImage: "pencil", action: edit)
                    .disabled(!automation.status.permitsEditing
                        || ![ScheduledSessionScheduleType.once, .interval].contains(automation.scheduleType))
                if automation.status.permitsResume {
                    compactActionButton(L10n("Retry"), systemImage: "arrow.clockwise") { perform(.retry) }
                }
                compactActionButton(L10n("Run Now"), systemImage: "play.fill") { perform(.runNow) }
                    .disabled(!automation.status.permitsRunNow)
                compactActionButton(L10n("Cancel"), systemImage: "xmark", role: .destructive) { perform(.cancel) }
                    .disabled(!automation.status.permitsCancel)
                if isMutating { ProgressView().controlSize(.mini) }
            }
            .disabled(isMutating || automation.operationsDisabledReason != nil)
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color(nsColor: .separatorColor).opacity(0.55)))
    }

    private var listBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 16) {
                    listIdentity.frame(minWidth: 200, maxWidth: .infinity, alignment: .leading)
                    triggerSummary.frame(width: 210, alignment: .leading)
                    statusBadge
                    listActions
                }
                VStack(alignment: .leading, spacing: 12) {
                    listIdentity
                    triggerSummary
                    HStack { statusBadge; Spacer(); listActions }
                }
            }
            if isShowingDetails { Divider(); details }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Divider() }
        .controlSize(.small)
    }

    private var listIdentity: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(automation.name).font(WorkbenchTypography.font(for: .cardTitle))
                .lineLimit(2).help(automation.name)
            Button(action: openTarget) {
                Label(targetName, systemImage: "bubble.left.and.bubble.right").lineLimit(1)
            }.buttonStyle(.link).font(WorkbenchTypography.font(for: .help))
        }
    }

    private var triggerSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(triggerLabel, systemImage: "bolt.badge.clock")
            if automation.scheduleType.hasPredictableNextRun, let next = optionalDateLabel(automation.nextRunAt) {
                Text("\(L10n("下次执行"))：\(next)")
            } else if let last = optionalDateLabel(automation.lastRunAt) {
                Text("\(L10n("最近执行"))：\(last)")
            }
        }.font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
    }

    private var listActions: some View {
        HStack {
            Button(L10n("详情")) { isShowingDetails.toggle() }
            Menu {
                Button(L10n("Edit"), action: edit)
                    .disabled(!automation.status.permitsEditing || ![ScheduledSessionScheduleType.once, .interval].contains(automation.scheduleType))
                if automation.status.permitsResume { Button(L10n("Retry")) { perform(.retry) } }
                Button(L10n("Run Now")) { perform(.runNow) }.disabled(!automation.status.permitsRunNow)
                Button(L10n("Cancel"), role: .destructive) { perform(.cancel) }.disabled(!automation.status.permitsCancel)
            } label: { Image(systemName: "ellipsis").frame(width: 28, height: 24) }
            .accessibilityLabel(L10n("更多"))
            if isMutating { ProgressView().controlSize(.small) }
        }.disabled(isMutating || automation.operationsDisabledReason != nil)
            .help(automation.operationsDisabledReason ?? "")
    }

    @ViewBuilder
    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 2), spacing: 8) {
                metric(L10n("创建时间"), dateLabel(automation.createdAt), "calendar.badge.plus")
                metric(L10n("上次执行时间"), dateLabel(automation.lastRunAt), "clock.arrow.circlepath")
                if automation.scheduleType.hasPredictableNextRun {
                    metric(L10n("预计下次执行时间"), dateLabel(automation.nextRunAt), "calendar")
                }
                metric(L10n("过期时间"), dateLabel(automation.expiresAt), "calendar.badge.exclamationmark")
            }

            Label(
                L10nFormat(
                    "Times use system time zone: %@",
                    ScheduledSessionManagementTimeFormatting.timeZoneLabel()
                ),
                systemImage: "globe"
            )
            .font(WorkbenchTypography.font(for: .metadata))
            .foregroundStyle(.secondary)

            HStack(spacing: 12) {
                metric(L10n("Last Result"), automation.lastRunStatus.map { AutomationPresentation.status($0.rawValue) } ?? L10n("Not run"), "checklist")
                metric(L10n("Risk"), automation.risk?.level ?? "minimal", "shield")
            }

            Text(automation.risk?.summary ?? L10n("Local-only actions; remote writes and destructive operations are disabled."))
                .font(WorkbenchTypography.font(for: .metadata))
                .foregroundStyle(.secondary)

            if !automation.actions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(automation.actions.enumerated()), id: \.offset) { _, action in
                        Text(action.type)
                            .font(WorkbenchTypography.font(for: .technical))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.accentColor.opacity(0.1), in: Capsule())
                    }
                }
            }

            if !automation.runs.isEmpty {
                DisclosureGroup(L10nFormat("Run History (%lld)", automation.runs.count)) {
                    VStack(spacing: 8) {
                        ForEach(automation.runs) { run in AutomationRunRow(run: run) }
                    }
                    .padding(.top, 8)
                }
                .font(WorkbenchTypography.font(for: .help).weight(.semibold))
            }

            Text("misfire: \(automation.policy?.misfire ?? automation.missedPolicy.rawValue)")
                .font(WorkbenchTypography.font(for: .technical))
                .foregroundStyle(.secondary)
        }
    }

    private var statusBadge: some View {
        Text(automation.presentationStatusText)
            .font(WorkbenchTypography.font(for: .help).weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(automation.statusTint.opacity(0.13), in: Capsule())
            .foregroundStyle(automation.statusTint)
    }

    private var triggerLabel: String {
        guard let trigger = automation.trigger else { return AutomationPresentation.trigger(automation.scheduleType.rawValue) }
        if trigger.type == "interval", let seconds = trigger.intervalSeconds { return L10nFormat("Every %lld seconds", seconds) }
        if trigger.type == "after", let seconds = trigger.delaySeconds { return L10nFormat("After %lld seconds", seconds) }
        return AutomationPresentation.trigger(trigger.type)
    }

    private func metric(_ label: String, _ value: String, _ image: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(label, systemImage: image).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
            Text(value).font(WorkbenchTypography.font(for: .body)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func dateLabel(_ value: String?) -> String {
        optionalDateLabel(value) ?? L10n("None")
    }

    private func optionalDateLabel(_ value: String?) -> String? {
        ScheduledSessionManagementTimeFormatting.string(
            from: value,
            locale: AppLanguageController.shared.locale
        )
    }

    private func compactActionButton(
        _ title: String,
        systemImage: String,
        role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            Image(systemName: systemImage)
                .frame(width: 28, height: 28)
        }
        .buttonStyle(.borderless)
        .help(title)
        .accessibilityLabel(title)
    }
}

private struct AutomationRunRow: View {
    let run: ScheduledSessionRun

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(AutomationPresentation.status(run.status.rawValue)).font(WorkbenchTypography.font(for: .body).weight(.semibold))
                Spacer()
                Text(ScheduledSessionManagementTimeFormatting.string(from: run.scheduledFor, locale: AppLanguageController.shared.locale) ?? run.scheduledFor).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
            }
            if let bindingId = run.bindingId {
                Text("binding \(bindingId) · routing v\(run.routingVersion ?? 0)")
                    .font(WorkbenchTypography.font(for: .technical)).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ForEach(Array((run.stages ?? []).enumerated()), id: \.offset) { _, stage in
                HStack(spacing: 6) {
                    Image(systemName: stage.status == "completed" ? "checkmark.circle.fill" : "circle.dashed")
                    Text(stage.name)
                    Spacer()
                    Text(AutomationPresentation.status(stage.status))
                }
                .font(WorkbenchTypography.font(for: .metadata))
                .foregroundStyle(stage.status == "completed" ? Color.green : Color.secondary)
            }
            if let error = run.errorMessage {
                Text([run.errorCode, error].compactMap { $0 }.joined(separator: " · "))
                    .font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .padding(8)
        .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 8))
    }
}

private extension ScheduledSessionTask {
    @MainActor var presentationStatusText: String {
        switch status {
        case .active: L10n("生效中")
        case .cancelled: L10n("已取消")
        case .completed: L10n("已完成")
        case .expired: L10n("已过期")
        case .error: L10n("异常")
        default: L10n("异常")
        }
    }

    var statusTint: Color {
        switch status {
        case .active: .blue
        case .cancelled: .secondary
        case .completed: .green
        case .expired: .orange
        case .error: .red
        default: .red
        }
    }
}

@MainActor
enum AutomationPresentation {
    static func status(_ value: String) -> String {
        switch value {
        case "claimed": L10n("Claimed")
        case "queued": L10n("Queued")
        case "running": L10n("Running")
        case "completed": L10n("Completed")
        case "failed": L10n("Failed")
        case "cancelled": L10n("Cancelled")
        case "skipped": L10n("Skipped")
        case "missed": L10n("Missed")
        case "retry_wait": L10n("Waiting to retry")
        default: value
        }
    }

    static func trigger(_ value: String) -> String {
        switch value {
        case "at", "once": L10n("One time")
        case "after": L10n("After a delay")
        case "interval": L10n("Interval")
        case "process", "processExit": L10n("Process exit")
        case "condition": L10n("Condition")
        default: value
        }
    }
}
