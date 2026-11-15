import SwiftUI
import CorptieClientCore

struct ConversationVerificationSection: View {
    let value: ClientVerificationPerformance
    var canControl = true
    let perform: ([String: ClientInspectorValue]) -> Void
    var readRecords: ((String, String?) async throws -> ClientVerificationRunPage)? = nil
    @State private var extraRuns: [ClientVerificationPerformance.Run] = []
    @State private var nextCursor: String?
    @State private var loadingRecords = false
    @State private var recordsError: String?
    @State private var selection: String?
    @State private var recordsExpanded = false
    @State private var customAmount = 3
    @State private var showingAmount = false
    private var budget: ClientVerificationPerformance.Budget? {
        value.budgets.first { $0.id == selection } ?? value.budgets.first { $0.paused } ?? value.budgets.first
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            if value.available {
                Toggle(isOn: Binding(get: { value.policy.enabled }, set: { enabled in
                    perform(["action": .string("policy"), "enabled": .bool(enabled), "limit": .number(Double(value.policy.limit))])
                })) { Text("限制验证次数", bundle: .module).font(.subheadline) }
                .disabled(!value.policyEditable || !canControl)
                Text(value.policyEditable ? "对后续新指令生效，当前指令可单独调整" : "子任务共享原始指令预算", bundle: .module)
                    .font(.caption).foregroundStyle(.secondary)
                if value.policy.enabled, value.policyEditable {
                    Stepper(value: Binding(get: { value.policy.limit }, set: { limit in
                        perform(["action": .string("policy"), "enabled": .bool(true), "limit": .number(Double(limit))])
                    }), in: 1...100) { Text("每条指令 \(value.policy.limit) 次", bundle: .module).font(.caption) }
                }
                if value.budgets.count > 1 {
                    Picker(selection: Binding(get: { budget?.id ?? "" }, set: { selection = $0; recordsExpanded = false; extraRuns = []; nextCursor = nil; recordsError = nil })) {
                        ForEach(value.budgets) { item in Text(item.instruction).tag(item.id) }
                    } label: { Text("指令", bundle: .module) }.font(.caption)
                }
                if let budget {
                    Text(budget.instruction).font(.caption).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    HStack(alignment: .firstTextBaseline) {
                        Text(budget.enabled ? "已用 \(budget.used)/\(budget.limit) · 剩余 \(budget.remaining ?? 0) 次" : "已用 \(budget.used) 次 · 不限次数", bundle: .module)
                            .font(.caption).monospacedDigit()
                        Spacer(minLength: 4)
                        Menu {
                            Button {
                                perform(["action": .string("configure"), "instructionId": .string(budget.id), "enabled": .bool(!budget.enabled),
                                         "limit": .number(Double(max(budget.limit, budget.used + 3)))])
                            } label: { Text(budget.enabled ? "本条不限次数" : "对本条开启限制", bundle: .module) }
                        } label: { Image(systemName: "ellipsis") }.buttonStyle(.plain).fixedSize()
                        .accessibilityLabel(Text("调整本条指令预算", bundle: .module)).disabled(!canControl)
                    }
                    Text(LocalizedStringKey(budget.statusTitle), bundle: .module).font(.caption)
                        .foregroundStyle(budget.paused ? Color.orange : Color.secondary)
                    if budget.sessionId != value.sessionId { Text("与父会话共享预算", bundle: .module).font(.caption).foregroundStyle(.secondary) }
                    if budget.enabled, budget.pauseReason != "user", budget.pauseReason != "recovery_unknown" {
                        HStack(spacing: 12) {
                            Button("+1") { extend(1, budget) }
                            Button { extend(3, budget) } label: { Text(budget.paused ? "增加 3 次并继续" : "+3", bundle: .module) }
                            Button { showingAmount = true } label: { Text("自定义", bundle: .module) }
                                .popover(isPresented: $showingAmount) {
                                    VStack(alignment: .leading, spacing: 12) {
                                        Stepper(value: $customAmount, in: 1...100) { Text("增加 \(customAmount) 次", bundle: .module) }
                                        Button { showingAmount = false; extend(customAmount, budget) } label: { Text(budget.paused ? "增加预算并继续" : "增加预算", bundle: .module) }
                                        if budget.paused { Button { showingAmount = false; extend(customAmount, budget, resume: false) } label: { Text("只增加，不立即继续", bundle: .module) } }
                                    }.padding(16)
                                }
                        }.font(.caption).buttonStyle(.borderless).disabled(!canControl)
                    }
                    if budget.resumeRequested { Text("续作已受理，等待原执行结束", bundle: .module).font(.caption).foregroundStyle(.secondary) }
                    DisclosureGroup(isExpanded: $recordsExpanded) {
                        ScrollView(.vertical) { LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(budget.runs.reversed()) + extraRuns.filter { run in !budget.runs.contains(where: { $0.id == run.id }) }) { run in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack { Text(LocalizedStringKey(runTitle(run.status)), bundle: .module); Spacer(minLength: 4); Text(run.createdAt).lineLimit(1) }
                                Text(run.executorSessionId == value.sessionId ? "当前会话" : run.executorSessionId == budget.sessionId ? "父会话" : "子会话或影子会话", bundle: .module).foregroundStyle(.secondary)
                            }.font(.caption)
                        }
                        if (extraRuns.isEmpty ? budget.runsHasMore : nextCursor != nil), readRecords != nil {
                            Button { Task { await loadMore(budget) } } label: { Text("读取更早记录", bundle: .module) }.disabled(loadingRecords)
                        }
                        } }.frame(maxHeight: 200)
                        if loadingRecords { ProgressView().controlSize(.small) }
                        if let recordsError { Text(recordsError).font(.caption).foregroundStyle(.secondary) }
                    } label: { Text("验证记录", bundle: .module).font(.caption) }
                } else { Text("尚未验证", bundle: .module).font(.caption).foregroundStyle(.secondary) }
                Text("仅统计统一验证入口的批次，不包含原生 Shell 中的全部测试", bundle: .module)
                    .font(.caption2).foregroundStyle(.secondary)
            } else { Text("当前会话没有可绑定的任务指令", bundle: .module).font(.caption).foregroundStyle(.secondary) }
        }
    }
    @MainActor private func loadMore(_ budget: ClientVerificationPerformance.Budget) async {
        guard !loadingRecords, let readRecords else { return }
        let id = budget.id
        loadingRecords = true; recordsError = nil
        defer { loadingRecords = false }
        do {
            let page = try await readRecords(id, extraRuns.isEmpty ? budget.nextRunCursor : nextCursor)
            guard self.budget?.id == id, !Task.isCancelled else { return }
            extraRuns.append(contentsOf: page.runs.filter { run in !extraRuns.contains(where: { $0.id == run.id }) })
            nextCursor = page.nextCursor
        } catch { recordsError = error.localizedDescription }
    }
    private func extend(_ amount: Int, _ budget: ClientVerificationPerformance.Budget, resume: Bool? = nil) {
        perform(["action": .string("extend"), "instructionId": .string(budget.id), "amount": .number(Double(amount)), "resume": .bool(resume ?? budget.paused)])
    }
    private func runTitle(_ status: String) -> String {
        switch status {
        case "passed": "通过"
        case "failed": "失败"
        case "not_started": "未启动，不扣次数"
        case "unknown": "结果待核对"
        case "reserved", "running": "验证中"
        default: "已结束"
        }
    }
}
