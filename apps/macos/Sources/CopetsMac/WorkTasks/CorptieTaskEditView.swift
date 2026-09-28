import SwiftUI
import CorptieClientCore
import CorptieConversation

struct CorptieTaskEditView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let task: CorptieTask
    let onSaved: () -> Void

    @State private var title: String
    @State private var detail: String
    @State private var acceptanceCriteria: String
    @State private var priority: String
    @State private var status: String
    @State private var showStatusConfirm = false
    @State private var assistAgentId: String?
    @State private var saveError: String?
    @State private var updateTaskId = "task.update:\(UUID().uuidString.lowercased())"

    init(task: CorptieTask, onSaved: @escaping () -> Void) {
        self.task = task
        self.onSaved = onSaved
        _title = State(initialValue: task.title)
        _detail = State(initialValue: task.description)
        _acceptanceCriteria = State(initialValue: task.acceptanceCriteria)
        _priority = State(initialValue: task.priority)
        _status = State(initialValue: task.lifecycleState)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("编辑工作项"))
                .font(.title3.bold())

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("标题"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField(L10n("工作项标题"), text: $title)
                EntityNameValidationMessage(value: title)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(L10n("描述"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    AgentAssistButton(fieldLabel: "描述", text: $detail, selectedAgentId: $assistAgentId, context: "工作项标题：\(title)")
                    Spacer()
                }
                TextEditor(text: $detail)
                    .font(.body)
                    .frame(height: 90)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(L10n("验收标准"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    AgentAssistButton(fieldLabel: "验收标准", text: $acceptanceCriteria, selectedAgentId: $assistAgentId, context: "工作项标题：\(title)；描述：\(detail)")
                    Spacer()
                }
                TextEditor(text: $acceptanceCriteria)
                    .font(.body)
                    .frame(height: 90)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("优先级"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Picker("", selection: $priority) {
                    Text(L10n("低")).tag("low")
                    Text(L10n("中")).tag("medium")
                    Text(L10n("高")).tag("high")
                }
                .labelsHidden()
                .frame(maxWidth: 160, alignment: .leading)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("状态"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(L10n("手动修改状态将覆盖由执行流程自动维护的状态，请谨慎操作。"))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Picker("", selection: $status) {
                    Text(L10n("Preparing")).tag("todo")
                    Text(L10n("进行中")).tag("in_progress")
                    Text(L10n("已完成")).tag("done")
                }
                .labelsHidden()
                .frame(maxWidth: 160, alignment: .leading)
            }

            HStack {
                if let saveError {
                    Text(saveError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
                Spacer()
                Button(L10n("取消")) { dismiss() }
                Button(L10n("保存")) {
                    save()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!(title == task.title || EntityNamePolicy.isValid(title)))
            }
        }
        .padding(20)
        .frame(width: 440)
        .alert(L10n("确认修改状态"), isPresented: $showStatusConfirm) {
            Button(L10n(targetsCompletedStatus ? "确认完成" : "确认修改"), role: .destructive) {
                enqueuePersist()
            }
            Button(L10n("取消"), role: .cancel) { }
        } message: {
            Text(statusConfirmationMessage)
        }
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // 是否强制修改了状态（与原始状态不同）。
    private var statusChanged: Bool {
        status != task.lifecycleState
    }

    private var targetsCompletedStatus: Bool {
        CorptieTaskCompletionBackgroundDecision.resolve(status: status) == .alreadyCompleted
    }

    private var statusConfirmationMessage: String {
        guard targetsCompletedStatus else {
            return L10nFormat(
                "You are manually overriding the CorptieTask status (%@), bypassing execution-managed status. Continue?",
                statusLabel(status)
            )
        }
        let acceptanceStatus: String
        if task.completionSuggestion?.recommended == true {
            acceptanceStatus = L10n("已通过")
        } else if task.acceptanceAssessment == nil {
            acceptanceStatus = L10n("尚未验收")
        } else {
            acceptanceStatus = L10n("未通过")
        }
        return "\(task.title)\n\(task.id)\n\(L10n("自动验收"))：\(acceptanceStatus)"
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "todo": L10n("Preparing")
        case "in_progress": L10n("In Progress")
        case "review", "reviewing": L10n("Awaiting Completion Approval")
        case "done", "complete", "completed": L10n("Completed")
        case "failed": L10n("Failed")
        default: s
        }
    }

    private func save() {
        guard title == task.title || EntityNamePolicy.isValid(title) else { return }
        // 强制改状态 → 先弹二次确认，确认后才真正落库。
        if statusChanged {
            showStatusConfirm = true
            return
        }
        persistForeground()
    }

    private func persistForeground() {
        saveError = nil
        Task {
            guard await client.updateCorptieTask(
                taskId: task.id,
                title: title == task.title ? nil : title,
                description: detail.trimmingCharacters(in: .whitespacesAndNewlines),
                acceptanceCriteria: acceptanceCriteria.trimmingCharacters(in: .whitespacesAndNewlines),
                priority: priority,
                lifecycleState: status
            ) != nil else {
                saveError = client.errorMessage ?? L10n("CorptieTask 保存失败。")
                return
            }
            onSaved()
            dismiss()
        }
    }

    private func enqueuePersist() {
        guard CorptieTaskEditSubmissionPolicy.submitsInBackground(statusChanged: statusChanged) else {
            persistForeground()
            return
        }
        let targetsCompleted = CorptieTaskCompletionBackgroundDecision.resolve(
            status: status
        ) == .alreadyCompleted
        if targetsCompleted {
            let target = task
            let requestId = "completion-request:\(UUID().uuidString.lowercased())"
            let interactionId = "edit-completion-click:\(UUID().uuidString.lowercased())"
            Task {
                guard let receipt = await client.issueCorptieTaskCompletionIntent(
                    task: target,
                    interactionId: interactionId,
                    requestId: requestId,
                    uiSurface: "task_edit_status_confirmation"
                ) else {
                    saveError = client.errorMessage ?? L10n("Unable to authorize CorptieTask completion")
                    return
                }
                guard let submission = CorptieTaskCompletionSubmission.freeze(
                    task: target,
                    receipt: receipt,
                    requestId: requestId,
                    idempotencyKey: "completion:\(UUID().uuidString.lowercased())"
                ) else { return }
                startPersistBackground(completionSubmission: submission)
            }
            return
        }
        startPersistBackground()
    }

    private func startPersistBackground(completionSubmission: CorptieTaskCompletionSubmission? = nil) {
        let requestTitle = trimmedTitle
        let requestTitlePatch = title == task.title ? nil : title
        let requestDescription = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestAcceptanceCriteria = acceptanceCriteria.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestPriority = priority
        let requestStatus = status
        let taskId = updateTaskId
        let started = BackgroundTaskCenter.shared.start(
            id: taskId,
            title: L10nFormat("更新 CorptieTask：%@", requestTitle)
        ) {
            if let latest = await client.task(id: task.id),
               latest.title == requestTitle,
               latest.description == requestDescription,
               latest.acceptanceCriteria == requestAcceptanceCriteria,
               latest.priority == requestPriority,
               latest.lifecycleState == requestStatus {
                onSaved()
                return .success(L10nFormat("CorptieTask“%@”已更新。", requestTitle))
            }

            let targetsCompleted = CorptieTaskCompletionBackgroundDecision.resolve(
                status: requestStatus
            ) == .alreadyCompleted
            guard await client.updateCorptieTask(
                taskId: task.id,
                title: requestTitlePatch,
                description: requestDescription,
                acceptanceCriteria: requestAcceptanceCriteria,
                priority: requestPriority,
                lifecycleState: targetsCompleted ? nil : requestStatus
            ) != nil else {
                return .failure(client.errorMessage ?? L10n("CorptieTask 保存失败，可重试。"))
            }

            if targetsCompleted {
                guard let latest = await client.task(id: task.id) else {
                    return .failure(client.errorMessage ?? L10n("无法确认 CorptieTask 的最新状态，可重试。"))
                }
                if CorptieTaskCompletionBackgroundDecision.resolve(status: latest.lifecycleState) != .alreadyCompleted {
                    guard let completionSubmission else {
                        return .failure(L10n("Completion authorization is missing; reopen the CorptieTask and try again."))
                    }
                    let completed = await client.confirmCorptieTaskCompletion(submission: completionSubmission)
                    guard completed != nil else {
                        return .failure(client.errorMessage ?? L10n("CorptieTask 完成失败，可重试。"))
                    }
                }
            }
            onSaved()
            return .success(L10nFormat("CorptieTask“%@”已更新。", requestTitle))
        }
        if started || BackgroundTaskCenter.shared.records.contains(where: { $0.id == taskId }) {
            dismiss()
        }
    }
}
