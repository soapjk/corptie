import SwiftUI

// Role 详情页：承载 Profile、操作和 Memory。
// 从侧栏 Agent 右键「打开详情」进入（sheet 弹窗）。

struct RoleDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @EnvironmentObject private var router: AppTabRouter
    @Environment(\.dismiss) private var dismiss
    let agent: Role

    @State private var name: String
    @State private var detail: String
    @State private var systemPrompt: String
    @State private var isSaving = false
    @State private var saveError: String?
    @State private var showDeleteConfirm = false
    @State private var showSessionCreation = false
    @State private var assistRoleId: String?

    init(agent: Role) {
        self.agent = agent
        _name = State(initialValue: agent.name)
        _detail = State(initialValue: agent.description)
        _systemPrompt = State(initialValue: agent.systemPrompt)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 22, height: 22)
                        .background(Color.secondary.opacity(0.16), in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help(L10n("Close"))
                .accessibilityLabel(L10n("Close"))
                Spacer()
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 14)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    Divider()
                    form
                    Divider()
                    actions
                    deleteButton
                    Divider()
                    MemoryManagementView(
                        scope: .owner(type: "agent", id: agent.roleId),
                        embedsListInParentScrollView: true
                    )
                }
                .padding(24)
            }
        }
        .frame(width: 760)
        .frame(minHeight: 580, idealHeight: 680)
        .alert(L10n("删除 角色"), isPresented: $showDeleteConfirm) {
            Button(L10n("删除"), role: .destructive) {
                Task { await client.deleteRole(roleId: agent.roleId) }
                dismiss()
            }
            Button(L10n("取消"), role: .cancel) {}
        } message: {
            Text(L10n("删除后该 角色 的历史会话会解绑保留，但此操作不可撤销。"))
        }
        .sheet(isPresented: $showSessionCreation) {
            NewSessionCreationSheet(fixedAgent: agent) { session in
                dismiss()
                router.openSession(session.id, source: .createdSession)
            }
        }

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
    private var agentAvatar: some View {
        Group {
            if let avatarPath = client.roles.first(where: { $0.roleId == agent.roleId })?.avatarPath ?? agent.avatarPath,
               !avatarPath.isEmpty {
                AnimatedAvatarImage(path: avatarPath)
            } else {
                DefaultInitialAvatarView(
                    familySeed: agent.name,
                    variationSeed: agent.roleId,
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
                VStack(alignment: .leading, spacing: 4) {
                    TextField(L10n("名称"), text: $name)
                    EntityNameValidationMessage(value: name)
                }
            }
            if agent.isPlatformAssistant {
                Text(L10n("这是 Corptie 内置的平台助手。它的提示词、Skill 和平台权限由应用管理，不能由用户修改。"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                field(L10n("描述")) {
                    TextField(L10n("描述"), text: $detail)
                } trailing: {
                    AgentAssistButton(fieldLabel: "描述", text: $detail, selectedRoleId: $assistRoleId, context: "角色 名称：\(name)")
                }
                field("System Prompt") {
                    TextEditor(text: $systemPrompt)
                        .font(.body)
                        .frame(height: 80)
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                } trailing: {
                    AgentAssistButton(fieldLabel: "System Prompt", text: $systemPrompt, selectedRoleId: $assistRoleId, context: "角色 名称：\(name)；描述：\(detail)")
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

            if client.roles.first(where: { $0.roleId == agent.roleId })?.avatarPath ?? agent.avatarPath != nil {
                Button(L10n("清除头像")) {
                    Task { await client.clearRoleAvatar(roleId: agent.roleId) }
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
                            name: name == agent.name ? nil : name
                        )
                    } else {
                        updated = await client.updateRole(
                            roleId: agent.roleId,
                            name: name == agent.name ? nil : name,
                            description: detail,
                            systemPrompt: systemPrompt
                        )
                    }
                    isSaving = false
                    if updated != nil {
                        dismiss()
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
            .disabled(isSaving || !(name == agent.name || EntityNamePolicy.isValid(name)))
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
            Task { await client.setRoleAvatar(roleId: agent.roleId, sourcePath: url.path) }
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
