import SwiftUI
import CorptieClientCore

/// One bounded, user-driven recovery surface for desktop and mobile.
public struct ConversationTaskStartupRecovery: View {
    private let taskId: String
    private let api: @MainActor () async throws -> ClientTaskStartupAPI
    private let openSession: (String) -> Void
    private let openParent: ((String) -> Void)?
    private let localize: (String) -> String
    @State private var value: ClientTaskStartup?
    @State private var busy = false
    @State private var failure: String?
    @State private var active = true
    @Environment(\.dismiss) private var dismiss
    public init(taskId: String, api: @escaping @MainActor () async throws -> ClientTaskStartupAPI,
                openSession: @escaping (String) -> Void, openParent: ((String) -> Void)? = nil,
                localize: @escaping (String) -> String = { $0 }) {
        self.taskId = taskId; self.api = api; self.openSession = openSession
        self.openParent = openParent; self.localize = localize
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(localize("启动状态与恢复")).font(.headline)
            if busy { ProgressView() }
            if let value {
                Text(localize(value.status == "ready" ? "会话已就绪" : value.status == "pending"
                    ? "正在准备工作区与会话" : value.status == "failed"
                    ? "Task 已保存，但会话未启动。" : "尚未找到可恢复的启动记录。"))
                if value.error != nil {
                    Text(localize(value.reasonKey)).foregroundStyle(.secondary)
                    Text(value.error!.code).font(.caption.monospaced()).textSelection(.enabled)
                }
                if let sessionId = value.sessionId, value.status == "ready" {
                    Button(localize("打开会话")) { openSession(sessionId); dismiss() }
                }
                if value.canRetry, let operation = value.startupOperationId {
                    Button(localize("重试启动")) { Task { await load(operation) } }
                        .accessibilityIdentifier("task.startup.retry")
                }
                if let parent = value.parentTaskId, let openParent {
                    Button(localize("打开父任务")) { openParent(parent); dismiss() }
                }
            }
            if let failure { Text(failure).foregroundStyle(.secondary) }
            HStack {
                Button(localize("刷新状态")) { Task { await load(nil) } }
                Spacer()
                Button(localize("关闭")) { dismiss() }
            }
        }
        .padding(20)
        .frame(idealWidth: 400)
        .disabled(busy)
        .task(id: taskId) { await load(nil) }
        .onAppear { active = true }
        .onDisappear { active = false }
    }
    @MainActor private func load(_ operation: String?) async {
        guard !busy else { return }
        busy = true; failure = nil
        defer { busy = false }
        do {
            let client = try await api()
            let result: ClientTaskStartup
            if let operation { result = try await client.retry(taskId: taskId, startupOperationId: operation) }
            else { result = try await client.status(taskId: taskId) }
            guard !Task.isCancelled, active else { return }
            value = result
        } catch {
            guard !Task.isCancelled, active else { return }
            failure = localize("无法确认启动结果，请刷新状态，不要重复创建 Task。")
        }
    }
}
