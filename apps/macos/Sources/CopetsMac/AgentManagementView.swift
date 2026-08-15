import SwiftUI

// Agent 管理页面（顶层 Tab「Agents」）：列表 + 加号创建 + 右键打开详情（详情内增删改/启停/设为助手）。
// Agent 是低频变更的基础设施，单独一个 Tab 管理，控制台侧栏不再列出 Agent。
struct AgentManagementView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @State private var isCreatingAgent = false
    @State private var selectedAgentForDetail: Agent?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Agents")
                    .font(.title2.bold())
                Spacer()
                Button {
                    isCreatingAgent = true
                } label: {
                    Label("新建 Agent", systemImage: "plus")
                }
            }
            .padding()

            Divider()

            if client.isLoading && client.agents.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if client.agents.isEmpty {
                ContentUnavailableView(
                    "暂无 Agent",
                    systemImage: "person.2",
                    description: Text("点击右上角「新建 Agent」创建第一个")
                )
            } else {
                List(client.agents) { agent in
                    AgentRow(agent: agent)
                        .contextMenu {
                            Button("打开详情") {
                                selectedAgentForDetail = agent
                            }
                        }
                }
                .listStyle(.inset)
            }
        }
        .sheet(isPresented: $isCreatingAgent) {
            AgentCreateView()
        }
        .sheet(item: $selectedAgentForDetail) { agent in
            AgentDetailView(agent: agent)
        }
        .task {
            if client.agents.isEmpty {
                await client.refreshAgents()
            }
        }
    }
}
