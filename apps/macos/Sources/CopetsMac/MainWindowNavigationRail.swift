import SwiftUI
import CorptieConversation

enum MainNavigationRailLayout {
    static func width(expanded: Bool) -> CGFloat { expanded ? 200 : 64 }

    static func expanded(after translation: CGFloat, currently expanded: Bool) -> Bool {
        if translation <= -32 { return false }
        if translation >= 32 { return true }
        return expanded
    }
}

/// A lightweight navigation column. Page hosts remain resident beside it.
struct MainWindowNavigationRail: View {
    @Binding var selection: AppTab
    @Binding var isExpanded: Bool

    var body: some View {
        PlatformNavigationRail(
            items: AppTab.allCases.map {
                PlatformNavigationItem(id: $0.rawValue, title: $0.title,
                                       symbol: $0.systemImage,
                                       accessibilityID: "main-tab.\($0.rawValue)")
            },
            selectedID: selection.rawValue,
            expanded: isExpanded,
            settingsTitle: L10n("设置"),
            settingsAccessibilityID: "main-window.settings",
            onSelect: { id in
                if let tab = AppTab(rawValue: id) { selection = tab }
            },
            onSettings: { AppDelegate.shared?.openSettings() }
        )
        .padding(.horizontal, 8)
        .padding(.top, MainWindowLayoutMetrics.titlebarHeight + 8)
        .padding(.bottom, 8)
        .frame(maxHeight: .infinity)
        .overlay(alignment: .trailing) {
            Color.clear
                .frame(width: 12)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 8).onEnded { value in
                    // Commit once at release: no page-wide layout on every pointer event.
                    isExpanded = MainNavigationRailLayout.expanded(
                        after: value.translation.width, currently: isExpanded)
                })
                .accessibilityElement()
                .accessibilityLabel("调整导航栏宽度")
                .accessibilityValue(isExpanded ? "已展开" : "已折叠")
                .accessibilityHint("向左拖动收起，向右拖动展开")
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: isExpanded = true
                    case .decrement: isExpanded = false
                    @unknown default: break
                    }
                }
                .accessibilityIdentifier("navigation-rail-resizer")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("navigation-rail")
    }

}
