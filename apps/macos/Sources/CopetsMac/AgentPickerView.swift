import SwiftUI

// Agent 选择弹窗：搜索 / 选择已有 Agent / 新建 Agent。
// 由 ObjectiveResourcesEditor 的 Contributor Agent 加号打开；选中的 id 直接写入 selectedIds。

struct AgentPickerView: View {
    enum RoleFilter {
        case all
        case independentContributor
    }

    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @Binding var selectedIds: Set<String>
    var roleFilter: RoleFilter = .all
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
                TextField(L10n("搜索 Agent 名称"), text: $searchText)
                    .textFieldStyle(.roundedBorder)
                Button {
                    showCreate = true
                } label: {
                    Label(L10n("新建 Agent"), systemImage: "plus")
                }
            }
            .padding(12)

            Divider()

            if filteredAgents.isEmpty {
                VStack {
                    Spacer()
                    Text(L10n(searchText.isEmpty ? "No Agents" : "No Matching Agents"))
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
                            Text(backendClient.providerDisplayName(for: provider) ?? provider)
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
                Text(L10nFormat("%lld Agents Selected", Int64(selectedIds.count)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(L10n("完成")) {
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
                if backendClient.agentProviders.isEmpty { await backendClient.loadProviders() }
            }
        }
        .sheet(isPresented: $showCreate) {
            AgentCreateView { created in
                selectedIds.insert(created.agentId)
            }
        }
    }

    private var filteredAgents: [Agent] {
        let roleFiltered = roleFilter == .independentContributor
            ? client.agents.filter(\.isIndependentContributor)
            : client.agents
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return roleFiltered }
        return roleFiltered.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
    }

    private func toggle(_ id: String) {
        if selectedIds.contains(id) { selectedIds.remove(id) }
        else { selectedIds.insert(id) }
    }
}
