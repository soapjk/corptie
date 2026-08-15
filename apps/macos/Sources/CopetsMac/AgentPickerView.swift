import SwiftUI

// Agent 选择弹窗：搜索 / 选择已有 Agent / 新建 Agent。
// 由 ObjectiveResourcesEditor 的 Contributor Agent 加号打开；选中的 id 直接写入 selectedIds。

struct AgentPickerView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Binding var selectedIds: Set<String>
    /// 完成回调（可选）：点「完成」时把最终选中集合交回调用方；不传则仅关闭。
    var onDone: ((Set<String>) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    @State private var searchText = ""
    @State private var showCreate = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("搜索 Agent 名称", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                Button {
                    showCreate = true
                } label: {
                    Label("新建 Agent", systemImage: "plus")
                }
            }
            .padding(12)

            Divider()

            if filteredAgents.isEmpty {
                VStack {
                    Spacer()
                    Text(searchText.isEmpty ? "暂无 Agent" : "没有匹配的 Agent")
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                List(filteredAgents) { agent in
                    HStack(spacing: 8) {
                        Image(systemName: selectedIds.contains(agent.agentId) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selectedIds.contains(agent.agentId) ? Color.accentColor : Color.secondary)
                        Label(agent.name, systemImage: agent.isAssistant ? "sparkles" : "person")
                        Spacer()
                        if let provider = agent.provider {
                            Text(provider)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { toggle(agent.agentId) }
                }
                .listStyle(.inset)
            }

            Divider()

            HStack {
                Text("已选 \(selectedIds.count) 个 Agent")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("完成") {
                    onDone?(selectedIds)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
        .frame(width: 420, height: 460)
        .onAppear {
            Task {
                if client.agents.isEmpty { await client.refreshAgents() }
            }
        }
        .sheet(isPresented: $showCreate) {
            AgentCreateView { created in
                selectedIds.insert(created.agentId)
            }
        }
    }

    private var filteredAgents: [Agent] {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return client.agents }
        return client.agents.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
    }

    private func toggle(_ id: String) {
        if selectedIds.contains(id) { selectedIds.remove(id) }
        else { selectedIds.insert(id) }
    }
}
