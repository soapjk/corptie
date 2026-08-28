import SwiftUI

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
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    @State private var category: AutomationCategory? = .all
    @State private var editingAutomation: ScheduledSessionTask?
    @State private var focusedAutomationID: String?

    private var visibleAutomations: [ScheduledSessionTask] {
        switch category ?? .all {
        case .all: backendClient.automations
        case .running: backendClient.automations.filter {
            $0.lastRunStatus == .claimed || $0.lastRunStatus == .queued || $0.lastRunStatus == .running
        }
        case .failed: backendClient.automations.filter { $0.status == .error || $0.lastRunStatus == .failed }
        case .history: backendClient.automations.filter { !$0.runs.isEmpty }
        }
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $sidebarState.visibility) {
            List(AutomationCategory.allCases, selection: $category) { item in
                Label(item.title, systemImage: item.symbol)
                    .tag(Optional(item))
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 280)
        } detail: {
            VStack(spacing: 0) {
                header
                Divider()
                content
            }
        }
        .task { await backendClient.loadAutomations() }
        .sheet(item: $editingAutomation) { automation in
            if let session = targetSession(for: automation) {
                ScheduledTaskEditorSheet(
                    session: session,
                    existingTask: automation,
                    onSaved: { Task { await backendClient.loadAutomations() } }
                )
                .environmentObject(backendClient)
            }
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(category?.title ?? L10n("Automations"))
                    .font(.title2.weight(.semibold))
                Text(L10n("Event-driven tasks route through each Logical Session’s current Provider binding."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if backendClient.isLoadingAutomations { ProgressView().controlSize(.small) }
            Button {
                Task { await backendClient.loadAutomations() }
            } label: {
                Label(L10n("Refresh"), systemImage: "arrow.clockwise")
            }
        }
        .padding(18)
    }

    @ViewBuilder
    private var content: some View {
        if backendClient.isLoadingAutomations && backendClient.automations.isEmpty {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if visibleAutomations.isEmpty {
            ContentUnavailableView(
                L10n("No Automations"),
                systemImage: "bolt.badge.clock",
                description: Text(L10n("Create an Automation from a Session’s message composer."))
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(visibleAutomations) { automation in
                            AutomationCard(
                                automation: automation,
                                targetName: targetName(for: automation),
                                isMutating: backendClient.scheduledTaskMutationIds.contains(automation.id),
                                openTarget: { openTarget(automation) },
                                edit: { edit(automation) },
                                perform: { action in
                                    Task { await backendClient.performAutomationAction(action, task: automation) }
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
                    .padding(18)
                }
                .onChange(of: router.pendingAutomationId, initial: true) { _, automationID in
                    guard let automationID,
                          backendClient.automations.contains(where: { $0.id == automationID }) else { return }
                    category = .all
                    focusedAutomationID = automationID
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(automationID, anchor: .center) }
                    router.consumeAutomation(automationID)
                }
                .onChange(of: backendClient.automations.map(\.id)) { _, automationIDs in
                    guard let automationID = router.pendingAutomationId,
                          automationIDs.contains(automationID) else { return }
                    category = .all
                    focusedAutomationID = automationID
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(automationID, anchor: .center) }
                    router.consumeAutomation(automationID)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if let error = backendClient.automationsError {
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
        router.openSession(session.id)
    }
}

private struct AutomationCard: View {
    let automation: ScheduledSessionTask
    let targetName: String
    let isMutating: Bool
    let openTarget: () -> Void
    let edit: () -> Void
    let perform: (ScheduledSessionTaskAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(automation.name).font(.headline)
                    Button(action: openTarget) {
                        Label(targetName, systemImage: "bubble.left.and.bubble.right")
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                }
                Spacer()
                statusBadge
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 4), spacing: 12) {
                metric(L10n("创建时间"), dateLabel(automation.createdAt), "calendar.badge.plus")
                metric(L10n("上次执行时间"), dateLabel(automation.lastRunAt), "clock.arrow.circlepath")
                if automation.scheduleType != .condition {
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
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)

            Text(automation.message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .textSelection(.enabled)

            HStack(spacing: 18) {
                metric(L10n("Trigger"), triggerLabel, "bolt.badge.clock")
                metric(L10n("Last Result"), automation.lastRunStatus?.rawValue ?? L10n("Not run"), "checklist")
                metric(L10n("Risk"), automation.risk?.level ?? "minimal", "shield")
            }

            Text(automation.risk?.summary ?? L10n("Local-only actions; remote writes and destructive operations are disabled."))
                .font(.caption2)
                .foregroundStyle(.secondary)

            if !automation.actions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(automation.actions.enumerated()), id: \.offset) { _, action in
                        Text(action.type)
                            .font(.caption2.monospaced())
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.accentColor.opacity(0.1), in: Capsule())
                    }
                }
            }

            if !automation.runs.isEmpty {
                DisclosureGroup(L10n("Run History (\(automation.runs.count))")) {
                    VStack(spacing: 8) {
                        ForEach(automation.runs) { run in AutomationRunRow(run: run) }
                    }
                    .padding(.top, 8)
                }
                .font(.caption.weight(.semibold))
            }

            HStack {
                Button(L10n("Edit"), action: edit)
                    .disabled(!automation.status.permitsEditing
                        || ![ScheduledSessionScheduleType.once, .interval].contains(automation.scheduleType))
                if automation.status.permitsResume {
                    Button(L10n("Retry")) { perform(.retry) }
                }
                Button(L10n("Run Now")) { perform(.runNow) }
                    .disabled(!automation.status.permitsRunNow)
                Button(L10n("Cancel"), role: .destructive) { perform(.cancel) }
                    .disabled(!automation.status.permitsCancel)
                Spacer()
                if isMutating { ProgressView().controlSize(.mini) }
                Text("misfire: \(automation.policy?.misfire ?? automation.missedPolicy.rawValue)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
            .disabled(isMutating || automation.operationsDisabledReason != nil)
        }
        .padding(15)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(nsColor: .separatorColor).opacity(0.55)))
    }

    private var statusBadge: some View {
        Text(automation.presentationStatusText)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(automation.statusTint.opacity(0.13), in: Capsule())
            .foregroundStyle(automation.statusTint)
    }

    private var triggerLabel: String {
        guard let trigger = automation.trigger else { return automation.scheduleType.rawValue }
        if trigger.type == "interval", let seconds = trigger.intervalSeconds { return "interval · \(seconds)s" }
        if trigger.type == "after", let seconds = trigger.delaySeconds { return "after · \(seconds)s" }
        return trigger.type
    }

    private func metric(_ label: String, _ value: String, _ image: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(label, systemImage: image).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.caption.weight(.medium)).lineLimit(1).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func dateLabel(_ value: String?) -> String {
        ScheduledSessionManagementTimeFormatting.string(
            from: value,
            locale: AppLanguageController.shared.locale
        ) ?? L10n("None")
    }
}

private struct AutomationRunRow: View {
    let run: ScheduledSessionRun

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(run.status.rawValue).font(.caption.monospaced().weight(.semibold))
                Spacer()
                Text(run.scheduledFor).font(.caption2).foregroundStyle(.secondary)
            }
            if let bindingId = run.bindingId {
                Text("binding \(bindingId) · routing v\(run.routingVersion ?? 0)")
                    .font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ForEach(Array((run.stages ?? []).enumerated()), id: \.offset) { _, stage in
                HStack(spacing: 6) {
                    Image(systemName: stage.status == "completed" ? "checkmark.circle.fill" : "circle.dashed")
                    Text(stage.name)
                    Spacer()
                    Text(stage.status)
                }
                .font(.caption2)
                .foregroundStyle(stage.status == "completed" ? Color.green : Color.secondary)
            }
            if let error = run.errorMessage {
                Text([run.errorCode, error].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .padding(9)
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
