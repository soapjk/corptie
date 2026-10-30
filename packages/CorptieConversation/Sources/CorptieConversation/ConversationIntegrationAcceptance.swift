import SwiftUI
import CorptieClientCore

/// Shared by Detail and the desktop/paired Worktree managers. Approval never
/// resumes a Git job; the caller owns the separate publication action.
public struct ConversationIntegrationAcceptance<Actions: View>: View {
    private let taskID: String
    private let api: @MainActor () async throws -> ClientTaskHierarchyAPI
    private let openParent: ((String) -> Void)?
    private let localize: (String) -> String
    private let actions: (TaskIntegrationAcceptanceStatus?) -> Actions
    @State private var status: TaskIntegrationAcceptanceStatus?
    @State private var approval: TaskIntegrationUserApproval?
    @State private var busy = false
    @State private var failure: String?
    @State private var activeTaskID: String?
    @State private var requestToken = UUID()

    public init(taskID: String, api: @escaping @MainActor () async throws -> ClientTaskHierarchyAPI,
                openParent: ((String) -> Void)? = nil, localize: @escaping (String) -> String = { $0 },
                @ViewBuilder actions: @escaping (TaskIntegrationAcceptanceStatus?) -> Actions) {
        self.taskID = taskID; self.api = api; self.openParent = openParent
        self.localize = localize; self.actions = actions
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(localize(title)).font(.caption.weight(.medium))
                Spacer(minLength: 4)
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel(localize("刷新验收状态"))
            }
            if let title = status?.parentTaskTitle {
                Text("\(localize("父任务"))：\(title)").font(.caption).foregroundStyle(.secondary)
            }
            if status?.approvalSource == "manual_user" {
                Text(localize("人工确认不代表自动化测试已通过。"))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if let reason = status?.reason {
                Text(localize(reasonText(reason))).font(.caption).foregroundStyle(.secondary)
            }
            if let sessionID = status?.parentSessionId, let openParent {
                Button(localize("前往父会话验证")) { openParent(sessionID) }
            }
            if status?.manualAcceptance == true && !["not_required", "not_applicable", "blocked"].contains(status?.state ?? "")
                && !(status?.state == "passed" && status?.mayPromote == true) {
                Button(localize("人工验收通过")) { Task { await prepare() } }
                    .disabled(status?.reason == "CHILDREN_NOT_INTEGRATED")
            }
            actions(status)
            if let failure { Text(localize(failure)).font(.caption).foregroundStyle(.orange) }
        }
        .disabled(busy || activeTaskID != taskID)
        .task(id: taskID) {
            activeTaskID = taskID; requestToken = UUID(); status = nil; approval = nil
            await load()
        }
        .onDisappear { activeTaskID = nil; requestToken = UUID() }
        .sheet(item: $approval) { value in
            IntegrationUserApprovalSheet(approval: value, api: api, localize: localize) { next in
                guard activeTaskID == value.parentTaskId else { return }
                status = next
            }
        }
    }

    private var title: String {
        switch status?.state {
        case "not_required": "子任务无代码交付，无需额外集成验收"
        case "passed": status?.approvalSource == "manual_user" ? "已人工验收" : "集成验证已通过"
        case "stale": "版本已变化，需要重新验收"
        case "blocked": "请先处理工作区状态"
        case "not_applicable": "无需集成验收"
        default: "等待父任务验收"
        }
    }

    private func reasonText(_ reason: String) -> String {
        switch reason {
        case "CHILDREN_NOT_INTEGRATED": "子分支尚未全部合入，请先合并子任务改动。"
        case "INTEGRATION_ACCEPTANCE_REQUIRED": "可在此人工确认，或前往父会话执行验证。"
        case "INTEGRATION_ACCEPTANCE_STALE": "代码或验收范围已更新，原验收不再适用。"
        case "TASK_HIERARCHY_BUSY": "当前有其他操作正在进行，请稍后刷新。"
        default: "工作区存在未提交改动、绑定异常或状态变化，请检查后刷新。"
        }
    }

    @MainActor private func load() async {
        let token = UUID(), scope = taskID
        requestToken = token; busy = true
        defer { if requestToken == token { busy = false } }
        do {
            let value = try await api().acceptance(taskID: scope)
            guard !Task.isCancelled, requestToken == token, activeTaskID == scope else { return }
            status = value; failure = nil
        } catch {
            guard !Task.isCancelled, requestToken == token, activeTaskID == scope else { return }
            failure = "无法读取验收状态，请刷新重试。"
        }
    }

    @MainActor private func prepare() async {
        guard let revision = status?.hierarchyRevision, let binding = status?.bindingRevision else { return }
        let token = UUID(), scope = taskID
        requestToken = token; busy = true
        defer { if requestToken == token { busy = false } }
        do {
            let value = try await api().prepareManualAcceptance(taskID: scope, requestID: UUID().uuidString,
                revision: revision, bindingRevision: binding)
            guard !Task.isCancelled, requestToken == token, activeTaskID == scope else { return }
            approval = value; failure = nil
        } catch {
            guard !Task.isCancelled, requestToken == token, activeTaskID == scope else { return }
            failure = "无法准备当前验收版本，请刷新后重试。"
        }
    }
}

private struct IntegrationUserApprovalSheet: View {
    let approval: TaskIntegrationUserApproval
    let api: @MainActor () async throws -> ClientTaskHierarchyAPI
    let localize: (String) -> String
    let approved: (TaskIntegrationAcceptanceStatus) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var requestID = UUID().uuidString
    @State private var acknowledged = false
    @State private var busy = false
    @State private var failure: String?
    @State private var active = true

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(localize("人工验收当前版本")).font(.headline)
            Text(approval.parentTaskTitle)
            Text("\(localize("当前版本"))：\(approval.parentHeadOid.prefix(10))")
                .font(.caption.monospaced())
            Text(localize("本次操作记录你的人工确认，不代表自动化测试已通过，也不会自动合并主分支。"))
                .font(.callout)
            if approval.automatedVerification == "failed" {
                Toggle(localize("我已知晓当前存在未通过的自动验证结果，仍确认人工验收通过。"), isOn: $acknowledged)
            }
            if let failure { Text(localize(failure)).font(.caption).foregroundStyle(.orange) }
            HStack {
                Spacer()
                Button(localize("取消")) { dismiss() }.disabled(busy)
                Button(localize("确认通过")) { Task { await confirm() } }
                    .disabled(busy || (approval.automatedVerification == "failed" && !acknowledged))
            }
        }
        .padding(20)
        .frame(idealWidth: 420)
        .interactiveDismissDisabled(busy)
        .onDisappear { active = false }
    }

    @MainActor private func confirm() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await api().confirmManualAcceptance(approval, requestID: requestID, acknowledgedFailure: acknowledged)
            guard !Task.isCancelled, active else { return }
            approved(result); dismiss()
        } catch {
            guard !Task.isCancelled, active else { return }
            failure = "无法确认验收，版本可能已变化或确认已过期。请关闭窗口并刷新后重试。"
        }
    }
}
