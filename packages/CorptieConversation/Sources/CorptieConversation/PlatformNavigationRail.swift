import SwiftUI

/// A compositor-only press response shared by every top-level navigation tab.
/// Keeping it in the shared package makes macOS, iPad and compact mobile tabs
/// feel identical without introducing timers or page-level animation state.
public struct PlatformTabButtonStyle: ButtonStyle {
    private let symbolFeedback: Bool

    public init(symbolFeedback: Bool = false) { self.symbolFeedback = symbolFeedback }

    public func makeBody(configuration: Configuration) -> some View {
        PlatformTabPressFeedback(label: configuration.label, isPressed: configuration.isPressed,
                                 symbolFeedback: symbolFeedback)
    }
}

private struct PlatformTabPressFeedback<Label: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var activation = 0
    let label: Label
    let isPressed: Bool
    let symbolFeedback: Bool

    @ViewBuilder private var animatedLabel: some View {
        if symbolFeedback {
            label.symbolEffect(.bounce.up, options: .speed(1), value: reduceMotion ? 0 : activation)
        } else {
            label
        }
    }

    var body: some View {
        animatedLabel
            .scaleEffect(isPressed && !reduceMotion ? 0.94 : 1)
            .opacity(isPressed ? 0.76 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: isPressed)
            .onChange(of: isPressed) { _, pressed in
                if pressed && symbolFeedback && !reduceMotion { activation &+= 1 }
            }
    }
}

/// Selection changes the icon's transform, never the button's layout. A separate
/// activation value replays the native one-shot effect even on the current tab.
private struct PlatformTabSymbol: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let symbol: String
    let selected: Bool
    let activation: Int

    var body: some View {
        #if os(macOS)
        let symbolSpeed = 1.0
        let selectionDuration = 0.30
        #else
        let symbolSpeed = 2.0
        let selectionDuration = 0.18
        #endif
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .medium))
            .symbolEffect(.bounce.up, options: .speed(symbolSpeed), value: reduceMotion ? 0 : activation)
            .scaleEffect(selected ? 1.12 : 1)
            .animation(reduceMotion ? nil : .snappy(duration: selectionDuration, extraBounce: 0), value: selected)
            .frame(width: 40, height: 40)
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
        #if !os(macOS)
        var immediate = Transaction(animation: nil); immediate.disablesAnimations = true
        withTransaction(immediate) { moving = !reduceTransparency }
        #endif
        #if os(macOS)
        let travel = Animation.easeOut(duration: 0.20)
        #else
        let travel = Animation.spring(duration: 0.34, bounce: 0.16)
        #endif
        withAnimation(travel, completionCriteria: .logicallyComplete) {
            displayedID = next
        } completion: {
            guard motionID == id else { return }
            // Drop mobile's backdrop as soon as travel ends, without a second fade.
            var settled = Transaction(animation: nil); settled.disablesAnimations = true
            withTransaction(settled) { moving = false }
        }
    }
}

/// macOS uses a flat tint throughout travel; mobile keeps transient glass.
/// Explicit frame matching drives travel without changing button layout.
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
            if reduceTransparency {
                Capsule().fill(.background)
                    .overlay { Capsule().strokeBorder(Color.primary.opacity(0.22), lineWidth: 1) }
            } else {
                #if os(macOS)
                Capsule().fill(Color.primary.opacity(0.12))
                #else
                if #available(iOS 26.0, *) {
                    Capsule().fill(Color.primary.opacity(0.12))
                        .glassEffect(moving ? .regular : .identity, in: .capsule)
                        .glassEffectID("navigation-selection", in: namespace)
                        .glassEffectTransition(.identity)
                } else {
                    Capsule().fill(Color.accentColor.opacity(0.14))
                }
                #endif
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
    @State private var activations: [String: Int] = [:]
    public let items: [PlatformNavigationItem]
    public let selectedID: String
    public let expanded: Bool
    public let verticalAlignment: Alignment
    public let settingsTitle: String
    public let settingsSelected: Bool
    public let settingsAccessibilityID: String
    public let onSelect: (String) -> Void
    public let onSettings: () -> Void

    public init(items: [PlatformNavigationItem], selectedID: String, expanded: Bool,
                verticalAlignment: Alignment = .top,
                settingsSelected: Bool = false,
                settingsTitle: String, settingsAccessibilityID: String,
                onSelect: @escaping (String) -> Void, onSettings: @escaping () -> Void) {
        self.items = items
        self.selectedID = selectedID
        self.expanded = expanded
        self.verticalAlignment = verticalAlignment
        self.settingsTitle = settingsTitle
        self.settingsSelected = settingsSelected
        self.settingsAccessibilityID = settingsAccessibilityID
        self.onSelect = onSelect
        self.onSettings = onSettings
    }

    public var body: some View {
        PlatformAnimatedTabSelection(selectedID: settingsSelected ? settingsAccessibilityID : selectedID) { displayedID, moving in
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
                Button {
                    activations[item.id, default: 0] &+= 1
                    onSelect(item.id)
                } label: {
                    HStack(spacing: 10) {
                        PlatformTabSymbol(symbol: item.symbol, selected: selected,
                                          activation: activations[item.id, default: 0])
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

            let selected = selectedID == settingsAccessibilityID
            Button {
                activations[settingsAccessibilityID, default: 0] &+= 1
                onSettings()
            } label: {
                HStack(spacing: 10) {
                    PlatformTabSymbol(symbol: "gearshape", selected: selected,
                                      activation: activations[settingsAccessibilityID, default: 0])
                    if expanded {
                        Text(settingsTitle)
                            .font(.system(size: 14, weight: .medium))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: expanded ? .leading : .center)
                .padding(.horizontal, expanded ? 8 : 0)
                .foregroundStyle(selected ? Color.accentColor : .secondary)
                .background {
                    if selected { PlatformTabSelectionIndicator(namespace: selectionGlass, moving: moving) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(PlatformTabButtonStyle())
            .help(settingsTitle)
            .accessibilityLabel(settingsTitle)
            .accessibilityIdentifier(settingsAccessibilityID)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityValue(selected ? "selected" : "not-selected")
        }
    }
}
