import SwiftUI

// 单选 Agent 选择弹窗：搜索 / 选择 / 新建 Agent。
// 与 AgentPickerView（多选）共用同一套交互语言，但只允许选中一个（或清空）。
// 由 AgentAssistButton 打开，用于指定「帮我写」的生成 Agent。

struct RoleSinglePickerView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    /// 当前选中（可选）；nil 表示「使用默认 Agent」。
    @Binding var selectedId: String?
    /// 完成回调（可选）：点「完成」时把最终选中 id 交回调用方；不传则仅关闭。
    var onDone: ((String?) -> Void)? = nil
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
                Button {
                    showCreate = true
                } label: {
                    Label(L10n("新建 角色"), systemImage: "plus")
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
                        Image(systemName: selectedId == agent.roleId ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selectedId == agent.roleId ? Color.accentColor : Color.secondary)
                        Label(agent.name, systemImage: agent.isPlatformAssistant ? "sparkles" : "person")
                        Spacer()
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { select(agent.roleId) }
                }
                .listStyle(.inset)
            }

            Divider()

            HStack {
                // 允许清空回退到「默认」：直接选定并关闭。
                Button {
                    selectedId = nil
                    onDone?(nil)
                    dismiss()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: selectedId == nil ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selectedId == nil ? Color.accentColor : Color.secondary)
                        Text(L10n("使用默认 角色"))
                    }
                }
                .buttonStyle(.borderless)
                .foregroundStyle(selectedId == nil ? Color.accentColor : Color.secondary)
                Spacer()
                Text(L10n(selectedId == nil ? "Default" : "1 Role Selected"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button(L10n("完成")) {
                    onDone?(selectedId)
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
                selectedId = created.roleId
            }
        }
    }

    private var filteredAgents: [Role] {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return client.roles }
        return client.roles.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
    }

    private func select(_ id: String?) {
        if selectedId == id { selectedId = nil }  // 再次点击已选项 = 取消（回退默认）
        else { selectedId = id }
    }
}
