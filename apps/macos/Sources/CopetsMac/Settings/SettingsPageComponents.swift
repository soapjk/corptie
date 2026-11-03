import SwiftUI
import CorptieConversation

/// Settings-local surface. Other workbench cards retain their existing appearance.
struct SettingsSurface: ViewModifier {
    var sidebar = false
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: MainWindowPageLayoutMetrics.cardCornerRadius)
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(sidebar ? WorkbenchStyle.sidebarColor : WorkbenchStyle.canvas, in: shape)
            .clipShape(shape)
            .overlay {
                shape.strokeBorder(Color.primary.opacity(contrast == .increased
                    ? MainWindowPageLayoutMetrics.increasedContrastCardBorderOpacity
                    : MainWindowPageLayoutMetrics.cardBorderOpacity), lineWidth: contrast == .increased
                    ? MainWindowPageLayoutMetrics.increasedContrastCardBorderWidth
                    : MainWindowPageLayoutMetrics.cardBorderWidth)
                    .allowsHitTesting(false)
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
