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
                if budget == nil, value.policyEditable {
                    defaultPolicyToggle
                }
                if value.budgets.count > 1 {
                    Picker(selection: Binding(get: { budget?.id ?? "" }, set: { selection = $0; recordsExpanded = false; extraRuns = []; nextCursor = nil; recordsError = nil })) {
                        ForEach(value.budgets) { item in Text(item.instruction).tag(item.id) }
                    } label: { Text("指令", bundle: .module) }.font(.caption)
                }
                if let budget {
                    Text(budget.instruction).font(.caption).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Toggle(isOn: Binding(get: { budget.enabled }, set: { enabled in
                        perform(["action": .string("configure"), "instructionId": .string(budget.id), "enabled": .bool(enabled),
                                 "limit": .number(Double(enabled ? max(budget.limit, budget.used + 3) : budget.limit))])
                    })) { Text("限制本条验证次数", bundle: .module).font(.subheadline) }
                        .toggleStyle(.switch)
                        .accessibilityIdentifier("verification.current-limit")
                        .disabled(!canControl)
                    Text(budget.enabled ? "已用 \(budget.used)/\(budget.limit) · 剩余 \(budget.remaining ?? 0) 次" : "已用 \(budget.used) 次 · 不限次数", bundle: .module)
                        .font(.caption).monospacedDigit()
                    if !budget.enabled {
                        Text("开启后还可验证 \(max(budget.limit, budget.used + 3) - budget.used) 次，保留已有记录", bundle: .module)
                            .font(.caption2).foregroundStyle(.secondary)
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
                if budget != nil, value.policyEditable {
                    DisclosureGroup {
                        defaultPolicyToggle
                    } label: { Text("新指令默认设置", bundle: .module).font(.caption) }
                }
                if !canControl { Text("当前页面为只读，无法修改预算", bundle: .module).font(.caption2).foregroundStyle(.secondary) }
                if budget == nil, !value.policyEditable { Text("子任务共享原始指令预算", bundle: .module).font(.caption).foregroundStyle(.secondary) }
                Text("仅统计统一验证入口的批次，不包含原生 Shell 中的全部测试", bundle: .module)
                    .font(.caption2).foregroundStyle(.secondary)
            } else { Text("当前会话没有可绑定的任务指令", bundle: .module).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var defaultPolicyToggle: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: Binding(get: { value.policy.enabled }, set: { enabled in
                perform(["action": .string("policy"), "enabled": .bool(enabled), "limit": .number(Double(value.policy.limit))])
            })) { Text("新指令默认限制验证次数", bundle: .module).font(.subheadline) }
                .toggleStyle(.switch)
                .accessibilityIdentifier("verification.default-limit")
                .disabled(!canControl)
            Text("对后续新指令生效，当前指令可单独调整", bundle: .module).font(.caption).foregroundStyle(.secondary)
            if value.policy.enabled {
                Stepper(value: Binding(get: { value.policy.limit }, set: { limit in
                    perform(["action": .string("policy"), "enabled": .bool(true), "limit": .number(Double(limit))])
                }), in: 1...100) { Text("每条指令 \(value.policy.limit) 次", bundle: .module).font(.caption) }.disabled(!canControl)
            }
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
