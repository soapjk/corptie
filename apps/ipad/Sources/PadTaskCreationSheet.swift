import SwiftUI
import CorptieClientCore

struct PadTaskCreationRoute: Identifiable {
    let id = UUID()
    let workName: String
    let state: PadTaskCreationState
}

struct PadTaskCreationSheet: View {
    let route: PadTaskCreationRoute
    let connection: PadConnection
    let workspace: PadWorkspace
    @Bindable var state: PadTaskCreationState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    private var provider: Binding<String> {
        Binding(get: { state.draft.providerID }, set: { state.selectProvider($0) })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(route.workName) {
                    TextField("Task 名称", text: $state.draft.title)
                        .accessibilityIdentifier("task-create-title")
                    Text("名称支持中文、英文字母和数字，与 Mac 保持一致。")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("任务描述", text: $state.draft.description, axis: .vertical).lineLimit(3...8)
                    TextField("验收标准", text: $state.draft.acceptanceCriteria, axis: .vertical).lineLimit(2...6)
                    TextField("验证要求", text: $state.draft.verificationCriteria, axis: .vertical).lineLimit(2...6)
                }
                .disabled(state.pending != nil || state.submitting || !state.matches(connection))

                if let options = state.options {
                    Section("执行配置") {
                        Picker("Agent", selection: $state.draft.agentID) {
                            ForEach(options.agents) { Text($0.name).tag($0.id) }
                        }
                        Picker("Provider", selection: provider) {
                            ForEach(options.providers) { item in
                                Text(item.available ? item.name : "\(item.name)（不可用）")
                                    .tag(item.id).disabled(!item.available)
                            }
                        }
                        Picker("优先级", selection: $state.draft.priority) {
                            ForEach(options.priorities, id: \.self) { Text($0).tag($0) }
                        }
                        Picker("模型", selection: $state.draft.model) {
                            Text("使用默认模型").tag("")
                            ForEach(options.models) { Text($0.name).tag($0.id) }
                        }
                        if let model = options.models.first(where: { $0.id == state.draft.model }), !model.reasoningLevels.isEmpty {
                            Picker("推理强度", selection: $state.draft.reasoning) {
                                Text("使用默认设置").tag("")
                                ForEach(model.reasoningLevels, id: \.self) { Text($0).tag($0) }
                            }
                        }
                    }
                    .disabled(state.pending != nil || state.submitting || state.loading || !state.matches(connection))
                }
                Section {
                    if !state.matches(connection) {
                        Text("后端或设备身份已改变。此表单保留在原连接下，请关闭后重新打开。")
                    }
                    if state.loading || state.submitting || state.checking { ProgressView() }
                    if !state.notice.isEmpty { Text(state.notice).font(.callout) }
                    if let result = state.result {
                        Button("打开新会话") {
                            guard state.matches(connection) else { return }
                            workspace.selection = result.sessionId
                            dismiss()
                        }.disabled(!state.matches(connection))
                        Button("再创建一个 Task") { state.startAnother() }
                            .disabled(!state.matches(connection))
                    } else if state.pending != nil {
                        Button("核对创建结果") { Task { await state.reconcile(connection) } }
                            .disabled(state.checking || !state.matches(connection))
                    } else {
                        Button("重新加载执行选项") { Task { await state.loadOptions(connection) } }
                            .disabled(state.loading || !state.matches(connection))
                        Button("创建 Task 与配套会话") { Task { await state.submit(connection) } }
                            .disabled(!state.canSubmit || !state.matches(connection))
                            .accessibilityIdentifier("task-create-submit")
                    }
                }
            }
            .navigationTitle("创建 Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { state.flush(); dismiss() }
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .task(id: state.draft.providerID) { await state.loadOptions(connection) }
        .task(id: "\(state.pending?.input.requestId ?? ""):active=\(scenePhase == .active)") {
            guard scenePhase == .active else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            guard !Task.isCancelled, state.matches(connection), state.pending != nil,
                  state.result == nil, !state.reconciliationDenied else { return }
            await state.reconcile(connection)
        }
        .onChange(of: workspace.pushedReceiptRevision) {
            if let receipt = workspace.pushedReceipt { state.acceptPushed(receipt) }
        }
        .onChange(of: state.draft.model) { state.draft.reasoning = "" }
        .onDisappear { state.flush() }
    }
}
