import SwiftUI
import CorptieConversation

enum MainNavigationRailLayout {
    static let width: CGFloat = 64
}

/// A lightweight navigation column. Page hosts remain resident beside it.
struct MainWindowNavigationRail: View {
    @Binding var selection: AppTab
    @AppStorage("ui.navigation.showLabels", store: CorptieAppEnvironment.userDefaults) private var showsLabels = false

    var body: some View {
        VStack(spacing: 8) {
            ForEach(AppTab.allCases.filter { $0 != .settings }) { tab in
                navigationButton(tab)
            }
            Spacer(minLength: 16)
            navigationButton(.settings)
        }
        .padding(.horizontal, 5)
        .padding(.top, MainWindowLayoutMetrics.titlebarHeight + 12)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WorkbenchStyle.navigationColor)
        .overlay(alignment: .topLeading) {
            CompactWindowControls()
                .frame(width: MainNavigationRailLayout.width, height: MainWindowLayoutMetrics.titlebarHeight)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("navigation-rail")
        .contextMenu {
            Toggle(L10n("显示导航文字"), isOn: $showsLabels)
        }
    }

    private func navigationButton(_ tab: AppTab) -> some View {
        Button { selection = tab } label: {
            HStack(spacing: 8) {
                Image(systemName: tab == .console ? "house" : tab.systemImage)
                    .font(.system(size: 16, weight: .regular))
                    .frame(width: 26, height: 32)
                if showsLabels {
                    Text(tab.title).font(.system(size: 12)).lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 32)
            .foregroundStyle(selection == tab ? Color.primary : Color.secondary)
            .background(selection == tab ? Color.primary.opacity(0.07) : .clear,
                        in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(tab.title)
        .accessibilityLabel(tab.title)
        .accessibilityAddTraits(selection == tab ? .isSelected : [])
        .accessibilityIdentifier(tab.navigationAccessibilityIdentifier)
    }
}
