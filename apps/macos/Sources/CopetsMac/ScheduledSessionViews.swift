import AppKit
import SwiftUI

enum ScheduledSessionAccessibilityID {
    static let composerSymbol = "calendar.badge.clock"
    static let composerEntry = "scheduled-session.composer.entry"
    static let editorMessage = "scheduled-session.editor.message"
    static let editorScheduleType = "scheduled-session.editor.schedule-type"
    static let editorRunAt = "scheduled-session.editor.run-at"
    static let editorInterval = "scheduled-session.editor.interval"
    static let editorTimezone = "scheduled-session.editor.timezone"
    static let editorMissedPolicy = "scheduled-session.editor.missed-policy"
    static let editorSummary = "scheduled-session.editor.summary"
    static let editorSave = "scheduled-session.editor.save"
    static let cardEdit = "scheduled-session.card.edit"
    static let cardPauseResume = "scheduled-session.card.pause-resume"
    static let cardRunNow = "scheduled-session.card.run-now"
    static let cardCancel = "scheduled-session.card.cancel"
}

struct ScheduledSessionStrip: View {
    @EnvironmentObject private var backendClient: BackendClient
    let session: TaskSession
    @State private var isShowingManager = false

    private var visibleTasks: [ScheduledSessionTask] {
        backendClient.selectedScheduledTasks.filter { $0.status != .cancelled }.prefix(2).map { $0 }
    }

    var body: some View {
        if backendClient.isLoadingScheduledTasks && backendClient.selectedScheduledTasks.isEmpty {
            HStack(spacing: 7) {
                ProgressView().controlSize(.mini)
                Text(L10n("正在加载定时任务…"))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if !backendClient.selectedScheduledTasks.isEmpty || backendClient.scheduledTaskError != nil {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label(L10n("定时任务"), systemImage: "clock.badge")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(L10n("管理 \(backendClient.selectedScheduledTasks.count)")) {
                        isShowingManager = true
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                }

                ForEach(visibleTasks) { task in
                    ScheduledSessionCompactCard(task: task)
                }

                if let error = backendClient.scheduledTaskError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
            }
            .padding(8)
            .background(Color.accentColor.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
            .sheet(isPresented: $isShowingManager) {
                ScheduledSessionManagerView(session: session)
                    .environmentObject(backendClient)
            }
        }
    }
}

private struct ScheduledSessionCompactCard: View {
    let task: ScheduledSessionTask

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: task.presentationStatus.symbolName)
                .foregroundStyle(task.presentationStatus.color)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.message)
                    .font(.system(size: 10, weight: .medium))
                    .lineLimit(1)
                Text(task.compactScheduleText)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Text(task.presentationStatus.label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(task.presentationStatus.color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(task.presentationStatus.label)，\(task.message)，\(task.compactScheduleText)")
    }
}

struct ScheduledTaskEditorSheet: View {
    @EnvironmentObject private var backendClient: BackendClient
    @Environment(\.dismiss) private var dismiss
    let session: TaskSession
    let existingTask: ScheduledSessionTask?
    let initialMessage: String
    let onSaved: () -> Void
    @State private var draft: ScheduledSessionTaskDraft
    @State private var isSaving = false

    init(
        session: TaskSession,
        existingTask: ScheduledSessionTask? = nil,
        initialMessage: String = "",
        onSaved: @escaping () -> Void = {}
    ) {
        self.session = session
        self.existingTask = existingTask
        self.initialMessage = initialMessage
        self.onSaved = onSaved
        _draft = State(initialValue: existingTask.map(ScheduledSessionTaskDraft.init(task:))
            ?? .fresh(message: initialMessage))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label(
                    existingTask == nil ? L10n("创建定时消息") : L10n("编辑定时消息"),
                    systemImage: "clock.badge"
                )
                .font(.system(size: 15, weight: .semibold))
                Spacer()
                Text(session.title)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(L10n("执行消息"))
                    .font(.system(size: 11, weight: .semibold))
                TextEditor(text: $draft.message)
                    .font(.system(size: 12))
                    .scrollContentBackground(.hidden)
                    .padding(7)
                    .frame(minHeight: 88)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor)))
                    .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorMessage)
            }

            Picker(L10n("计划类型"), selection: $draft.scheduleType) {
                Text(L10n("一次性")).tag(ScheduledSessionScheduleType.once)
                Text(L10n("固定间隔")).tag(ScheduledSessionScheduleType.interval)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorScheduleType)

            if draft.scheduleType == .once {
                DatePicker(
                    L10n("执行时间"),
                    selection: $draft.runAt,
                    displayedComponents: [.date, .hourAndMinute]
                )
                .environment(\.timeZone, TimeZone(identifier: draft.timezone) ?? .current)
                .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorRunAt)
            } else {
                HStack {
                    Text(L10n("间隔秒数"))
                    Spacer()
                    TextField("3600", value: $draft.intervalSeconds, format: .number)
                        .frame(width: 110)
                        .multilineTextAlignment(.trailing)
                        .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorInterval)
                }
            }

            Picker(L10n("时区"), selection: $draft.timezone) {
                ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { identifier in
                    Text(identifier).tag(identifier)
                }
            }
            .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorTimezone)

            Picker(L10n("错过时间策略"), selection: $draft.missedPolicy) {
                Text(L10n("恢复后补执行一次")).tag(ScheduledSessionMissedPolicy.coalesceOnce)
                Text(L10n("跳过错过的运行")).tag(ScheduledSessionMissedPolicy.skip)
            }
            .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorMissedPolicy)

            VStack(alignment: .leading, spacing: 5) {
                Label(L10n("计划摘要"), systemImage: "calendar.badge.clock")
                    .font(.system(size: 11, weight: .semibold))
                Text(draft.summaryText)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(L10n("保存后由后端持久化并校验；关闭 App 不会丢失计划。"))
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 9))
            .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorSummary)

            if let validationError = draft.validationError() {
                Label(validationError.localizedDescription, systemImage: "exclamationmark.circle.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.red)
            } else if let error = backendClient.scheduledTaskError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button(L10n("取消"), role: .cancel) { dismiss() }
                Button(existingTask == nil ? L10n("创建计划") : L10n("保存更改")) {
                    save()
                }
                .buttonStyle(.borderedProminent)
                .disabled(draft.validationError() != nil || isSaving)
                .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorSave)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func save() {
        guard draft.validationError() == nil, !isSaving else { return }
        isSaving = true
        Task {
            let succeeded: Bool
            if let existingTask {
                succeeded = await backendClient.updateScheduledTask(existingTask, draft: draft, for: session)
            } else {
                succeeded = await backendClient.createScheduledTask(draft, for: session)
            }
            isSaving = false
            if succeeded {
                onSaved()
                dismiss()
            }
        }
    }
}

struct ScheduledSessionManagerView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @Environment(\.dismiss) private var dismiss
    let session: TaskSession
    @State private var editingTask: ScheduledSessionTask?
    @State private var confirmation: ScheduledTaskConfirmation?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(L10n("定时任务"), systemImage: "clock.badge")
                    .font(.system(size: 15, weight: .semibold))
                Spacer()
                Button { Task { await backendClient.loadScheduledTasks(for: session) } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help(L10n("从后端刷新"))
                Button(L10n("完成")) { dismiss() }
            }
            .padding(16)

            Divider()

            if backendClient.isLoadingScheduledTasks && backendClient.selectedScheduledTasks.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if backendClient.selectedScheduledTasks.isEmpty {
                ContentUnavailableView(
                    L10n("没有定时任务"),
                    systemImage: "clock",
                    description: Text(L10n("可从消息输入区域创建一次性或固定间隔计划。"))
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(backendClient.selectedScheduledTasks) { task in
                            ScheduledSessionTaskCard(
                                task: task,
                                isMutating: backendClient.scheduledTaskMutationIds.contains(task.id),
                                onEdit: { editingTask = task },
                                onAction: requestAction,
                                onLocateTurn: locateTurn
                            )
                        }
                    }
                    .padding(16)
                }
            }

            if let error = backendClient.scheduledTaskError {
                Divider()
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.red)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 680, height: 620)
        .task(id: session.id) { await backendClient.loadScheduledTasks(for: session) }
        .sheet(item: $editingTask) { task in
            ScheduledTaskEditorSheet(session: session, existingTask: task)
                .environmentObject(backendClient)
        }
        .alert(item: $confirmation) { confirmation in
            Alert(
                title: Text(confirmation.title),
                message: Text(confirmation.message),
                primaryButton: .destructive(Text(confirmation.confirmLabel)) {
                    Task {
                        await backendClient.performScheduledTaskAction(
                            confirmation.action,
                            task: confirmation.task,
                            for: session
                        )
                    }
                },
                secondaryButton: .cancel()
            )
        }
    }

    private func requestAction(_ action: ScheduledSessionTaskAction, task: ScheduledSessionTask) {
        if action == .cancel || action == .runNow {
            confirmation = ScheduledTaskConfirmation(action: action, task: task)
        } else {
            Task { await backendClient.performScheduledTaskAction(action, task: task, for: session) }
        }
    }

    private func locateTurn(_ turnID: String) {
        dismiss()
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .scrollSessionTimelineToTurn,
                object: nil,
                userInfo: ["sessionId": session.id, "turnId": turnID]
            )
        }
    }
}

struct ScheduledSessionTaskCard: View {
    let task: ScheduledSessionTask
    let isMutating: Bool
    let onEdit: () -> Void
    let onAction: (ScheduledSessionTaskAction, ScheduledSessionTask) -> Void
    let onLocateTurn: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.message)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(3)
                        .textSelection(.enabled)
                    Text(task.compactScheduleText)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                Label(task.presentationStatus.label, systemImage: task.presentationStatus.symbolName)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(task.presentationStatus.color)
            }

            if let error = task.lastErrorMessage {
                Label([task.lastErrorCode, error].compactMap { $0 }.joined(separator: " · "), systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }

            if let disabledReason = task.operationsDisabledReason {
                Label(L10n("该计划当前不可操作：\(disabledReason)"), systemImage: "lock.trianglebadge.exclamationmark")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
            }

            if !task.runs.isEmpty {
                DisclosureGroup(L10n("运行历史（\(task.runs.count)）")) {
                    VStack(spacing: 7) {
                        ForEach(task.runs) { run in
                            ScheduledSessionRunRow(run: run, onLocateTurn: onLocateTurn)
                        }
                    }
                    .padding(.top, 7)
                }
                .font(.system(size: 10, weight: .semibold))
            }

            HStack(spacing: 10) {
                Button(L10n("编辑"), action: onEdit)
                    .disabled(!task.status.permitsEditing || isMutating || task.operationsDisabledReason != nil)
                    .accessibilityIdentifier(ScheduledSessionAccessibilityID.cardEdit)
                if task.status.permitsPause {
                    Button(L10n("暂停")) { onAction(.pause, task) }
                        .disabled(task.operationsDisabledReason != nil)
                        .accessibilityIdentifier(ScheduledSessionAccessibilityID.cardPauseResume)
                } else if task.status.permitsResume {
                    Button(task.status == .failed ? L10n("重试") : L10n("恢复")) {
                        onAction(task.status == .failed ? .retry : .resume, task)
                    }
                    .disabled(task.operationsDisabledReason != nil)
                    .accessibilityIdentifier(ScheduledSessionAccessibilityID.cardPauseResume)
                }
                Button(L10n("立即执行")) { onAction(.runNow, task) }
                    .disabled(!task.status.permitsRunNow || isMutating || task.operationsDisabledReason != nil)
                    .accessibilityIdentifier(ScheduledSessionAccessibilityID.cardRunNow)
                Spacer()
                Button(L10n("取消计划"), role: .destructive) { onAction(.cancel, task) }
                    .disabled(!task.status.permitsCancel || isMutating || task.operationsDisabledReason != nil)
                    .accessibilityIdentifier(ScheduledSessionAccessibilityID.cardCancel)
                if isMutating { ProgressView().controlSize(.mini) }
            }
            .font(.system(size: 10))
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(nsColor: .separatorColor).opacity(0.55)))
    }
}

private struct ScheduledSessionRunRow: View {
    let run: ScheduledSessionRun
    let onLocateTurn: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: run.status.presentation.symbolName)
                .foregroundStyle(run.status.presentation.color)
                .frame(width: 15)
            VStack(alignment: .leading, spacing: 2) {
                Text(run.status.presentation.label)
                    .font(.system(size: 10, weight: .semibold))
                Text(run.actualTimeText)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                if let error = run.errorMessage {
                    Text([run.errorCode, error].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 9))
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
                if run.agentWorkItemId != nil || run.targetTurnId != nil {
                    Text([run.agentWorkItemId, run.targetTurnId].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(Color.accentColor)
                        .textSelection(.enabled)
                        .help(L10n("关联的 agentWorkItemId 与 targetTurnId"))
                    if let targetTurnId = run.targetTurnId {
                        Button(L10n("在时间线中查看")) { onLocateTurn(targetTurnId) }
                            .buttonStyle(.link)
                            .font(.system(size: 9, weight: .semibold))
                    }
                }
            }
            Spacer()
        }
        .padding(7)
        .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 7))
    }
}

private struct ScheduledTaskConfirmation: Identifiable {
    var id: String { "\(task.id):\(action.rawValue)" }
    let action: ScheduledSessionTaskAction
    let task: ScheduledSessionTask

    var title: String { action == .cancel ? "取消这个计划？" : "立即执行这个计划？" }
    var message: String {
        action == .cancel
            ? "取消后该计划不会再次触发；已产生的运行历史会保留。"
            : "后端会立即创建一次运行；如果 Session 正忙，任务将进入队列等待。"
    }
    var confirmLabel: String { action == .cancel ? "取消计划" : "立即执行" }
}

extension ScheduledSessionTaskDraft {
    init(task: ScheduledSessionTask) {
        self.init(
            message: task.message,
            scheduleType: task.scheduleType,
            runAt: ScheduledSessionDateFormatting.date(from: task.runAt ?? task.nextRunAt)
                ?? Date().addingTimeInterval(300),
            intervalSeconds: task.intervalSeconds ?? 3600,
            timezone: task.timezone,
            missedPolicy: task.missedPolicy
        )
    }

    @MainActor
    var summaryText: String {
        let policy = missedPolicy == .coalesceOnce ? L10n("错过后补执行一次") : L10n("错过后跳过")
        switch scheduleType {
        case .once:
            return L10n("下一次：\(Self.display(runAt, timezone: timezone)) · 一次性 · \(policy)")
        case .interval:
            let estimatedNext = Date().addingTimeInterval(TimeInterval(max(0, intervalSeconds)))
            return L10n("下一次（预计）：\(Self.display(estimatedNext, timezone: timezone)) · 每 \(Self.intervalText(intervalSeconds)) · \(policy)")
        }
    }

    @MainActor
    fileprivate static func intervalText(_ seconds: Int) -> String {
        if seconds % 86_400 == 0 { return L10n("\(seconds / 86_400) 天") }
        if seconds % 3_600 == 0 { return L10n("\(seconds / 3_600) 小时") }
        if seconds % 60 == 0 { return L10n("\(seconds / 60) 分钟") }
        return L10n("\(seconds) 秒")
    }

    @MainActor
    private static func display(_ date: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = AppLanguageController.shared.locale
        formatter.timeZone = TimeZone(identifier: timezone)
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return "\(formatter.string(from: date)) (\(timezone))"
    }
}

private extension ScheduledSessionTask {
    @MainActor
    var compactScheduleText: String {
        let next = ScheduledSessionDateFormatting.date(from: nextRunAt).map { date in
            let formatter = DateFormatter()
            formatter.locale = AppLanguageController.shared.locale
            formatter.timeZone = TimeZone(identifier: timezone)
            formatter.dateStyle = .short
            formatter.timeStyle = .short
            return formatter.string(from: date)
        } ?? L10n("无下次执行时间")
        let recurrence = scheduleType == .once
            ? L10n("一次性")
            : L10n("每 \(ScheduledSessionTaskDraft.intervalText(intervalSeconds ?? 0))")
        return "\(next) · \(recurrence) · \(timezone)"
    }
}

private extension ScheduledSessionRun {
    @MainActor
    var actualTimeText: String {
        let actual = completedAt ?? startedAt ?? queuedAt ?? claimedAt ?? scheduledFor
        guard let date = ScheduledSessionDateFormatting.date(from: actual) else { return actual }
        return date.formatted(.dateTime.month().day().hour().minute().second())
    }
}

private extension ScheduledSessionRunPresentation {
    @MainActor
    var label: String {
        switch self {
        case .scheduled: L10n("已计划")
        case .due: L10n("已到期")
        case .queued: L10n("排队等待")
        case .running: L10n("执行中")
        case .completed: L10n("已完成")
        case .failed: L10n("失败")
        case .paused: L10n("已暂停")
        case .cancelled: L10n("已取消")
        case .missed: L10n("已错过")
        case .unknown(let raw): L10n("未知状态：\(raw)")
        }
    }

    var symbolName: String {
        switch self {
        case .scheduled: "clock"
        case .due: "clock.badge.exclamationmark"
        case .queued: "text.line.last.and.arrowtriangle.forward"
        case .running: "bolt.circle.fill"
        case .completed: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .paused: "pause.circle.fill"
        case .cancelled: "xmark.circle.fill"
        case .missed: "calendar.badge.exclamationmark"
        case .unknown: "questionmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .scheduled: .blue
        case .due, .queued: .orange
        case .running: .indigo
        case .completed: .green
        case .failed: .red
        case .paused: .yellow
        case .cancelled, .missed, .unknown: .secondary
        }
    }
}
