import AppKit
import SwiftUI

enum ScheduledSessionAccessibilityID {
    static let composerSymbol = "calendar.badge.clock"
    static let composerEntry = "scheduled-session.composer.entry"
    static let detailSection = "scheduled-session.detail.section"
    static let editorTitle = "scheduled-session.editor.title"
    static let editorMessage = "scheduled-session.editor.message"
    static let editorScheduleType = "scheduled-session.editor.schedule-type"
    static let editorRunAt = "scheduled-session.editor.run-at"
    static let editorInterval = "scheduled-session.editor.interval"
    static let editorTimezone = "scheduled-session.editor.timezone"
    static let editorExpiresAt = "scheduled-session.editor.expires-at"
    static let editorMissedPolicy = "scheduled-session.editor.missed-policy"
    static let editorSummary = "scheduled-session.editor.summary"
    static let editorSave = "scheduled-session.editor.save"
}

struct ScheduledSessionStrip: View {
    @EnvironmentObject private var backendClient: BackendClient
    let session: TaskSession
    @State private var isExpanded = false

    private var activeTasks: [ScheduledSessionTask] {
        backendClient.selectedScheduledTasks.filter { $0.status == .active }
    }

    private var visibleTasks: [ScheduledSessionTask] {
        let tasks = activeTasks
        return isExpanded ? tasks : Array(tasks.prefix(2))
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
        } else if !activeTasks.isEmpty || backendClient.scheduledTaskError != nil {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label(L10n("定时任务"), systemImage: "clock.badge")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    if activeTasks.count > 2 {
                        Button {
                            withAnimation(.easeInOut(duration: 0.16)) { isExpanded.toggle() }
                        } label: {
                            Label(
                                isExpanded
                                    ? L10n("Collapse")
                                    : L10nFormat(
                                        "Show %lld more",
                                        Int64(activeTasks.count - 2)
                                    ),
                                systemImage: isExpanded ? "chevron.up" : "chevron.down"
                            )
                        }
                        .accessibilityIdentifier("scheduled-session.detail.expand")
                        .buttonStyle(.plain)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                    }
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

                Label(
                    ScheduledSessionManagementTimeFormatting.timeZoneLabel(),
                    systemImage: "globe"
                )
                .font(.system(size: 8))
                .foregroundStyle(.tertiary)
            }
            .padding(8)
            .background(Color.accentColor.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
            .onChange(of: session.id) { _, _ in isExpanded = false }
            .accessibilityIdentifier(ScheduledSessionAccessibilityID.detailSection)
        }
    }
}

private struct ScheduledSessionCompactCard: View {
    let task: ScheduledSessionTask

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: task.presentationStatus.symbolName)
                    .foregroundStyle(task.presentationStatus.color)
                    .frame(width: 16)
                Text(task.name)
                    .font(.system(size: 10, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(task.presentationStatus.label)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(task.presentationStatus.color)
            }

            Label(task.typeLabel, systemImage: "bolt.badge.clock")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.secondary)

            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 2),
                alignment: .leading,
                spacing: 6
            ) {
                timestamp(L10n("创建时间"), task.createdAt)
                timestamp(L10n("上次执行时间"), task.lastRunAt)
                timestamp(L10n("预计下次执行时间"), task.nextRunAt)
                timestamp(L10n("过期时间"), task.expiresAt)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(task.presentationStatus.label)，\(task.name)，\(task.typeLabel)")
    }

    private func timestamp(_ label: String, _ value: String?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 8)).foregroundStyle(.tertiary)
            Text(ScheduledSessionManagementTimeFormatting.string(
                from: value,
                locale: AppLanguageController.shared.locale
            ) ?? L10n("None"))
                .font(.system(size: 9, weight: .medium))
                .lineLimit(1)
        }
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
                Text(L10n("计划任务标题"))
                    .font(.system(size: 11, weight: .semibold))
                TextField(L10n("例如：检查构建结果"), text: $draft.title)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorTitle)
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

            DatePicker(
                L10n("过期时间"),
                selection: $draft.expiresAt,
                displayedComponents: [.date, .hourAndMinute]
            )
            .environment(\.timeZone, TimeZone(identifier: draft.timezone) ?? .current)
            .accessibilityIdentifier(ScheduledSessionAccessibilityID.editorExpiresAt)

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

extension ScheduledSessionTaskDraft {
    init(task: ScheduledSessionTask) {
        self.init(
            title: task.name,
            message: task.message,
            scheduleType: task.scheduleType,
            runAt: ScheduledSessionDateFormatting.date(from: task.runAt ?? task.nextRunAt)
                ?? Date().addingTimeInterval(300),
            intervalSeconds: task.intervalSeconds ?? 3600,
            timezone: task.timezone,
            missedPolicy: task.missedPolicy,
            expiresAt: ScheduledSessionDateFormatting.date(from: task.expiresAt) ?? .distantFuture
        )
    }

    @MainActor
    var summaryText: String {
        let policy = missedPolicy == .coalesceOnce ? L10n("错过后补执行一次") : L10n("错过后跳过")
        switch scheduleType {
        case .once:
            return L10n("下一次：\(Self.display(runAt, timezone: timezone)) · 过期：\(Self.display(expiresAt, timezone: timezone)) · 一次性 · \(policy)")
        case .interval:
            let estimatedNext = Date().addingTimeInterval(TimeInterval(max(0, intervalSeconds)))
            return L10n("下一次（预计）：\(Self.display(estimatedNext, timezone: timezone)) · 过期：\(Self.display(expiresAt, timezone: timezone)) · 每 \(Self.intervalText(intervalSeconds)) · \(policy)")
        case .condition:
            return L10n("条件轮询 · \(policy)")
        case .process:
            return L10n("进程退出 · \(policy)")
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
    var typeLabel: String {
        switch scheduleType {
        case .once: L10n("一次性定时任务")
        case .interval: L10n("周期定时任务")
        case .condition: L10n("条件任务")
        case .process: L10n("进程退出任务")
        }
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
        case .expired: L10n("已过期")
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
        case .expired: "clock.badge.exclamationmark"
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
        case .expired: .orange
        case .cancelled, .missed, .unknown: .secondary
        }
    }
}
