import SwiftUI
import CorptieClientCore

/// A bounded, event-refreshed view. No timer, Provider call or history copy.
public struct ConversationChildDelivery: View {
    let taskID: String
    let refreshID: String
    let api: @MainActor () async throws -> ClientTaskHierarchyAPI
    @State private var status: ClientChildDeliveryStatus?
    @State private var records: [ClientChildDelivery] = []
    @State private var cursor: String?
    @State private var busy = false
    @State private var error: String?
    @State private var intent: ClientChildCompletionIntent?
    public init(taskID: String,refreshID: String,api: @escaping @MainActor () async throws -> ClientTaskHierarchyAPI) {
        self.taskID=taskID; self.refreshID=refreshID; self.api=api
    }
    public var body: some View {
        VStack(alignment:.leading,spacing:6) {
            if let status, status.parentTaskId != nil {
                if let operation=status.operation {
                    record(operation)
                    if operation.state == "blocked" {
                        Text("若交付版本已变化，请重新验收；资源仍保留。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if status.operation == nil || status.operation?.state == "blocked" {
                    Text("验收后自动合入父分支、移交 Artifact 并清理子任务，不再重复确认。")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("验收并交付") { intent=nil; Task { await accept(status) } }
                }
            } else if !records.isEmpty {
                Text("子任务交付记录").font(.caption.weight(.semibold))
                ForEach(records) { record($0) }
                if cursor != nil { Button("加载更多") { Task { await load(more:true) } } }
            }
            if status?.parentTaskId != nil || !records.isEmpty {
                Button("刷新交付状态") { Task { await load() } }.font(.caption)
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                if intent != nil {
                    Button("重试本次验收") { if let status { Task { await accept(status) } } }.font(.caption)
                }
            }
        }
        .disabled(busy)
        .task(id:"\(taskID):\(refreshID)") { await load() }
    }
    private func record(_ value: ClientChildDelivery) -> some View {
        VStack(alignment:.leading,spacing:3) {
            Text("\(value.title) · \(label(value))").font(.caption)
            if let message=value.errorMessage { Text(message).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if !value.artifacts.isEmpty {
                Text(value.artifacts.map { "\($0.title) v\($0.version)" }.joined(separator:" · ")).font(.caption2).foregroundStyle(.secondary)
            }
            if value.canRetry { Button("重试交付") { Task { await retry(value) } }.font(.caption) }
        }
    }
    private func label(_ value: ClientChildDelivery) -> String {
        switch value.state {
        case "completed": return "已交付并清理"
        case "blocked": return "已暂停，资源保留"
        case "superseded": return "已由新验收取代"
        default:
            switch value.phase { case "artifacts": return "移交 Artifact 中"; case "cleanup": return "安全清理中"; default: return "等待或交付代码中" }
        }
    }
    @MainActor private func load(more: Bool = false) async {
        guard !busy else { return }; busy=true; defer { busy=false }
        do {
            let client=try await api()
            let value=try await client.childDelivery(taskID:taskID)
            guard !Task.isCancelled else { return }
            status=value
            if value.parentTaskId == nil {
                let page=try await client.childDeliveries(taskID:taskID,cursor:more ? cursor : nil)
                guard !Task.isCancelled else { return }
                records=more ? records + page.items : page.items; cursor=page.nextCursor
            }
            error=nil
        } catch is CancellationError {} catch { self.error=error.localizedDescription }
    }
    @MainActor private func accept(_ status: ClientChildDeliveryStatus) async {
        guard !busy, status.taskId == taskID else { return }; busy=true; defer { busy=false }
        do {
            let client=try await api()
            // Retain the exact submission after a lost response. Never turn a
            // network retry into a new human approval for a different version.
            if intent == nil { intent=try await client.prepareChildAcceptance(taskID:taskID,title:status.title,requestID:UUID().uuidString) }
            guard let intent else { return }
            guard intent.taskId == taskID else { self.intent=nil; return }
            let result=try await client.acceptChild(intent)
            self.status = .init(taskId:status.taskId,title:status.title,parentTaskId:status.parentTaskId,operation:result)
            self.intent=nil; error=nil
        } catch { self.error=error.localizedDescription }
    }
    @MainActor private func retry(_ value: ClientChildDelivery) async {
        guard !busy else { return }; busy=true
        do { _ = try await api().retryChildDelivery(operationID:value.id); error=nil }
        catch { self.error=error.localizedDescription }
        busy=false; await load()
    }
}
