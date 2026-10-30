import SwiftUI
import CorptieConversation

private enum AutomationCategory: String, CaseIterable, Identifiable {
    case all
    case running
    case failed
    case history

    var id: String { rawValue }
    @MainActor var title: String {
        switch self {
        case .all: L10n("All Automations")
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

struct AutomationsView: View {
    @EnvironmentObject private var router: AppTabRouter
    @EnvironmentObject private var sidebarState: TabSidebarState
    @StateObject private var backendClient = BackendClient.shared
    @ObservedObject private var scheduling = BackendClient.shared.scheduledTaskController
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    @State private var category: AutomationCategory? = .all
    @State private var editingAutomation: ScheduledSessionTask?
    @State private var focusedAutomationID: String?

    private var visibleAutomations: [ScheduledSessionTask] {
        switch category ?? .all {
        case .all: scheduling.automations
        case .running: scheduling.automations.filter {
            $0.lastRunStatus == .claimed || $0.lastRunStatus == .queued || $0.lastRunStatus == .running
        }
        case .failed: scheduling.automations.filter { $0.status == .error || $0.lastRunStatus == .failed }
        case .history: scheduling.automations.filter { !$0.runs.isEmpty }
        }
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $sidebarState.visibility) {
            List(AutomationCategory.allCases, selection: $category) { item in
                ManagementCategoryRow(title: item.title, systemImage: item.symbol,
                                      isSelected: category == item)
                    .padding(.vertical, 2)
                    .tag(Optional(item))
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 36)
            .padding(16)
            .navigationSplitViewColumnWidth(min: SettingsPageLayout.sidebarMinimum,
                                            ideal: SettingsPageLayout.sidebarIdeal,
                                            max: SettingsPageLayout.sidebarMaximum)
            .mainWindowPageCard()
            .padding(.trailing, MainWindowPageLayoutMetrics.halfColumnSpacing)
        } detail: {
            VStack(spacing: 0) {
                header
                Divider()
                content
            }
            .mainWindowPageCard()
            .padding(.leading, MainWindowPageLayoutMetrics.halfColumnSpacing)
        }
        .padding(MainWindowPageLayoutMetrics.outerPadding)
        .task { await scheduling.loadAutomations() }
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
            if scheduling.isLoadingAutomations { ProgressView().controlSize(.small) }
            Button {
                Task { await scheduling.loadAutomations() }
            } label: {
                Label(L10n("Refresh"), systemImage: "arrow.clockwise")
            }
        }
        .padding(20)
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
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 300, maximum: 430), spacing: 12, alignment: .top)],
                        alignment: .leading,
                        spacing: 12
                    ) {
                        ForEach(visibleAutomations) { automation in
                            AutomationCard(
                                automation: automation,
                                targetName: targetName(for: automation),
                                isMutating: commandState.scheduledTaskMutationIds.contains(automation.id),
                                openTarget: { openTarget(automation) },
                                edit: { edit(automation) },
                                perform: { action in
                                    Task { await scheduling.performAutomationAction(action, task: automation) }
                                }
                            )
                            .id(automation.id)
                            .overlay {
                                if focusedAutomationID == automation.id {
                                    RoundedRectangle(cornerRadius: 14).stroke(.tint, lineWidth: 2)
                                }
                            }
                        }
                    }
                    .padding(20)
                }
                .onChange(of: router.pendingAutomationId, initial: true) { _, automationID in
                    guard let automationID,
                          scheduling.automations.contains(where: { $0.id == automationID }) else { return }
                    category = .all
                    focusedAutomationID = automationID
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(automationID, anchor: .center) }
                    router.consumeAutomation(automationID)
                }
                .onChange(of: scheduling.automations.map(\.id)) { _, automationIDs in
                    guard let automationID = router.pendingAutomationId,
                          automationIDs.contains(automationID) else { return }
                    category = .all
                    focusedAutomationID = automationID
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(automationID, anchor: .center) }
                    router.consumeAutomation(automationID)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if let error = scheduling.automationsError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(12)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                        .padding()
                }
            }
        }
    }

    private func targetName(for automation: ScheduledSessionTask) -> String {
        targetSession(for: automation)?.title ?? automation.logicalSessionId
    }

    private func targetSession(for automation: ScheduledSessionTask) -> TaskSession? {
        backendClient.sessions.first {
            ($0.external?.logicalSessionId ?? $0.id) == automation.logicalSessionId
        }
    }

    private func edit(_ automation: ScheduledSessionTask) {
        guard targetSession(for: automation) != nil else {
            router.navigationError = L10n("The target Logical Session is unavailable.")
            return
        }
        editingAutomation = automation
    }

    private func openTarget(_ automation: ScheduledSessionTask) {
        guard let session = backendClient.sessions.first(where: {
            ($0.external?.logicalSessionId ?? $0.id) == automation.logicalSessionId
        }) else {
            router.navigationError = L10n("The target Logical Session is unavailable.")
            return
        }
        router.openSession(session.id, source: .userSelection)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Text(automation.name)
                    .font(WorkbenchTypography.font(for: .cardTitle))
                    .lineLimit(1)
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
