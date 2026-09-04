import SwiftUI

// Agent 辅助填写按钮：放在长文本输入框（描述/验收标准/系统提示词等）标签旁，
// 点击后弹出意图输入框，调用后端 /assist/draft（provider-neutral 后台 Agent）生成文本，
// 用户可预览并「采纳」回填到绑定的字段。
//
// 用法示例：
//   AgentAssistButton(fieldLabel: "描述", text: $detail,
//                     selectedAgentId: $assistAgentId, context: "目标名称：\(name)")
//
// 组件无 provider 依赖，后端统一走 BackgroundAgentService（BACKGROUND_PROMPT 能力）。

struct AgentAssistButton: View {
    let fieldLabel: String
    @Binding var text: String
    /// 同一创建页面上的辅助填写入口共享此选择，避免重复选择 Agent。
    @Binding var selectedAgentId: String?
    /// 额外的上下文说明（如名称、已选仓库），会拼进 prompt 帮助 Agent 理解。
    var context: String = ""
    /// 可选的 workspace 路径，作为后台 Agent 的运行目录（用于读取仓库上下文）。
    var cwd: String? = nil

    @ObservedObject private var client = EntityAPIClient.shared

    @State private var isPresented = false
    @State private var intent = ""
    @State private var isGenerating = false
    @State private var draft = ""
    @State private var errorText: String?
    @State private var showAgentPicker = false

    var body: some View {
        Button {
            intent = ""
            draft = ""
            errorText = nil
            isPresented = true
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "sparkles")
                Text(L10n("帮我写"))
            }
            .font(.caption)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.tint)
        .popover(isPresented: $isPresented, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 12) {
                Text(L10nFormat("Ask an Agent to write “%@”", fieldLabel))
                    .font(.headline)

                if isGenerating {
                    VStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text(L10n("正在生成…"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                } else if !draft.isEmpty {
                    Text(L10n("生成结果（可编辑后采纳）"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $draft)
                        .font(.body)
                        .frame(height: 120)
                        .scrollContentBackground(.hidden)
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))

                    HStack {
                        Spacer()
                        Button(L10n("重新生成")) {
                            generate()
                        }
                        Button(L10n("采纳")) {
                            text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                            isPresented = false
                        }
                        .keyboardShortcut(.defaultAction)
                    }
                } else {
                    Text(L10n("简单描述你想让 Agent 填写的内容，例如："))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(L10n("「把 Corptie 的工作台拆成三个模块，说明重构目标和验收标准」"))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.bottom, 4)

                    TextEditor(text: $intent)
                        .font(.body)
                        .frame(height: 80)
                        .scrollContentBackground(.hidden)
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.2), lineWidth: 1))

                    // 指定生成 Agent（单选）；不选则用默认 provider。
                    HStack(spacing: 6) {
                        Image(systemName: "person.crop.circle.badge.checkmark")
                            .foregroundStyle(.secondary)
                        Button {
                            showAgentPicker = true
                        } label: {
                            HStack(spacing: 4) {
                                Text(selectedAgentName ?? L10n("Select an Agent"))
                                    .foregroundStyle(selectedAgentName == nil ? .secondary : .primary)
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.borderless)
                        if selectedAgentId != nil {
                            Button {
                                selectedAgentId = nil
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)
                            .help(L10n("清除，使用默认 Agent"))
                        }
                    }

                    if let errorText {
                        Text(errorText)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }

                    HStack {
                        Spacer()
                        Button(L10n("取消")) { isPresented = false }
                        Button(L10n("生成")) { generate() }
                            .keyboardShortcut(.defaultAction)
                            .disabled(intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .padding(16)
            .frame(width: 380)
            .sheet(isPresented: $showAgentPicker) {
                AgentSinglePickerView(selectedId: $selectedAgentId)
            }
            .onAppear {
                Task {
                    if client.agents.isEmpty { await client.refreshAgents() }
                }
            }
        }
    }

    private var selectedAgentName: String? {
        guard let selectedAgentId else { return nil }
        return client.agents.first { $0.agentId == selectedAgentId }?.name
    }

    private func generate() {
        let trimmedIntent = intent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedIntent.isEmpty else { return }

        var prompt = trimmedIntent
        let trimmedContext = context.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedContext.isEmpty {
            prompt += "\n\n现有上下文：\n\(trimmedContext)"
        }
        // 若字段已有内容，说明是在现有基础上润色/扩写。
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedText.isEmpty {
            prompt += "\n\n该字段当前已有草稿，请在其基础上完善：\n\(trimmedText)"
        }

        isGenerating = true
        errorText = nil
        Task {
            if let result = await client.assistDraft(fieldLabel: fieldLabel, prompt: prompt, cwd: cwd, agentId: selectedAgentId) {
                draft = result
            } else {
                errorText = client.errorMessage ?? "生成失败，请稍后重试。"
            }
            isGenerating = false
        }
    }
}
