import SwiftUI

// Agent 选择弹窗：搜索 / 选择已有 Agent / 新建 Agent。
// 由 WorkResourcesEditor 的 Contributor Agent 加号打开；选中的 id 直接写入 selectedIds。

struct RolePickerView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Binding var selectedIds: Set<String>
    var allowedAgentIds: Set<String>? = nil
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
                TextField(L10n("搜索 角色 名称"), text: $searchText)
                    .textFieldStyle(.roundedBorder)
                if allowedAgentIds == nil {
                    Button {
                        showCreate = true
                    } label: {
                        Label(L10n("新建 角色"), systemImage: "plus")
                    }
                }
            }
            .padding(12)

            Divider()

            if filteredAgents.isEmpty {
                VStack {
                    Spacer()
                    Text(L10n(searchText.isEmpty ? "No Roles" : "No Matching Roles"))
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                List(filteredAgents) { agent in
                    HStack(spacing: 8) {
                        Image(systemName: selectedIds.contains(agent.roleId) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selectedIds.contains(agent.roleId) ? Color.accentColor : Color.secondary)
                        Label(agent.name, systemImage: agent.isPlatformAssistant ? "sparkles" : "person")
                        Spacer()
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { toggle(agent.roleId) }
                }
                .listStyle(.inset)
            }

            Divider()

            HStack {
                Text(L10nFormat("%lld Roles Selected", Int64(selectedIds.count)))
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
                if client.roles.isEmpty { await client.refreshRoles() }
            }
        }
        .sheet(isPresented: $showCreate) {
            RoleCreateView { created in
                selectedIds.insert(created.roleId)
            }
        }
    }

    private var filteredAgents: [Role] {
        let scopeFiltered = allowedAgentIds.map { allowed in
            client.roles.filter { allowed.contains($0.roleId) }
        } ?? client.roles
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return scopeFiltered }
        return scopeFiltered.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
    }

    private func toggle(_ id: String) {
        if selectedIds.contains(id) { selectedIds.remove(id) }
        else { selectedIds.insert(id) }
    }
}
