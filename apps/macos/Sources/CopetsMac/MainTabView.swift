import SwiftUI

// 顶层 Tab 枚举：控制台 / Sessions / Agents / 设置
enum AppTab: String, CaseIterable, Identifiable {
    case console
    case sessions
    case agents
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .console: "控制台"
        case .sessions: "Sessions"
        case .agents: "Agents"
        case .settings: "设置"
        }
    }

    var systemImage: String {
        switch self {
        case .console: "square.grid.2x2"
        case .sessions: "bubble.left.and.bubble.right"
        case .agents: "person.2"
        case .settings: "gearshape"
        }
    }
}

// 主窗口顶层容器：顶部中间 Tab 切换器（控制台 / Sessions / Agents / 设置）+ 对应内容。
struct MainTabView: View {
    @StateObject private var router = AppTabRouter()

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $router.selectedTab) {
                ForEach(AppTab.allCases) { tab in
                    Label(tab.title, systemImage: tab.systemImage).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 480)
            .padding(.vertical, 8)

            Divider()

            switch router.selectedTab {
            case .console:
                WarRoomView()
            case .sessions:
                SessionsView()
            case .agents:
                AgentManagementView()
            case .settings:
                SettingsView()
            }
        }
        .environmentObject(router)
    }
}

// 跨 Tab 导航路由器：让「控制台 → 打开对话」能切到 Sessions Tab 并选中对应会话。
@MainActor
final class AppTabRouter: ObservableObject {
    @Published var selectedTab: AppTab = .console
    // 待选中的 session id：Sessions Tab 出现后消费它并清空。
    @Published var pendingSessionId: String?

    func openSession(_ sessionId: String) {
        pendingSessionId = sessionId
        selectedTab = .sessions
    }
}
