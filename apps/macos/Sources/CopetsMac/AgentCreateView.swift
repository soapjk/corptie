import SwiftUI

// Agent 创建表单（模块 B 升级）：从已有 Agent 继承 + 基本信息 + 底层模型 + 人设与能力。
// 侧栏 Agent 加号、AgentPickerView 的新建入口共用。

struct AgentCreateView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    /// 创建成功后的回调（如 AgentPickerView 用来把新 Agent 加入已选集合）。
    var onCreated: ((Agent) -> Void)? = nil

    @State private var selectedBaseAgentId: String? = nil
    @State private var name = ""
    @State private var detail = ""
    @State private var role = "independentContributor"
    @State private var systemPrompt = ""
    @State private var capabilitiesText = ""
    @State private var workDir = ""
    @State private var showAdvanced = false
    @State private var selectedSkillIds: Set<String> = []
    @State private var showSkillRegister = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(L10n("创建 Agent"))
                        .font(.title3.bold())

                    FormAssistPanel(
                        formType: .agent,
                        promptHint: L10n("例如：创建一名负责 SwiftUI 客户端、重视测试和兼容性的独立贡献者。"),
                        currentValues: {
                            [
                                "name": name,
                                "description": detail,
                                "role": role,
                                "systemPrompt": systemPrompt,
                                "capabilities": capabilitiesText
                            ]
                        },
                        onApply: applyGeneratedFields
                    )

                    presetSection

                    field(L10n("名称 *")) {
                        TextField(L10n("Agent 名称"), text: $name)
                    }
                    field(L10n("职责描述")) {
                        TextField(L10n("如：后端接口与数据库专家"), text: $detail)
                    }

                    field(L10n("类型")) {
                        Picker("", selection: $role) {
                            Text(L10n("独立贡献者（IC）")).tag("independentContributor")
                            Text(L10n("助手（Assistant）")).tag("assistant")
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 360, alignment: .leading)
                    }

                    Text(role == "assistant"
                         ? "助手负责与你直接对话，承接平台元操作。"
                         : "独立贡献者负责项目开发与生产。")
                        .font(.caption)
                        .foregroundStyle(.secondary)

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
                                field(L10n("能力标签（逗号分隔）")) {
                                    TextField(L10n("如：backend, api, database"), text: $capabilitiesText)
                                }

                                field(L10n("工作目录（可选）")) {
                                    TextField(L10n("留空则自动生成（每个助手独立，贡献者为持久化目录）"), text: $workDir)
                                }

                                skillSection
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
                    name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
            .padding(16)
        }
        .frame(width: 500)
        .frame(minHeight: 460, maxHeight: 680)
        .task {
            if client.agents.isEmpty {
                await client.refreshAgents()
            }
            if client.skills.isEmpty {
                await client.refreshSkills()
            }
        }
        .sheet(isPresented: $showSkillRegister) {
            SkillRegisterView { skill in
                if let skill { selectedSkillIds.insert(skill.skillId) }
            }
        }
        .onChange(of: client.skills.map(\.skillId)) { _, availableSkillIds in
            selectedSkillIds.formIntersection(availableSkillIds)
        }
    }

    // MARK: - 从已有 Agent 继承

    private var presetSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n("从已有 Agent 继承（可选）"))
                .font(.caption)
                .foregroundStyle(.secondary)
            if client.agents.isEmpty {
                Text(L10n("暂无已有 Agent，可直接填写下方信息。"))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        baseAgentChip(id: nil, label: "不继承", icon: "square.dashed")
                        ForEach(client.agents) { agent in
                            baseAgentChip(id: agent.agentId, label: agent.name, icon: agent.isAssistant ? "person.crop.circle.badge.checkmark" : "person.crop.circle")
                        }
                    }
                }
            }
        }
    }

    private func baseAgentChip(id: String?, label: String, icon: String) -> some View {
        let isSelected = selectedBaseAgentId == id
        return Button {
            selectBaseAgent(id)
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

    private func selectBaseAgent(_ id: String?) {
        selectedBaseAgentId = id
        guard let base = client.agents.first(where: { $0.agentId == id }) else {
            name = ""
            detail = ""
            systemPrompt = ""
            capabilitiesText = ""
            workDir = ""
            role = "independentContributor"
            selectedSkillIds = []
            return
        }
        name = base.name
        detail = base.description
        role = base.role.isEmpty ? "independentContributor" : base.role
        systemPrompt = base.systemPrompt
        capabilitiesText = base.capabilities.joined(separator: ", ")
        workDir = base.workDir ?? ""
        selectedSkillIds = Set(base.skillIds ?? [])
    }

    // MARK: - Skill 预装

    private var skillSection: some View {
        AgentSkillSelectionView(
            skills: client.skills,
            selectedSkillIds: $selectedSkillIds,
            isEnabled: true,
            onRegister: { showSkillRegister = true }
        )
    }

    // MARK: - 创建

    private func applyGeneratedFields(_ fields: [String: String]) {
        name = fields["name"] ?? name
        detail = fields["description"] ?? detail
        role = fields["role"] ?? role
        systemPrompt = fields["systemPrompt"] ?? systemPrompt
        capabilitiesText = fields["capabilities"] ?? capabilitiesText
        if !capabilitiesText.isEmpty { showAdvanced = true }
    }

    private func create() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let capabilities = capabilitiesText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        Task {
            if let agent = await client.createAgent(
                name: trimmed,
                description: detail,
                role: role,
                systemPrompt: systemPrompt,
                capabilities: capabilities,
                skillIds: Array(selectedSkillIds),
                workDir: workDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : workDir.trimmingCharacters(in: .whitespacesAndNewlines)
            ) {
                onCreated?(agent)
                dismiss()
            }
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
