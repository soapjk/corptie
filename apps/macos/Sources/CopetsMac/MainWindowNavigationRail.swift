import SwiftUI
import CorptieConversation

enum MainNavigationRailLayout {
    static let width: CGFloat = 64
}

/// A lightweight navigation column. Page hosts remain resident beside it.
struct MainWindowNavigationRail: View {
    @Binding var selection: AppTab

    var body: some View {
        PlatformNavigationRail(
            items: AppTab.allCases.filter { $0 != .settings }.map {
                PlatformNavigationItem(id: $0.rawValue, title: $0.title,
                                       symbol: $0.systemImage,
                                       accessibilityID: "main-tab.\($0.rawValue)")
            },
            selectedID: selection.rawValue,
            expanded: false,
            settingsSelected: selection == .settings,
            settingsTitle: L10n("设置"),
            settingsAccessibilityID: "main-window.settings",
            onSelect: { id in
                if let tab = AppTab(rawValue: id) { selection = tab }
            },
            onSettings: { selection = .settings }
        )
        .padding(.horizontal, 8)
        .padding(.top, MainWindowLayoutMetrics.titlebarHeight + 8)
        .padding(.bottom, 8)
        .frame(maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("navigation-rail")
    }

}
