import SwiftUI

/// A compositor-only press response shared by every top-level navigation tab.
/// Keeping it in the shared package makes macOS, iPad and compact mobile tabs
/// feel identical without introducing timers or page-level animation state.
public struct PlatformTabButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.94 : 1)
            .opacity(configuration.isPressed ? 0.76 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

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

/// Groups only the navigation chrome, never the resident page hierarchy.
public struct PlatformNavigationGlassContainer<Content: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let content: Content

    public init(@ViewBuilder content: () -> Content) { self.content = content() }

    @ViewBuilder public var body: some View {
        if #available(iOS 26.0, macOS 26.0, *), !reduceTransparency {
            GlassEffectContainer(spacing: 8) { content }
        } else { content }
    }
}

/// One native glass shape exists for the selected tab, shared by all layouts.
/// Its stable effect identity allows the system to move/morph the capsule.
public struct PlatformTabSelectionIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let namespace: Namespace.ID

    public init(namespace: Namespace.ID) { self.namespace = namespace }

    public var body: some View {
        Group {
            if #available(iOS 26.0, macOS 26.0, *), !reduceTransparency {
                Color.clear
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .glassEffectID("navigation-selection", in: namespace)
                    .glassEffectTransition(reduceMotion ? .identity : .matchedGeometry)
            } else if reduceTransparency {
                Capsule().fill(.background)
                    .overlay { Capsule().strokeBorder(Color.primary.opacity(0.22), lineWidth: 1) }
            } else {
                Capsule().fill(Color.accentColor.opacity(0.14))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The same element-sized vertical glass capsule on iPad and macOS. Hosts own
/// navigation state, window insets and edge-drag resizing.
public struct PlatformNavigationRail: View {
    @Namespace private var selectionGlass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public let items: [PlatformNavigationItem]
    public let selectedID: String
    public let expanded: Bool
    public let verticalAlignment: Alignment
    public let settingsTitle: String
    public let settingsAccessibilityID: String
    public let onSelect: (String) -> Void
    public let onSettings: () -> Void

    public init(items: [PlatformNavigationItem], selectedID: String, expanded: Bool,
                verticalAlignment: Alignment = .top,
                settingsTitle: String, settingsAccessibilityID: String,
                onSelect: @escaping (String) -> Void, onSettings: @escaping () -> Void) {
        self.items = items
        self.selectedID = selectedID
        self.expanded = expanded
        self.verticalAlignment = verticalAlignment
        self.settingsTitle = settingsTitle
        self.settingsAccessibilityID = settingsAccessibilityID
        self.onSelect = onSelect
        self.onSettings = onSettings
    }

    public var body: some View {
        PlatformNavigationGlassContainer { railContents.padding(5) }
            .animation(reduceMotion ? nil : .smooth(duration: 0.22), value: selectedID)
            .platformGlassSurface(in: Capsule(), variant: .clear)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("navigation-tab-capsule")
            .frame(maxHeight: .infinity, alignment: verticalAlignment)
    }

    private var railContents: some View {
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
                            PlatformTabSelectionIndicator(namespace: selectionGlass)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(PlatformTabButtonStyle())
                .help(item.title)
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityValue(selected ? "selected" : "not-selected")
                .accessibilityIdentifier(item.accessibilityID)
            }

            Divider()
                .padding(.horizontal, expanded ? 8 : 10)
                .padding(.vertical, 4)

            Button(action: onSettings) {
                HStack(spacing: 10) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 40, height: 40)
                    if expanded {
                        Text(settingsTitle)
                            .font(.system(size: 14, weight: .medium))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: expanded ? .leading : .center)
                .padding(.horizontal, expanded ? 8 : 0)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(PlatformTabButtonStyle())
            .help(settingsTitle)
            .accessibilityLabel(settingsTitle)
            .accessibilityIdentifier(settingsAccessibilityID)
        }
    }
}
