import SwiftUI
import AppKit

// Objective 挂靠资源编辑器（Workspace / 关联 Objective / Contributor Agent）。
// 创建页（ObjectiveCreateView）与详情编辑页（ObjectiveDetailView）复用。
//
// - Workspace：已选列表 + 加号（NSOpenPanel 选目录 → 后端 detect 注册）
// - 关联 Objective：多选列表
// - Contributor Agent：已分配列表 + 加号（AgentPickerView 弹窗，可搜索/新建/选择已有）
struct ObjectiveResourcesEditor: View {
    @ObservedObject private var client = EntityAPIClient.shared

    @Binding var workspaceIds: Set<String>
    @Binding var relatedObjectiveIds: Set<String>
    @Binding var contributorAgentIds: Set<String>
    /// 编辑场景传入当前 Objective id，用于从「关联 Objective」候选中排除自己；创建场景为 nil。
    var excludeObjectiveId: String?

    @State private var showAgentPicker = false
    @State private var workspaceError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            workspaceSection
            relatedObjectiveSection
            agentSection
        }
        .sheet(isPresented: $showAgentPicker) {
            AgentPickerView(selectedIds: $contributorAgentIds, roleFilter: .independentContributor)
        }
        .alert(L10n("无法添加 Workspace"), isPresented: Binding(
            get: { workspaceError != nil },
            set: { if !$0 { workspaceError = nil } }
        )) {
            Button(L10n("确定"), role: .cancel) {}
        } message: {
            Text(workspaceError ?? "")
        }
        .onAppear {
            Task {
                await client.refreshRepositories()
                if client.objectives.isEmpty { await client.refreshObjectives() }
                if client.agents.isEmpty { await client.refreshAgents() }
            }
        }
    }

    // MARK: - Workspace

    private var workspaceSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(L10n("Workspace（Git 仓库）"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: chooseWorkspace) {
                    Image(systemName: "plus.circle")
                }
                .buttonStyle(.borderless)
                .help(L10n("添加 Git 仓库"))
            }
            if selectedRepositories.isEmpty && unresolvedWorkspaceIds.isEmpty {
                Text(L10n("尚未选择仓库"))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 2)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(selectedRepositories) { repo in
                        resourceRow(label: repo.name, icon: "shippingbox") {
                            workspaceIds.remove(repo.id)
                        }
                    }
                    ForEach(unresolvedWorkspaceIds, id: \.self) { id in
                        resourceRow(label: id, icon: "exclamationmark.triangle") {
                            workspaceIds.remove(id)
                        }
                    }
                }
            }
        }
    }

    private var selectedRepositories: [GitRepository] {
        client.repositories.filter { workspaceIds.contains($0.id) }
    }

    private var unresolvedWorkspaceIds: [String] {
        let registered = Set(client.repositories.map(\.id))
        return workspaceIds.filter { !registered.contains($0) }.sorted()
    }

    private func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "选择要挂靠的 Git 仓库目录"
        panel.prompt = "添加"
        if panel.runModal() == .OK, let url = panel.url {
            Task {
                if let repo = await client.detectRepository(path: url.path) {
                    workspaceIds.insert(repo.id)
                } else {
                    workspaceError = client.errorMessage ?? "未能识别所选目录为有效的 Git 仓库。"
                }
            }
        }
    }

    // MARK: - 关联 Objective（多选）

    private var relatedObjectiveSection: some View {
        MultiSelectSection(
            title: "关联 Objective",
            options: relatedCandidates.map { ResourceOption(id: $0.id, label: $0.name, icon: "target") },
            selection: $relatedObjectiveIds,
            emptyText: "暂无其他 Objective 可关联"
        )
    }

    private var relatedCandidates: [Objective] {
        guard let excludeObjectiveId else { return client.objectives }
        return client.objectives.filter { $0.id != excludeObjectiveId }
    }

    // MARK: - Contributor Agent

    private var agentSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(L10n("Contributor Agent"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: { showAgentPicker = true }) {
                    Image(systemName: "plus.circle")
                }
                .buttonStyle(.borderless)
                .help(L10n("分配 Agent"))
            }
            if selectedAgents.isEmpty && unresolvedAgentIds.isEmpty {
                Text(L10n("尚未分配 Agent"))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 2)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(selectedAgents) { agent in
                        resourceRow(label: agent.name, icon: agent.isAssistant ? "sparkles" : "person") {
                            contributorAgentIds.remove(agent.agentId)
                        }
                    }
                    ForEach(unresolvedAgentIds, id: \.self) { id in
                        resourceRow(label: id, icon: "exclamationmark.triangle") {
                            contributorAgentIds.remove(id)
                        }
                    }
                }
            }
        }
    }

    private var selectedAgents: [Agent] {
        client.agents.filter { contributorAgentIds.contains($0.agentId) }
    }

    private var unresolvedAgentIds: [String] {
        let assignable = Set(client.agents.filter(\.isIndependentContributor).map(\.agentId))
        return contributorAgentIds.filter { !assignable.contains($0) }.sorted()
    }

    // MARK: - 通用行

    private func resourceRow(label: String, icon: String, onRemove: @escaping () -> Void) -> some View {
        HStack(spacing: 6) {
            Label(label, systemImage: icon)
                .font(.callout)
            Spacer()
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 1)
    }
}

// 单个可多选资源条目（关联 Objective 多选用）
private struct ResourceOption: Identifiable {
    let id: String
    let label: String
    let icon: String
}

// 多选区块：标题 + 复选框式选项列表 + 空状态提示
private struct MultiSelectSection: View {
    let title: String
    let options: [ResourceOption]
    @Binding var selection: Set<String>
    let emptyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            if options.isEmpty {
                Text(emptyText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 2)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(options) { option in
                        HStack(spacing: 6) {
                            Image(systemName: selection.contains(option.id) ? "checkmark.square.fill" : "square")
                                .foregroundStyle(selection.contains(option.id) ? Color.accentColor : Color.secondary)
                            Label(option.label, systemImage: option.icon)
                                .font(.callout)
                            Spacer()
                        }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if selection.contains(option.id) { selection.remove(option.id) }
                            else { selection.insert(option.id) }
                        }
                        .padding(.vertical, 1)
                    }
                }
            }
        }
    }
}
