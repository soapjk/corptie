import SwiftUI
import CorptieConversation

struct AppearanceSettingsView: View {
    @ObservedObject private var controller = ConversationSkinController.shared
    @AppStorage("ui.navigation.showLabels", store: CorptieAppEnvironment.userDefaults) private var showsNavigationLabels = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SettingsSectionHeading(title: L10n("Navigation and appearance"), mode: L10n("Takes effect immediately"))
                Toggle(L10n("显示导航文字"), isOn: $showsNavigationLabels)
                    .help(L10n("展开左侧导航名称，也可右键导航栏切换。"))
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Picker("界面风格", selection: Binding(get: { controller.skin }, set: { controller.select($0) })) {
                            Text("Codex 风格（默认）").tag(ConversationSkin.codexFlat)
                            Text("经典卡片").tag(ConversationSkin.classic)
                        }
                        .accessibilityIdentifier("appearance.conversationSkin")
                        Text("切换消息和面板的外观，保留现有布局与操作方式。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(8)
                }
                LocalWallpaperSettingsView()
                    .formStyle(.columns)
                Text("工作台使用纯色阅读背景；自定义背景仍用于其他页面。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .modifier(ConversationSkinHost())
    }
}
