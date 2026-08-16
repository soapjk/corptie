import SwiftUI

// Sessions 侧栏「新建会话」选择弹窗：列出所有 Assistant 类 Agent（会话只能由 Assistant 创建）。
// 选中后由调用方直接开新会话。若无任何 Assistant，展示引导提示。
struct NewChatPickerSheet: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss

    var onSelect: (Agent) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("新建会话"))
                .font(.title3.bold())

            if client.assistantAgents.isEmpty {
                ContentUnavailableView(
                    "暂无可用 Assistant",
                    systemImage: "sparkles",
                    description: Text(L10n("请先在 Agent 管理页创建一个 Assistant 类 Agent。"))
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Text(L10n("选择一个 Assistant 开始对话"))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                List(client.assistantAgents) { agent in
                    Button {
                        onSelect(agent)
                    } label: {
                        HStack(spacing: 12) {
                            Text(agent.name.prefix(1).uppercased())
                                .font(.headline)
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(Color.accentColor, in: Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                Text(agent.name)
                                    .font(.body.weight(.medium))
                                    .foregroundStyle(.primary)
                                if !agent.description.isEmpty {
                                    Text(agent.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.inset)
            }
        }
        .padding(20)
        .frame(width: 420, height: 360)
        .task {
            if client.agents.isEmpty {
                await client.refreshAgents()
            }
        }
    }
}
