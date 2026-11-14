import SwiftUI
import CorptieClientCore

/// Shared across desktop and paired clients. Loads on presentation/state change
/// or explicit refresh only; it does not poll while a verification is running.
public struct ConversationVerificationBudgetCard: View {
    private let taskID: String
    private let refreshID: String
    private let api: @MainActor () async throws -> ClientVerificationBudgetAPI
    @State private var budgets: [VerificationBudget] = []
    @State private var busy = false
    @State private var error: String?
    @State private var loadGeneration = 0
    @State private var pending: (instruction: String, stop: Bool, request: String)?
    public init(taskID: String, refreshID: String = "", api: @escaping @MainActor () async throws -> ClientVerificationBudgetAPI) {
        self.taskID = taskID; self.refreshID = refreshID; self.api = api
    }
    public var body: some View {
        ConversationDetailModuleCard(title: "验证预算", systemImage: "checkmark.shield") {
            VStack(alignment: .leading, spacing: 8) {
                Text("父子任务共享额度。仅约束统一验证入口，其他执行通道仍可绕过。")
                    .font(.caption).foregroundStyle(.secondary)
                if budgets.isEmpty { Text("尚无验证记录").font(.caption).foregroundStyle(.secondary) }
                ForEach(budgets) { budget in
                    VStack(alignment: .leading, spacing: 6) {
                        if let instruction = budget.instruction { Text(instruction).font(.caption).lineLimit(2) }
                        HStack {
                            Text("验证 \(budget.used)/\(budget.limit)").monospacedDigit()
                            Spacer()
                            Text(budget.running ? "运行中" : budget.paused ? "已暂停" : budget.runs.last?.status == "passed" ? "已通过" : "可验证")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        HStack {
                            Button("追加 1 次") { Task { await update(budget, stop: false) } }
                            Button("停止") { Task { await update(budget, stop: true) } }.disabled(budget.stopped)
                        }.disabled(busy || (pending != nil && pending?.instruction != budget.id))
                        DisclosureGroup("验证记录") {
                            ForEach(Array(budget.runs.enumerated()), id: \.element.id) { index, run in
                                Text("\(index + 1). \(label(run.status))").font(.caption)
                            }
                            Text("详细输出见原执行消息。").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                Button("刷新") { Task { await load() } }.disabled(busy)
            }
        }
        .task(id: "\(taskID):\(refreshID)") { await load() }
    }
    private func label(_ status: String) -> String {
        switch status {
        case "passed": return "通过"
        case "failed": return "未通过"
        case "running", "reserved": return "执行中"
        case "not_started": return "未启动"
        default: return "结果未知，请查看原执行记录"
        }
    }
    @MainActor private func load() async {
        loadGeneration += 1; let generation = loadGeneration
        do { let service = try await api(); let result = try await service.read(taskID: taskID)
            guard !Task.isCancelled, generation == loadGeneration else { return }; budgets = result; error = nil
        } catch { if !Task.isCancelled, generation == loadGeneration { self.error = error.localizedDescription } }
    }
    @MainActor private func update(_ budget: VerificationBudget, stop: Bool) async {
        guard !busy else { return }
        if let pending, pending.instruction != budget.id || pending.stop != stop {
            error = "请先重试上一次操作以确认结果。"; return
        }
        busy = true; defer { busy = false }
        let request = pending?.request ?? UUID().uuidString
        pending = (budget.id, stop, request)
        do { let service = try await api()
            try await service.update(taskID: taskID, instructionID: budget.id, stop: stop, requestID: request)
            pending = nil; await load()
        } catch { self.error = error.localizedDescription }
    }
}

public struct VerificationBudgetSettingsView: View {
    private let api: @MainActor () async throws -> ClientVerificationBudgetAPI
    @State private var limit = 3
    @State private var saved: Int?
    @State private var busy = false
    @State private var error: String?
    public init(api: @escaping @MainActor () async throws -> ClientVerificationBudgetAPI) { self.api = api }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("指令验证预算").font(.headline)
            Stepper("默认 \(limit) 次", value: $limit, in: 1...100).disabled(busy || saved == nil)
            Text("只影响新建预算，已有额度不变。仅约束统一验证入口，原生 Shell 等其他通道仍可绕过。")
                .font(.caption).foregroundStyle(.secondary)
            Button("保存验证预算") { Task { await save() } }.disabled(busy || saved == nil || saved == limit)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }.task {
            do { let service = try await api(); let result = try await service.defaultLimit()
                guard !Task.isCancelled else { return }; limit = result; saved = result
            } catch { self.error = error.localizedDescription }
        }
    }
    @MainActor private func save() async {
        busy = true; defer { busy = false }
        do { let service = try await api(); saved = try await service.defaultLimit(limit); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
