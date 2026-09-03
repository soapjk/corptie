import SwiftUI
import AppKit

// Work 资源编辑器（唯一 Workspace / Contributor Agent）。
// 创建页（WorkCreateView）与详情编辑页（WorkDetailView）复用。
//
// - Workspace：已选列表 + 加号（普通目录可直接使用，Git 是可选能力）
// - Contributor Agent：已分配列表 + 加号（AgentPickerView 弹窗，可搜索/新建/选择已有）
struct WorkResourcesEditor: View {
    @ObservedObject private var client = EntityAPIClient.shared

    @Binding var workspaceId: String?
    @Binding var contributorAgentIds: Set<String>
    var workspaceEditable = true

    @State private var showAgentPicker = false
    @State private var workspaceError: String?
    @State private var pendingWorkspaceRegistration: WorkspaceRegistrationEnvelope?
    @State private var showGitInitializationConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            workspaceSection
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
        .confirmationDialog(
            L10n("初始化 Git 仓库？"),
            isPresented: $showGitInitializationConfirmation,
            presenting: pendingWorkspaceRegistration
        ) { registration in
            Button(L10n("直接使用，不启用 Git")) {
                workspaceId = registration.workspace.workspaceId
                pendingWorkspaceRegistration = nil
            }
            Button(L10n("初始化 Git 后使用")) {
                let path = registration.workspace.canonicalRootPath
                pendingWorkspaceRegistration = nil
                Task { await initializeAndAddWorkspace(at: path) }
            }
            Button(L10n("取消"), role: .cancel) {
                pendingWorkspaceRegistration = nil
            }
        } message: { registration in
            Text(L10nFormat("“%@”不是 Git 仓库。办公类 Work 可以直接使用；需要代码版本管理时也可以现在初始化 Git。", registration.workspace.rootPath))
        }
        .onAppear {
            Task {
                await client.refreshWorkspaces()
                await client.refreshRepositories()
                if client.works.isEmpty { await client.refreshWorks() }
                if client.agents.isEmpty { await client.refreshAgents() }
            }
        }
    }

    // MARK: - Workspace

    private var workspaceSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(L10n("文件空间（Workspace）"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if workspaceEditable {
                    Button(action: chooseWorkspace) {
                        Image(systemName: "plus.circle")
                    }
                    .buttonStyle(.borderless)
                    .help(L10n("选择 Workspace"))
                }
            }
            if selectedRepository == nil && workspaceId == nil {
                Text(L10n("尚未选择文件空间"))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 2)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    if let repo = selectedRepository {
                        if workspaceEditable {
                            resourceRow(label: repo.name, icon: "shippingbox") { workspaceId = nil }
                        } else {
                            Label(repo.name, systemImage: "shippingbox")
                        }
                    }
                    if selectedRepository == nil, let id = workspaceId {
                        let label = selectedWorkspace?.rootPath ?? id
                        if workspaceEditable {
                            resourceRow(label: label, icon: "folder") { workspaceId = nil }
                        } else {
                            Label(label, systemImage: "folder")
                        }
                    }
                }
            }
        }
    }

    private var selectedRepository: GitRepository? {
        client.repositories.first { $0.workspaceId == workspaceId }
    }

    private var selectedWorkspace: WorkspaceResource? {
        client.workspaces.first { $0.workspaceId == workspaceId }
    }

    private func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "选择 Work 使用的文件夹"
        panel.prompt = "添加"
        if panel.runModal() == .OK, let url = panel.url {
            Task {
                switch await client.registerWorkspace(path: url.path) {
                case .success(let registration) where registration.gitCapability == "ready":
                    await acceptWorkspace(registration.workspace)
                case .success(let registration):
                    await client.refreshWorks()
                    if let owner = client.works.first(where: {
                        $0.workspaceId == registration.workspace.workspaceId
                    }) {
                        workspaceError = L10nFormat(
                            "该文件夹已属于 Work“%@”。每个 Workspace 只能绑定一个 Work，请选择其他文件夹。",
                            owner.name
                        )
                        return
                    }
                    pendingWorkspaceRegistration = registration
                    showGitInitializationConfirmation = true
                case .failure(let message):
                    workspaceError = message
                }
            }
        }
    }

    private func initializeAndAddWorkspace(at path: String) async {
        switch await client.registerWorkspace(path: path, initializeGit: true) {
        case .success(let registration):
            await acceptWorkspace(registration.workspace)
        case .failure(let message):
            workspaceError = message
        }
    }

    private func acceptWorkspace(_ workspace: WorkspaceResource) async {
        await client.refreshWorks()
        if let owner = client.works.first(where: { $0.workspaceId == workspace.workspaceId }) {
            workspaceError = L10nFormat(
                "该文件夹已属于 Work“%@”。每个 Workspace 只能绑定一个 Work，请选择其他文件夹。",
                owner.name
            )
            return
        }
        workspaceId = workspace.workspaceId
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

// 单个可多选资源条目（关联 Work 多选用）
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
