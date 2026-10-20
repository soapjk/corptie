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

/// Owns presentation-only selection state. Routing remains with the host.
/// Completions from interrupted animations cannot settle a newer selection.
public struct PlatformAnimatedTabSelection<Content: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var displayedID: String
    @State private var moving = false
    @State private var motionID = UUID()
    private let selectedID: String
    private let content: (String, Bool) -> Content

    public init(selectedID: String, @ViewBuilder content: @escaping (String, Bool) -> Content) {
        self.selectedID = selectedID; self.content = content
        _displayedID = State(initialValue: selectedID)
    }

    public var body: some View {
        content(displayedID, moving)
            .onAppear { settleImmediately() }
            .onChange(of: selectedID) { _, next in move(to: next) }
            .onChange(of: reduceMotion) { _, _ in settleImmediately() }
            .onChange(of: reduceTransparency) { _, _ in settleImmediately() }
            .onDisappear { settleImmediately() }
    }

    private func settleImmediately() {
        motionID = UUID()
        var transaction = Transaction(animation: nil); transaction.disablesAnimations = true
        withTransaction(transaction) { moving = false; displayedID = selectedID }
    }

    private func move(to next: String) {
        guard next != displayedID else { return }
        guard !reduceMotion else { settleImmediately(); return }
        let id = UUID(); motionID = id
        withTransaction(Transaction(animation: nil)) { moving = !reduceTransparency }
        withAnimation(.spring(duration: 0.34, bounce: 0.16), completionCriteria: .removed) {
            displayedID = next
        } completion: {
            guard motionID == id else { return }
            withAnimation(.easeOut(duration: 0.12)) { moving = false }
        }
    }
}

/// Only the travelling selection uses native glass; rest is a flat soft tint.
/// Explicit frame matching drives travel between buttons; native glass owns
/// the material, not the insertion/removal of disconnected glass surfaces.
public struct PlatformTabSelectionIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let namespace: Namespace.ID
    private let moving: Bool

    public init(namespace: Namespace.ID, moving: Bool = false) {
        self.namespace = namespace; self.moving = moving
    }

    public var body: some View {
        Group {
            if #available(iOS 26.0, macOS 26.0, *), !reduceTransparency {
                Capsule().fill(Color.primary.opacity(moving ? 0 : 0.08))
                    .glassEffect(moving ? .regular.interactive() : .identity, in: .capsule)
                    .glassEffectID("navigation-selection", in: namespace)
                    .glassEffectTransition(.identity)
            } else if reduceTransparency {
                Capsule().fill(.background)
                    .overlay { Capsule().strokeBorder(Color.primary.opacity(0.22), lineWidth: 1) }
            } else {
                Capsule().fill(Color.accentColor.opacity(0.14))
            }
        }
        // Match the whole rendered surface, not just its clear input view.
        .matchedGeometryEffect(id: "navigation-selection-frame", in: namespace,
                               properties: reduceMotion ? [] : .frame)
        .transition(.identity)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The same element-sized vertical glass capsule on iPad and macOS. Hosts own
/// navigation state, window insets and edge-drag resizing.
public struct PlatformNavigationRail: View {
    @Namespace private var selectionGlass
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
        PlatformAnimatedTabSelection(selectedID: selectedID) { displayedID, moving in
            PlatformNavigationGlassContainer { railContents(selectedID: displayedID, moving: moving).padding(5) }
                .platformGlassSurface(in: Capsule(), variant: .clear)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("navigation-tab-capsule")
        }
        .frame(maxHeight: .infinity, alignment: verticalAlignment)
    }

    private func railContents(selectedID: String, moving: Bool) -> some View {
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
                            PlatformTabSelectionIndicator(namespace: selectionGlass, moving: moving)
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
