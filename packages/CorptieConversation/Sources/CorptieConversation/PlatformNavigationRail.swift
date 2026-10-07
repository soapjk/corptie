import SwiftUI

public struct PlatformNavigationItem: Identifiable {
    public let id: String
    public let title: String
    public let symbol: String
    public let accessibilityID: String

    public init(id: String, title: String, symbol: String, accessibilityID: String) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.accessibilityID = accessibilityID
    }
}

/// The same element-sized vertical glass capsule on iPad and macOS. Hosts own
/// navigation state, window insets and edge-drag resizing.
public struct PlatformNavigationRail: View {
    public let items: [PlatformNavigationItem]
    public let selectedID: String
    public let expanded: Bool
    public let settingsTitle: String
    public let settingsAccessibilityID: String
    public let onSelect: (String) -> Void
    public let onSettings: () -> Void

    public init(items: [PlatformNavigationItem], selectedID: String, expanded: Bool,
                settingsTitle: String, settingsAccessibilityID: String,
                onSelect: @escaping (String) -> Void, onSettings: @escaping () -> Void) {
        self.items = items
        self.selectedID = selectedID
        self.expanded = expanded
        self.settingsTitle = settingsTitle
        self.settingsAccessibilityID = settingsAccessibilityID
        self.onSelect = onSelect
        self.onSettings = onSettings
    }

    public var body: some View {
        VStack(spacing: 12) {
            VStack(spacing: 2) {
                ForEach(items) { item in
                    let selected = item.id == selectedID
                    Button { onSelect(item.id) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: item.symbol)
                                .font(.system(size: 17, weight: selected ? .semibold : .medium))
                                .frame(width: 40, height: 40)
                            if expanded {
                                Text(item.title)
                                    .font(.system(size: 14, weight: selected ? .semibold : .medium))
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: expanded ? .leading : .center)
                        .padding(.horizontal, expanded ? 8 : 0)
                        .foregroundStyle(selected ? Color.accentColor : .secondary)
                        .background {
                            if selected {
                                Capsule().fill(Color.accentColor.opacity(0.12))
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(item.title)
                    .accessibilityLabel(item.title)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityValue(selected ? "selected" : "not-selected")
                    .accessibilityIdentifier(item.accessibilityID)
                }
            }
            .padding(5)
            .platformGlassSurface(in: Capsule(), variant: .clear)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("navigation-tab-capsule")

            Spacer(minLength: 0)

            Button(action: onSettings) {
                Image(systemName: "gearshape")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 48, height: 48)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .platformGlassSurface(in: Circle(), interactive: true, variant: .clear)
            .help(settingsTitle)
            .accessibilityLabel(settingsTitle)
            .accessibilityIdentifier(settingsAccessibilityID)
        }
        .frame(maxHeight: .infinity)
    }
}
