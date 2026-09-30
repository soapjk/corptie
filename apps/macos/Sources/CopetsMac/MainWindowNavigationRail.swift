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
        VStack(spacing: 4) {
            VStack(spacing: 4) {
                ForEach(AppTab.allCases) { tab in
                    Button { selection = tab } label: {
                        label(symbol: tab.systemImage, title: tab.title, selected: selection == tab)
                    }
                    .buttonStyle(.plain)
                    .help(tab.title)
                    .accessibilityLabel(tab.title)
                    .accessibilityAddTraits(selection == tab ? .isSelected : [])
                    .accessibilityIdentifier("main-tab.\(tab.rawValue)")
                    .accessibilityValue(selection == tab ? "selected" : "not-selected")
                }
            }
            .padding(4)
            .background {
                RoundedRectangle(cornerRadius: isExpanded ? 20 : 24, style: .continuous)
                    .fill(Color(nsColor: .controlBackgroundColor))
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("navigation-tab-capsule")
            Spacer(minLength: 12)
            Button { AppDelegate.shared?.openSettings() } label: {
                label(symbol: "gearshape", title: L10n("设置"), selected: false)
            }
            .buttonStyle(.plain)
            .help(L10n("设置"))
            .accessibilityLabel(L10n("设置"))
            .accessibilityIdentifier("main-window.settings")
        }
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

    private func label(symbol: String, title: String, selected: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 19, weight: selected ? .semibold : .regular))
                .frame(width: 32, height: 40)
            if isExpanded {
                Text(title).font(.system(size: 14, weight: selected ? .semibold : .regular)).lineLimit(1)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, isExpanded ? 8 : 0)
        .frame(maxWidth: .infinity, minHeight: 44)
        .foregroundStyle(selected ? Color.accentColor : .secondary)
        .background {
            RoundedRectangle(cornerRadius: isExpanded ? 12 : 22)
                .fill(selected ? Color.accentColor.opacity(0.10) : .clear)
        }
        .contentShape(Rectangle())
    }
}
