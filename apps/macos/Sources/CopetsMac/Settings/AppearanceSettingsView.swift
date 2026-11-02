import SwiftUI
import CorptieConversation

struct AppearanceSettingsView: View {
    @ObservedObject private var controller = ConversationSkinController.shared
    @AppStorage("ui.navigation.showLabels", store: CorptieAppEnvironment.userDefaults) private var showsNavigationLabels = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Toggle(L10n("显示导航文字"), isOn: $showsNavigationLabels)
                .help(L10n("展开左侧导航名称，也可右键导航栏切换。"))
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    Picker("界面风格", selection: Binding(get: { controller.skin }, set: { controller.select($0) })) {
                        Text("经典卡片").tag(ConversationSkin.classic)
                        Text("Codex 风格").tag(ConversationSkin.codexFlat)
                    }
                    .accessibilityIdentifier("appearance.conversationSkin")
                    Text("切换消息和面板的外观，保留现有布局与操作方式。")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(8)
            }
            LocalWallpaperSettingsView()
        }
        .padding(16)
        .modifier(ConversationSkinHost())
    }
}
