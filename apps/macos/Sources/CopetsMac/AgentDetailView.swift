import SwiftUI

// Agent 详情页（模块 B）：承载重命名/编辑/设置/启停/设为助手/删除等低频管理操作。
// 从侧栏 Agent 右键「打开详情」进入（sheet 弹窗）。

struct AgentDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @EnvironmentObject private var router: AppTabRouter
    @Environment(\.dismiss) private var dismiss
    let agent: Agent

    @State private var name: String
    @State private var detail: String
    @State private var provider: String
    @State private var systemPrompt: String
    @State private var selectedSkillIds: Set<String>
    @State private var showSkillRegister = false
    @State private var isSaving = false
    @State private var saveError: String?
    @State private var showDeleteConfirm = false
    @State private var showSessionCreation = false
    @State private var assistAgentId: String?

    init(agent: Agent) {
        self.agent = agent
        _name = State(initialValue: agent.name)
        _detail = State(initialValue: agent.description)
        _provider = State(initialValue: agent.provider ?? "")
        _systemPrompt = State(initialValue: agent.systemPrompt)
        _selectedSkillIds = State(initialValue: Set(agent.skillIds ?? []))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            Divider()
            form
            Divider()
            actions
            deleteButton
        }
        .padding(24)
        .frame(width: 500)
        .alert(L10n("删除 Agent"), isPresented: $showDeleteConfirm) {
            Button(L10n("删除"), role: .destructive) {
                Task { await client.deleteAgent(agentId: agent.agentId) }
                dismiss()
            }
            Button(L10n("取消"), role: .cancel) {}
        } message: {
            Text(L10n("删除后该 Agent 的历史会话会解绑保留，但此操作不可撤销。"))
        }
        .sheet(isPresented: $showSessionCreation) {
            NewSessionCreationSheet(fixedAgent: agent) { session in
                dismiss()
                router.openSession(session.id)
            }
        }
        .sheet(isPresented: $showSkillRegister) {
            SkillRegisterView { skill in
                if let skill { selectedSkillIds.insert(skill.skillId) }
            }
        }
        .task {
            if backendClient.agentProviders.isEmpty {
                await backendClient.loadProviders()
            }
            await client.refreshSkills()
            await client.refreshAgents()
            if let latest = client.agents.first(where: { $0.agentId == agent.agentId }) {
                selectedSkillIds = Set(latest.skillIds ?? [])
            }
            reconcileProviderSelection()
        }
        .onChange(of: backendClient.agentProviders) { _, _ in reconcileProviderSelection() }
    }

    // MARK: - 头部

    private var header: some View {
        HStack(spacing: 14) {
            agentAvatar
                .frame(width: 56, height: 56)
                .overlay(alignment: .bottomTrailing) {
                    Button {
                        chooseAvatar()
                    } label: {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(4)
                            .background(Circle().fill(Color.black.opacity(0.55)))
                    }
                    .buttonStyle(.plain)
                    .help(L10n("设置头像"))
                }

            VStack(alignment: .leading, spacing: 4) {
                Text(agent.name)
                    .font(.title3.bold())
                HStack(spacing: 8) {
                    Text(roleLabel)
                        .font(.caption)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(roleColor.opacity(0.15)))
                        .foregroundStyle(roleColor)
                    Text(statusLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if agent.status == "unavailable", let reason = agent.statusReason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
            }
            Spacer()
        }
    }

    // 头像：优先自定义头像，否则 Agent 级渐变+首字母（与浮球/会话一致）。
    private var agentAvatar: some View {
        Group {
            if let avatarPath = client.agents.first(where: { $0.agentId == agent.agentId })?.avatarPath ?? agent.avatarPath,
               !avatarPath.isEmpty {
                AnimatedAvatarImage(path: avatarPath)
            } else {
                DefaultInitialAvatarView(
                    familySeed: agent.name,
                    variationSeed: agent.agentId,
                    initials: DefaultAvatarInitials.make(from: agent.name),
                    size: 44
                )
            }
        }
        .clipShape(Circle())
    }

    // MARK: - 编辑表单

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            field(L10n("名称")) {
                TextField(L10n("名称"), text: $name)
            }
            field(L10n("描述")) {
                TextField(L10n("描述"), text: $detail)
            } trailing: {
                AgentAssistButton(fieldLabel: "描述", text: $detail, selectedAgentId: $assistAgentId, context: "Agent 名称：\(name)")
            }
            field("Provider") {
                Picker("", selection: $provider) {
                    Text(L10n("无")).tag("")
                    if !provider.isEmpty,
                       !creatableProviders.contains(where: { $0.matches(provider) }) {
                        Text(backendClient.providerDisplayName(for: provider) ?? provider).tag(provider)
                    }
                    ForEach(creatableProviders) { descriptor in
                        Text(descriptor.displayName).tag(descriptor.id)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 200, alignment: .leading)
            }
            field("System Prompt") {
                TextEditor(text: $systemPrompt)
                    .font(.body)
                    .frame(height: 80)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            } trailing: {
                AgentAssistButton(fieldLabel: "System Prompt", text: $systemPrompt, selectedAgentId: $assistAgentId, context: "Agent 名称：\(name)；描述：\(detail)")
            }
            AgentSkillSelectionView(
                skills: client.skills,
                selectedSkillIds: $selectedSkillIds,
                isEnabled: providerSupportsSkillLoading,
                onRegister: { showSkillRegister = true }
            )
            if let saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - 操作

    private var creatableProviders: [AgentProviderDescriptor] {
        backendClient.agentProviders.filter { $0.supports("session.create") }
    }

    private func reconcileProviderSelection() {
        if let canonical = backendClient.agentProviders.canonicalProviderId(for: provider) {
            provider = canonical
        }
    }

    private var providerSupportsSkillLoading: Bool {
        guard let descriptor = backendClient.agentProviders.first(where: { $0.matches(provider) }) else { return false }
        return descriptor.supports("agent.skills.lazyLoad")
    }

    private var actions: some View {
        HStack(spacing: 12) {
            Button {
                showSessionCreation = true
            } label: {
                Label(L10n("开始新会话"), systemImage: "bubble.left.and.bubble.right")
            }
            .buttonStyle(.bordered)

            Spacer()

            if client.agents.first(where: { $0.agentId == agent.agentId })?.avatarPath ?? agent.avatarPath != nil {
                Button(L10n("清除头像")) {
                    Task { await client.clearAgentAvatar(agentId: agent.agentId) }
                }
                .buttonStyle(.bordered)
            }

            Button(L10n("保存")) {
                Task {
                    isSaving = true
                    saveError = nil
                    let updated = await client.updateAgent(
                        agentId: agent.agentId,
                        name: name,
                        description: detail,
                        provider: provider.isEmpty ? nil : provider,
                        systemPrompt: systemPrompt,
                        skillIds: Array(selectedSkillIds)
                    )
                    isSaving = false
                    if updated != nil {
                        dismiss()
                    } else {
                        saveError = client.errorMessage ?? L10n("保存失败。")
                    }
                }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(isSaving || (!selectedSkillIds.isEmpty && !providerSupportsSkillLoading))
        }
    }

    // 选择图片设置 Agent 头像（复制到后端托管目录）。
    private func chooseAvatar() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.gif, .png, .jpeg, .heic, .tiff, .image]
        if panel.runModal() == .OK, let url = panel.url {
            Task { await client.setAgentAvatar(agentId: agent.agentId, sourcePath: url.path) }
        }
    }

    // MARK: - 删除（红色，底部）

    private var deleteButton: some View {
        HStack {
            Spacer()
            Button {
                showDeleteConfirm = true
            } label: {
                Label(L10n("删除 Agent"), systemImage: "trash")
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - 辅助

    private var roleLabel: String {
        L10n(agent.isAssistant ? "Assistant" : "Independent Contributor")
    }

    private var roleColor: Color {
        agent.isAssistant ? .purple : .blue
    }

    private var statusLabel: String {
        switch agent.status {
        case "unavailable": L10n("Unavailable")
        default: L10n("Available")
        }
    }

    private func field(_ label: String, @ViewBuilder content: () -> some View, @ViewBuilder trailing: () -> some View = { EmptyView() }) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                trailing()
                Spacer()
            }
            content()
        }
    }
}
