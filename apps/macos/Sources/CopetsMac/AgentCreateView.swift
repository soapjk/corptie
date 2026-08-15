import SwiftUI

// Agent 创建表单（模块 B 升级）：预设模板 + 基本信息 + 底层模型 + 人设与能力。
// 侧栏 Agent 加号、AgentPickerView 的新建入口共用。

struct AgentCreateView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    /// 创建成功后的回调（如 AgentPickerView 用来把新 Agent 加入已选集合）。
    var onCreated: ((Agent) -> Void)? = nil

    @State private var selectedPresetId: String? = nil
    @State private var name = ""
    @State private var detail = ""
    @State private var role = "independentContributor"
    @State private var provider = "codex"
    @State private var systemPrompt = ""
    @State private var capabilitiesText = ""
    @State private var showAdvanced = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("创建 Agent")
                        .font(.title3.bold())

                    presetSection

                    field("名称 *") {
                        TextField("Agent 名称", text: $name)
                    }
                    field("职责描述") {
                        TextField("如：后端接口与数据库专家", text: $detail)
                    }

                    field("底层模型（Provider）") {
                        Picker("", selection: $provider) {
                            Text("Codex").tag("codex")
                            Text("Claude Code").tag("claude_code")
                            Text("DeepSeek").tag("deepseek")
                        }
                        .labelsHidden()
                        .frame(maxWidth: 200, alignment: .leading)
                    }

                    field("类型") {
                        Picker("", selection: $role) {
                            Text("独立贡献者（IC）").tag("independentContributor")
                            Text("助手（Assistant）").tag("assistant")
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

                    DisclosureGroup("高级选项", isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: 12) {
                            field("能力标签（逗号分隔）") {
                                TextField("如：backend, api, database", text: $capabilitiesText)
                            }
                        }
                        .padding(.top, 4)
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
                Button("取消") { dismiss() }
                Button("创建") {
                    create()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(16)
        }
        .frame(width: 500, height: 580)
    }

    // MARK: - 预设模板

    private var presetSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("预设模板")
                .font(.caption)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    presetChip(id: nil, label: "空白", icon: "square.dashed")
                    ForEach(AgentCreatePreset.all) { preset in
                        presetChip(id: preset.id, label: preset.name, icon: preset.icon)
                    }
                }
            }
        }
    }

    private func presetChip(id: String?, label: String, icon: String) -> some View {
        let isSelected = selectedPresetId == id
        return Button {
            selectPreset(id)
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

    private func selectPreset(_ id: String?) {
        selectedPresetId = id
        guard let preset = AgentCreatePreset.all.first(where: { $0.id == id }) else {
            detail = ""
            systemPrompt = ""
            capabilitiesText = ""
            provider = "codex"
            return
        }
        name = preset.suggestedName
        detail = preset.description
        provider = preset.provider
        systemPrompt = preset.systemPrompt
        capabilitiesText = preset.capabilities.joined(separator: ", ")
    }

    // MARK: - 创建

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
                provider: provider,
                systemPrompt: systemPrompt,
                capabilities: capabilities
            ) {
                onCreated?(agent)
                dismiss()
            }
        }
    }

    private func field(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            content()
        }
    }
}

// 预设模板：选一个自动填充创建表单。
struct AgentCreatePreset: Identifiable {
    let id: String
    let name: String
    let suggestedName: String
    let description: String
    let systemPrompt: String
    let capabilities: [String]
    let provider: String
    let icon: String

    static let all: [AgentCreatePreset] = [
        AgentCreatePreset(
            id: "backend", name: "后端开发", suggestedName: "后端开发",
            description: "负责后端接口、数据库与服务端逻辑",
            systemPrompt: "你是一名资深后端工程师，擅长 API 设计、数据库建模与服务端架构。产出健壮、可维护、带测试的代码，严格遵循项目既有规范。",
            capabilities: ["backend", "api", "database"], provider: "codex", icon: "server.rack"
        ),
        AgentCreatePreset(
            id: "frontend", name: "前端开发", suggestedName: "前端开发",
            description: "负责界面、交互与前端工程",
            systemPrompt: "你是一名资深前端工程师，擅长 UI 实现、状态管理与前端工程化。注重视觉还原度、可访问性与性能，产出整洁的组件化代码。",
            capabilities: ["frontend", "ui"], provider: "claude_code", icon: "paintbrush"
        ),
        AgentCreatePreset(
            id: "fullstack", name: "全栈", suggestedName: "全栈工程师",
            description: "端到端交付功能，前后端都能上手",
            systemPrompt: "你是一名全栈工程师，能独立完成从前端交互到后端接口再到数据库的完整链路。优先保证功能闭环，再逐步优化架构与性能。",
            capabilities: ["backend", "frontend", "fullstack"], provider: "codex", icon: "square.stack"
        ),
        AgentCreatePreset(
            id: "qa", name: "测试", suggestedName: "测试工程师",
            description: "负责测试用例、自动化与质量把关",
            systemPrompt: "你是一名测试工程师，擅长设计测试用例、编写自动化测试并定位缺陷。关注边界条件与回归风险，输出清晰可复现的问题报告。",
            capabilities: ["testing", "qa"], provider: "codex", icon: "checkmark.seal"
        ),
        AgentCreatePreset(
            id: "review", name: "代码审查", suggestedName: "代码审查",
            description: "负责代码审查、风险与规范把关",
            systemPrompt: "你是一名严格的代码审查者，聚焦正确性、安全性、可维护性与性能。指出具体问题并给出可执行的改进建议，而非泛泛而谈。",
            capabilities: ["code-review"], provider: "claude_code", icon: "eye"
        )
    ]
}
