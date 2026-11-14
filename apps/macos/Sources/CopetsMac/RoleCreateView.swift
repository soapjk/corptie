import SwiftUI
import CorptieConversation

enum RoleCreateSubmissionPolicy {
    static func submitsInBackground(requiresCreatedRole: Bool) -> Bool {
        !requiresCreatedRole
    }
}

// Agent 创建表单：从已有 Agent 继承 + 基本信息 + 人设与专长。
// 侧栏 Agent 加号、AgentPickerView 的新建入口共用。

struct RoleCreateView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    /// 创建成功后的回调（如 AgentPickerView 用来把新 Agent 加入已选集合）。
    var onCreated: ((Role) -> Void)? = nil

    @StateObject private var avatarSelection = RoleAvatarSelection()
    @State private var showsAvatarPicker = false
    @State private var selectedBaseAgentId: String? = nil
    @State private var name = ""
    @State private var detail = ""
    @State private var systemPrompt = ""
    @State private var capabilitiesText = ""
    @State private var workDir = ""
    @State private var showAdvanced = false
    @State private var submission = RoleCreationSubmission()

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(L10n("创建 角色"))
                        .font(.title3.bold())

                    FormAssistPanel(
                        formType: .agent,
                        promptHint: L10n("例如：创建一名负责 SwiftUI 客户端、重视测试和兼容性的 角色。"),
                        currentValues: {
                            [
                                "name": name,
                                "description": detail,
                                "systemPrompt": systemPrompt,
                                "capabilities": capabilitiesText
                            ]
                        },
                        onApply: applyGeneratedFields
                    )

                    HStack(spacing: 12) {
                        AnimatedAvatarImage(path: avatarSelection.path, animates: false)
                            .frame(width: 56, height: 56).clipShape(Circle())
                            .accessibilityIdentifier("role-create-avatar-preview")
                        Button(L10n("选择头像")) { showsAvatarPicker = true }
                            .accessibilityIdentifier("role-create-avatar-picker")
                            .popover(isPresented: $showsAvatarPicker) {
                                RoleAvatarPicker(selectedPath: avatarSelection.path) { path in
                                    avatarSelection.path = path
                                    showsAvatarPicker = false
                                } upload: {
                                    showsAvatarPicker = false
                                    chooseAvatar()
                                }
                            }
                    }

                    presetSection

                    field(L10n("名称 *")) {
                        VStack(alignment: .leading, spacing: 4) {
                            TextField(L10n("角色 名称"), text: $name).accessibilityIdentifier("role-create-name")
                            EntityNameValidationMessage(value: name)
                        }
                    }
                    field(L10n("职责描述")) {
                        TextField(L10n("如：后端接口与数据库专家"), text: $detail).accessibilityIdentifier("role-create-description")
                    }

                    field("System Prompt") {
                        TextEditor(text: $systemPrompt)
                            .font(.body)
                            .frame(height: 90)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))
                    }

                    // 高级选项：整行可点击展开/折叠（替代 DisclosureGroup，避免 macOS 下只能点小三角才能展开）。
                    VStack(alignment: .leading, spacing: 8) {
                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) { showAdvanced.toggle() }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "chevron.right")
                                    .font(.caption2.bold())
                                    .rotationEffect(.degrees(showAdvanced ? 90 : 0))
                                Text(L10n("高级选项"))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if showAdvanced {
                            VStack(alignment: .leading, spacing: 12) {
                                field(L10n("专长标签（逗号分隔）")) {
                                    TextField(L10n("如：backend, api, database"), text: $capabilitiesText)
                                }

                                field(L10n("工作目录（可选）")) {
                                    TextField(L10n("留空则为此 角色 自动生成独立目录"), text: $workDir)
                                }
                            }
                            .padding(.top, 4)
                        }
                    }
                }
                .padding(24)
            }

            Divider()

            HStack {
                if let error = client.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
                Spacer()
                Button(L10n("取消")) { dismiss() }
                Button(L10n("创建")) {
                    create()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    !EntityNamePolicy.isValid(name) || submission.isSubmitting
                )
            }
            .padding(16)
        }
        .frame(width: 500)
        .frame(minHeight: 460, maxHeight: 680)
        .task {
            if client.roles.isEmpty {
                await client.refreshRoles()
            }
        }
    }

    // MARK: - 从已有 Agent 继承

    private var presetSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n("从已有 角色 继承（可选）"))
                .font(.caption)
                .foregroundStyle(.secondary)
            if client.roles.isEmpty {
                Text(L10n("暂无已有 角色，可直接填写下方信息。"))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        baseAgentChip(id: nil, label: "不继承", icon: "square.dashed")
                        ForEach(client.roles) { agent in
                            baseAgentChip(id: agent.roleId, label: agent.name, icon: agent.isPlatformAssistant ? "sparkles" : "person.crop.circle")
                        }
                    }
                }
            }
        }
    }

    private func baseAgentChip(id: String?, label: String, icon: String) -> some View {
        let isSelected = selectedBaseAgentId == id
        return Button {
            selectBaseRole(id)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: icon)
                Text(label)
            }
            .font(.callout)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().fill(isSelected ? Color.accentColor.opacity(0.18) : Color(nsColor: .quaternaryLabelColor).opacity(0.4)))
            .overlay(Capsule().strokeBorder(isSelected ? Color.accentColor : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.borderless)
    }

    private func selectBaseRole(_ id: String?) {
        selectedBaseAgentId = id
        guard let base = client.roles.first(where: { $0.roleId == id }) else {
            name = ""
            detail = ""
            systemPrompt = ""
            capabilitiesText = ""
            workDir = ""
            return
        }
        name = base.name
        detail = base.description
        systemPrompt = base.systemPrompt
        capabilitiesText = base.capabilities.joined(separator: ", ")
        workDir = base.workDir ?? ""
    }

    // MARK: - 创建

    private func applyGeneratedFields(_ fields: [String: String]) {
        name = fields["name"] ?? name
        detail = fields["description"] ?? detail
        systemPrompt = fields["systemPrompt"] ?? systemPrompt
        capabilitiesText = fields["capabilities"] ?? capabilitiesText
        if !capabilitiesText.isEmpty { showAdvanced = true }
    }

    private func create() {
        guard EntityNamePolicy.isValid(name) else { return }
        let validatedName = name
        guard let idempotencyKey = submission.begin() else { return }
        let capabilities = capabilitiesText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let requestAvatarPath = avatarSelection.path
        let requestDescription = detail
        let requestSystemPrompt = systemPrompt
        let trimmedWorkDir = workDir.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestWorkDir = trimmedWorkDir.isEmpty ? nil : trimmedWorkDir

        if RoleCreateSubmissionPolicy.submitsInBackground(requiresCreatedRole: onCreated != nil) {
            let taskId = "agent.create:\(idempotencyKey)"
            let started = BackgroundTaskCenter.shared.start(
                id: taskId,
                title: L10nFormat("创建 角色：%@", validatedName)
            ) {
                guard await client.createRole(
                    name: validatedName,
                    description: requestDescription,
                    systemPrompt: requestSystemPrompt,
                    capabilities: capabilities,
                    workDir: requestWorkDir,
                    avatarPath: requestAvatarPath,
                    idempotencyKey: idempotencyKey
                ) != nil else {
                    return .failure(client.errorMessage ?? L10n("角色 创建失败，可重试。"))
                }
                return .success(L10nFormat("角色“%@”已创建。", validatedName))
            }
            if started { dismiss() }
            return
        }

        Task {
            if let agent = await client.createRole(
                name: validatedName,
                description: requestDescription,
                systemPrompt: requestSystemPrompt,
                capabilities: capabilities,
                workDir: requestWorkDir,
                avatarPath: requestAvatarPath,
                idempotencyKey: idempotencyKey
            ) {
                onCreated?(agent)
                dismiss()
            } else {
                submission.finishAfterFailure()
            }
        }
    }

    private func chooseAvatar() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = AvatarImageSupport.allowedContentTypes
        if panel.runModal() == .OK, let url = panel.url { avatarSelection.path = url.path }
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
