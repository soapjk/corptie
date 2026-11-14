import SwiftUI
import CorptieConversation

// Role 详情页：承载 Profile、已安装 Skill、操作和 Memory。
// 角色管理页原位嵌入；其他入口保留独立展示。

/// Owned by the gallery while a role is edited, so collapsing, switching cards
/// or filtering the list never discards unsaved fields.
final class RoleEditDraft: ObservableObject {
    @Published var name: String
    @Published var detail: String
    @Published var systemPrompt: String
    @Published var selectedSkillIds: Set<String>

    init(agent: Role) {
        name = agent.name
        detail = agent.description
        systemPrompt = agent.systemPrompt
        selectedSkillIds = Set(agent.skillIds ?? [])
    }
}

struct RoleDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @EnvironmentObject private var router: AppTabRouter
    @Environment(\.dismiss) private var dismiss
    let agent: Role

    @StateObject private var draft: RoleEditDraft
    private let embedded: Bool
    private let onClose: (() -> Void)?
    @State private var showsAvatarPicker = false
    @State private var showSkillPicker = false
    @State private var showMcpManager = false
    @State private var isSaving = false
    @State private var saveError: String?
    @State private var showDeleteConfirm = false
    @State private var showSessionCreation = false
    @State private var assistRoleId: String?

    init(agent: Role, draft: RoleEditDraft? = nil, embedded: Bool = false, onClose: (() -> Void)? = nil) {
        self.agent = agent
        _draft = StateObject(wrappedValue: draft ?? RoleEditDraft(agent: agent))
        self.embedded = embedded
        self.onClose = onClose
    }

    private func close() {
        if let onClose { onClose() } else { dismiss() }
    }

    var body: some View {
        Group {
            if embedded {
                detailContent
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Button(L10n("Close")) { close() }.keyboardShortcut(.cancelAction)
                        Spacer()
                    }.padding(16)
                    Divider()
                    ScrollView { detailContent.padding(24) }
                }
                .frame(width: 760)
                .frame(minHeight: 580, idealHeight: 680)
            }
        }
        .alert(L10n("删除 角色"), isPresented: $showDeleteConfirm) {
            Button(L10n("删除"), role: .destructive) {
                Task { await client.deleteRole(roleId: agent.roleId) }
                close()
            }
            Button(L10n("取消"), role: .cancel) {}
        } message: {
            Text(L10n("删除后该 角色 的历史会话会解绑保留，但此操作不可撤销。"))
        }
        .sheet(isPresented: $showSessionCreation) {
            NewSessionCreationSheet(fixedAgent: agent) { session in
                close()
                router.openSession(session.id, source: .createdSession)
            }
        }
        .sheet(isPresented: $showSkillPicker) {
            RoleSkillPickerView(skills: client.skills, selectedSkillIds: draft.selectedSkillIds) { selection in
                draft.selectedSkillIds = selection
            }
        }
        .sheet(isPresented: $showMcpManager) {
            McpManagementView(roles: [agent], initialRoleId: agent.roleId)
        }
        .task {
            guard !embedded else { return }
            await client.refreshSkills()
            await client.refreshRoles()
            if let latest = client.roles.first(where: { $0.roleId == agent.roleId }) {
                draft.selectedSkillIds = Set(latest.skillIds ?? [])
            }
        }
        .onChange(of: client.skills.map(\.skillId)) { _, availableSkillIds in
            if !embedded { draft.selectedSkillIds.formIntersection(availableSkillIds) }
        }
    }

    private var detailContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            Divider()
            form
            Divider()
            actions
            deleteButton
            Divider()
            MemoryManagementView(scope: .owner(type: "agent", id: agent.roleId),
                                 embedsListInParentScrollView: true)
        }
    }

    // MARK: - 头部

    private var header: some View {
        HStack(spacing: 14) {
            agentAvatar
                .frame(width: 56, height: 56)
                .overlay(alignment: .bottomTrailing) {
                    Button {
                        showsAvatarPicker = true
                    } label: {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(4)
                            .background(Circle().fill(Color.black.opacity(0.55)))
                    }
                    .buttonStyle(.plain)
                    .help(L10n("设置头像"))
                    .accessibilityIdentifier("role-edit-avatar-picker")
                    .popover(isPresented: $showsAvatarPicker) {
                        RoleAvatarPicker(selectedPath: currentRole.resolvedAvatarPath) { path in
                            Task {
                                if await client.setRoleAvatar(roleId: agent.roleId, sourcePath: path) != nil {
                                    showsAvatarPicker = false
                                } else { saveError = client.errorMessage }
                            }
                        } upload: {
                            showsAvatarPicker = false
                            chooseAvatar()
                        }
                    }
                }

            VStack(alignment: .leading, spacing: 4) {
                Text(agent.name)
                    .font(.title3.bold())
                HStack(spacing: 8) {
                    Text(kindLabel)
                        .font(.caption)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(kindColor.opacity(0.15)))
                        .foregroundStyle(kindColor)
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
    private var currentRole: Role {
        client.roles.first(where: { $0.roleId == agent.roleId }) ?? agent
    }

    private var agentAvatar: some View {
        AnimatedAvatarImage(path: currentRole.resolvedAvatarPath)
            .clipShape(Circle())
    }

    // MARK: - 编辑表单

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            field(L10n("名称")) {
                VStack(alignment: .leading, spacing: 4) {
                    TextField(L10n("名称"), text: $draft.name).accessibilityIdentifier("role-editor-name")
                    EntityNameValidationMessage(value: draft.name)
                }
            }
            if agent.isPlatformAssistant {
                Text(L10n("这是 Corptie 内置的平台助手。它的提示词、Skill 和平台权限由应用管理，不能由用户修改。"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                field(L10n("描述")) {
                    TextField(L10n("描述"), text: $draft.detail).accessibilityIdentifier("role-editor-description")
                } trailing: {
                    AgentAssistButton(fieldLabel: "描述", text: $draft.detail, selectedRoleId: $assistRoleId, context: "角色 名称：\(draft.name)")
                }
                field("System Prompt") {
                    TextEditor(text: $draft.systemPrompt)
                        .font(.body)
                        .frame(height: 80)
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                } trailing: {
                    AgentAssistButton(fieldLabel: "System Prompt", text: $draft.systemPrompt, selectedRoleId: $assistRoleId, context: "角色 名称：\(draft.name)；描述：\(draft.detail)")
                }
                RoleInstalledSkillsView(
                    skills: client.skills,
                    selectedSkillIds: $draft.selectedSkillIds,
                    isEnabled: true,
                    onAdd: { showSkillPicker = true }
                )
                field("MCP") {
                    HStack {
                        Text(L10n("Manage MCP assignments, tool permissions, and credentials for this role."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button(L10n("Manage MCP")) { showMcpManager = true }
                            .accessibilityIdentifier("role-manage-mcp")
                    }
                }

            }
            if let saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - 操作

    private var actions: some View {
        HStack(spacing: 12) {
            Button {
                showSessionCreation = true
            } label: {
                Label(L10n("开始新会话"), systemImage: "bubble.left.and.bubble.right")
            }
            .buttonStyle(.bordered)

            Spacer()

            if let path = currentRole.avatarPath, !path.isEmpty, BuiltinRoleAvatarCatalog.id(from: path) == nil {
                Button(L10n("清除头像")) {
                    Task { if await client.clearRoleAvatar(roleId: agent.roleId) == nil { saveError = client.errorMessage } }
                }
                .buttonStyle(.bordered)
            }

            Button {
                Task {
                    isSaving = true
                    saveError = nil
                    let updated: Role?
                    if agent.isPlatformAssistant {
                        updated = await client.updateRole(
                            roleId: agent.roleId,
                            name: draft.name == agent.name ? nil : draft.name
                        )
                    } else {
                        updated = await client.updateRole(
                            roleId: agent.roleId,
                            name: draft.name == agent.name ? nil : draft.name,
                            description: draft.detail,
                            systemPrompt: draft.systemPrompt,
                            skillIds: Array(draft.selectedSkillIds)
                        )
                    }
                    isSaving = false
                    if updated != nil {
                        close()
                    } else {
                        saveError = client.errorMessage ?? L10n("保存失败。")
                    }
                }
            } label: {
                if isSaving {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text(L10n("保存中…"))
                    }
                } else {
                    Text(L10n("保存"))
                }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(isSaving || !(draft.name == agent.name || EntityNamePolicy.isValid(draft.name)))
        }
    }

    // 选择图片设置 Agent 头像（复制到后端托管目录）。
    private func chooseAvatar() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = AvatarImageSupport.allowedContentTypes
        if panel.runModal() == .OK, let url = panel.url {
            Task { if await client.setRoleAvatar(roleId: agent.roleId, sourcePath: url.path) == nil { saveError = client.errorMessage } }
        }
    }

    // MARK: - 删除（红色，底部）

    private var deleteButton: some View {
        Group {
            if !agent.isPlatformAssistant {
                HStack {
                    Spacer()
                    Button {
                        showDeleteConfirm = true
                    } label: {
                        Label(L10n("删除 角色"), systemImage: "trash")
                            .foregroundStyle(.red)
                    }
                }
            }
        }
    }

    // MARK: - 辅助

    private var kindLabel: String {
        L10n(agent.isPlatformAssistant ? "Platform managed" : "Role")
    }

    private var kindColor: Color {
        agent.isPlatformAssistant ? .purple : .blue
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
