import SwiftUI

// Agent 详情页（模块 B）：承载重命名/编辑/设置/启停/设为助手/删除等低频管理操作。
// 从侧栏 Agent 右键「打开详情」进入（sheet 弹窗）。

struct AgentDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let agent: Agent

    @State private var name: String
    @State private var detail: String
    @State private var provider: String
    @State private var systemPrompt: String
    @State private var showDeleteConfirm = false

    init(agent: Agent) {
        self.agent = agent
        _name = State(initialValue: agent.name)
        _detail = State(initialValue: agent.description)
        _provider = State(initialValue: agent.provider ?? "")
        _systemPrompt = State(initialValue: agent.systemPrompt)
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
        .alert("删除 Agent", isPresented: $showDeleteConfirm) {
            Button("删除", role: .destructive) {
                Task { await client.deleteAgent(agentId: agent.agentId) }
                dismiss()
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("删除后该 Agent 的历史会话会解绑保留，但此操作不可撤销。")
        }
    }

    // MARK: - 头部

    private var header: some View {
        HStack(spacing: 14) {
            DefaultInitialAvatarView(
                familySeed: agent.name,
                variationSeed: agent.agentId,
                initials: DefaultAvatarInitials.make(from: agent.name),
                size: 44
            )
            .frame(width: 56, height: 56)

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
            }
            Spacer()
        }
    }

    // MARK: - 编辑表单

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("名称") {
                TextField("名称", text: $name)
            }
            field("描述") {
                TextField("描述", text: $detail)
            }
            field("Provider") {
                Picker("", selection: $provider) {
                    Text("无").tag("")
                    Text("Claude Code").tag("claude_code")
                    Text("Codex").tag("codex")
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
            }
        }
    }

    // MARK: - 操作

    private var actions: some View {
        HStack(spacing: 12) {
            Button(agent.status == "available" ? "停用" : "启用") {
                let next = agent.status == "available" ? "inactive" : "available"
                Task { await client.updateAgent(agentId: agent.agentId, status: next) }
            }
            if agent.isIndependentContributor {
                Button("设为助手") {
                    Task { await client.updateAgent(agentId: agent.agentId, role: "assistant") }
                }
            } else {
                Button("设为独立贡献者") {
                    Task { await client.updateAgent(agentId: agent.agentId, role: "independentContributor") }
                }
            }
            Spacer()
            Button("保存") {
                Task {
                    await client.updateAgent(
                        agentId: agent.agentId,
                        name: name,
                        description: detail,
                        provider: provider.isEmpty ? nil : provider,
                        systemPrompt: systemPrompt
                    )
                }
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
        }
    }

    // MARK: - 删除（红色，底部）

    private var deleteButton: some View {
        HStack {
            Spacer()
            Button {
                showDeleteConfirm = true
            } label: {
                Label("删除 Agent", systemImage: "trash")
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - 辅助

    private var roleLabel: String {
        agent.isAssistant ? "助手" : "独立贡献者"
    }

    private var roleColor: Color {
        agent.isAssistant ? .purple : .blue
    }

    private var statusLabel: String {
        switch agent.status {
        case "available": "可用"
        case "busy": "忙碌"
        case "offline": "离线"
        case "inactive": "已停用"
        default: agent.status
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
