import SwiftUI
import CorptieConversation

struct AppearanceSettingsView: View {
    @ObservedObject private var controller = ConversationSkinController.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
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
