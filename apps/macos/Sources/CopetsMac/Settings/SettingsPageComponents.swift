import SwiftUI
import CorptieConversation

/// Settings owns its flat column paint; shared workbench cards are unchanged.
/// The viewport supplies geometry. Paint has no material, mask, or shadow pass.
struct SettingsColumnSurface: ViewModifier {
    var sidebar = false

    func body(content: Content) -> some View {
        content
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
            .background {
                (sidebar ? WorkbenchStyle.sidebarColor : WorkbenchStyle.canvas)
                    .ignoresSafeArea(.container, edges: .vertical)
            }
    }
}

struct SettingsSectionHeading: View {
    let title: String
    let mode: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(WorkbenchTypography.font(for: .sectionTitle))
            Text(mode).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
        }
    }
}

extension SettingsTab {
    @MainActor var groupTitle: String {
        switch self {
        case .general, .provider, .appearance, .notifications: L10n("Preferences")
        case .devices, .proxy, .gateway: L10n("Connections")
        case .archivedSessions: L10n("Management")
        }
    }

    var hasSharedSettings: Bool {
        switch self {
        case .general, .provider, .proxy, .gateway: true
        default: false
        }
    }

    @MainActor var saveExplanation: String {
        switch self {
        case .appearance, .notifications: L10n("Changes on this page take effect immediately.")
        case .devices, .archivedSessions: L10n("Actions on this page are applied immediately.")
        default: L10n("Save applies pending general, session defaults, proxy and trusted workspace settings. Other actions are saved separately.")
        }
    }
}
