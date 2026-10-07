import SwiftUI
import CorptieClientCore
#if canImport(AppKit)
import AppKit
#else
import UIKit
#endif

/// Adaptive, fully opaque user-message colors shared by SwiftUI cards,
/// attributed Markdown, and native compatibility renderers.
public enum MessageTextCardPalette {
    public enum Role: Sendable { case user, agent, commentary, collaboration }
    struct RGB: Sendable, Equatable {
        let red: Double
        let green: Double
        let blue: Double

        var relativeLuminance: Double {
            func linearized(_ component: Double) -> Double {
                component <= 0.04045
                    ? component / 12.92
                    : pow((component + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linearized(red)
                + 0.7152 * linearized(green)
                + 0.0722 * linearized(blue)
        }
    }

    static let lightUserBackground = RGB(red: 0.90, green: 0.94, blue: 0.99)
    static let darkUserBackground = RGB(red: 0.15, green: 0.20, blue: 0.29)
    static let lightUserForeground = RGB(red: 0.16, green: 0.24, blue: 0.40)
    static let darkUserForeground = RGB(red: 0.90, green: 0.94, blue: 0.99)
    static let commentaryRGB = RGB(red: 0.975, green: 0.955, blue: 0.915)
    static let agentRGB = RGB(red: 0.952, green: 0.961, blue: 0.941)

    /// Both glass tint and opaque fallback resolve from the original palette.
    /// Dark companions keep the same hue without a pale slab behind light text.
    static func backgroundRGB(for role: Role, dark: Bool) -> RGB {
        switch role {
        case .user: dark ? darkUserBackground : lightUserBackground
        case .commentary: dark ? RGB(red: 0.24, green: 0.22, blue: 0.18) : commentaryRGB
        case .agent: dark ? RGB(red: 0.17, green: 0.21, blue: 0.16) : agentRGB
        case .collaboration: dark ? RGB(red: 0.20, green: 0.20, blue: 0.29)
            : RGB(red: 0.945, green: 0.955, blue: 0.995)
        }
    }

    public static func background(for role: Role, dark: Bool) -> Color {
        let rgb = backgroundRGB(for: role, dark: dark)
        return Color(red: rgb.red, green: rgb.green, blue: rgb.blue)
    }

    static func contrastRatio(foreground: RGB, background: RGB) -> Double {
        let lighter = max(foreground.relativeLuminance, background.relativeLuminance)
        let darker = min(foreground.relativeLuminance, background.relativeLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    #if canImport(AppKit)
    public static let userNativeBackground = NSColor(name: nil) { appearance in
        nativeColor(for: appearance, light: lightUserBackground, dark: darkUserBackground)
    }
    public static let userNativeForeground = NSColor(name: nil) { appearance in
        nativeColor(for: appearance, light: lightUserForeground, dark: darkUserForeground)
    }
    public static let commentaryNativeBackground = NSColor(
        calibratedRed: commentaryRGB.red, green: commentaryRGB.green, blue: commentaryRGB.blue, alpha: 1)
    public static let commentaryBackground = Color(nsColor: commentaryNativeBackground)
    public static let agentNativeBackground = adaptiveNativeBackground(.agent)
    public static let adaptiveCommentaryNativeBackground = adaptiveNativeBackground(.commentary)
    public static let collaborationNativeBackground = adaptiveNativeBackground(.collaboration)

    private static func adaptiveNativeBackground(_ role: Role) -> NSColor {
        NSColor(name: nil) { appearance in
            nativeColor(for: appearance, light: backgroundRGB(for: role, dark: false),
                dark: backgroundRGB(for: role, dark: true))
        }
    }

    private static func nativeColor(for appearance: NSAppearance, light: RGB, dark: RGB) -> NSColor {
        let rgb = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        return NSColor(calibratedRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
    }

    public static let userBackground = Color(nsColor: userNativeBackground)
    public static let userForeground = Color(nsColor: userNativeForeground)
    #else
    public static let userNativeBackground = UIColor { traits in
        nativeColor(for: traits, light: lightUserBackground, dark: darkUserBackground)
    }
    public static let userNativeForeground = UIColor { traits in
        nativeColor(for: traits, light: lightUserForeground, dark: darkUserForeground)
    }
    public static let commentaryNativeBackground = UIColor(
        red: commentaryRGB.red, green: commentaryRGB.green, blue: commentaryRGB.blue, alpha: 1)
    public static let commentaryBackground = Color(uiColor: commentaryNativeBackground)

    private static func nativeColor(for traits: UITraitCollection, light: RGB, dark: RGB) -> UIColor {
        let rgb = traits.userInterfaceStyle == .dark ? dark : light
        return UIColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
    }

    public static let userBackground = Color(uiColor: userNativeBackground)
    public static let userForeground = Color(uiColor: userNativeForeground)
    #endif
}

/// Platform-neutral labels and availability for the product-owned message menu.
/// The platform decides how that menu is invoked (right-click on macOS, long-press on iPadOS).
public struct MessageTextCardMenuConfiguration {
    public let timestampTitle: String?
    public let copyTitle: String
    public let selectTextTitle: String
    public let canCopy: Bool

    public init(timestampTitle: String?, copyTitle: String, selectTextTitle: String, canCopy: Bool = true) {
        self.timestampTitle = timestampTitle
        self.copyTitle = copyTitle
        self.selectTextTitle = selectTextTitle
        self.canCopy = canCopy
    }
}

/// Shared visual body for ordinary text messages. TextKit, Markdown parsing,
/// measurement, link handling and clipboard access are injected platform leaves.
/// No workspace observation, network calls, timers or implicit animations.
public struct MessageTextCard<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    public enum Role: Sendable { case user, agent, commentary }
    private let role: Role
    private let messageID: String
    private let timestamp: String
    private let showsActions: Bool
    private let actionsAlwaysVisible: Bool
    private let cardWidth: CGFloat?
    private let cardHeight: CGFloat?
    private let status: UserMessageStatusPresentation?
    private let copy: () -> Void
    private let contextMenu: MessageTextCardMenuConfiguration?
    private let content: (Binding<Bool>) -> Content
    @State private var hovering = false
    @State private var showingStatusDetail = false
    @State private var selectingText = false

    public init(messageID: String, role: Role, timestamp: String, showsActions: Bool,
                actionsAlwaysVisible: Bool, cardWidth: CGFloat? = nil, cardHeight: CGFloat? = nil,
                status: UserMessageStatusPresentation? = nil,
                copy: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) {
        self.messageID = messageID; self.role = role; self.timestamp = timestamp; self.showsActions = showsActions
        self.actionsAlwaysVisible = actionsAlwaysVisible
        self.cardWidth = cardWidth; self.cardHeight = cardHeight
        self.status = status
        self.copy = copy
        self.contextMenu = nil
        self.content = { _ in content() }
    }

    /// Creates a card whose product menu owns the default context interaction.
    /// `content` receives a card-local binding that becomes true only after the
    /// user explicitly chooses the menu's text-selection action.
    public init(messageID: String, role: Role, timestamp: String, showsActions: Bool,
                actionsAlwaysVisible: Bool, cardWidth: CGFloat? = nil, cardHeight: CGFloat? = nil,
                status: UserMessageStatusPresentation? = nil,
                contextMenu: MessageTextCardMenuConfiguration,
                copy: @escaping () -> Void,
                @ViewBuilder content: @escaping (Binding<Bool>) -> Content) {
        self.messageID = messageID; self.role = role; self.timestamp = timestamp; self.showsActions = showsActions
        self.actionsAlwaysVisible = actionsAlwaysVisible
        self.cardWidth = cardWidth; self.cardHeight = cardHeight
        self.status = status
        self.contextMenu = contextMenu
        self.copy = copy
        self.content = content
    }

    public var body: some View {
        Group {
            if let contextMenu, !selectingText {
                #if os(iOS)
                cardBody
                    .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .contextMenu {
                        contextMenuContent(contextMenu)
                    } preview: {
                        // A separately hosted native preview is not captured
                        // from the clipped scroll viewport. Build it only when
                        // requested, without a second resident message list.
                        cardBody.fixedSize(horizontal: false, vertical: true)
                    }
                #else
                cardBody
                    .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .contextMenu { contextMenuContent(contextMenu) }
                #endif
            } else {
                cardBody
            }
        }
        .accessibilityActions {
            if let contextMenu {
                if contextMenu.canCopy {
                    Button(contextMenu.copyTitle, action: copy)
                }
                if !selectingText {
                    Button(contextMenu.selectTextTitle) { selectingText = true }
                }
            }
        }
        .onChange(of: messageID) {
            hovering = false
            selectingText = false
        }
    }

    private var cardBody: some View {
        VStack(alignment: role == .user ? .trailing : .leading, spacing: 2) {
            content($selectingText)
                .padding(10)
                .frame(width: cardWidth, height: cardHeight, alignment: .topLeading)
                .modifier(ConversationContentSurface(cornerRadius: 14,
                    tint: background, fallback: background, isMessage: true))
            if showsActions || status != nil {
                HStack(spacing: 6) {
                    if let status {
                        Button { showingStatusDetail = true } label: {
                            Label {
                                Text(status.shortLabel(languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
                                    .lineLimit(1)
                            } icon: {
                                Image(systemName: status.symbolName)
                            }
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(statusColor(status.tone))
                        }
                        .buttonStyle(.plain)
                        .help(status.detail(languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
                        .accessibilityLabel(status.detail(languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
                        .accessibilityIdentifier("message-processing-state")
                        .popover(isPresented: $showingStatusDetail) {
                            Text(status.detail(languageCode: Locale.current.language.languageCode?.identifier ?? "en"))
                                .font(.caption)
                                .padding(12)
                                .frame(maxWidth: 260, alignment: .leading)
                        }
                    }
                    if showsActions {
                        if !timestamp.isEmpty && status == nil {
                            Text(timestamp).font(.system(size: 9, weight: .medium))
                                .foregroundStyle(Color(red: 0.38, green: 0.41, blue: 0.43))
                                .lineLimit(1)
                        }
                        Button(action: copy) {
                            Image(systemName: "doc.on.doc").frame(width: 22, height: 22)
                        }
                        .buttonStyle(.plain)
                        .help("复制消息")
                        .accessibilityLabel("复制消息")
                        .accessibilityIdentifier("chat.timeline.copy")
                        .opacity(actionsAlwaysVisible || hovering ? 1 : 0)
                        .accessibilityHidden(!actionsAlwaysVisible && !hovering)
                    }
                }
                .padding(.horizontal, 2)
                .frame(height: 22)
                .fixedSize(horizontal: true, vertical: false)
            }
        }
        .onHover { hovering = $0 }
    }

    @ViewBuilder
    private func contextMenuContent(_ configuration: MessageTextCardMenuConfiguration) -> some View {
        if let timestampTitle = configuration.timestampTitle, !timestampTitle.isEmpty {
            Button(action: {}) {
                Label(timestampTitle, systemImage: "clock")
            }
            .disabled(true)
            .accessibilityIdentifier("chat.timeline.context.timestamp")
            Divider()
        }
        if configuration.canCopy {
            Button(action: copy) {
                Label(configuration.copyTitle, systemImage: "doc.on.doc")
            }
            .accessibilityIdentifier("chat.timeline.context.copy")
        }
        #if !os(macOS)
        Button {
            selectingText = true
        } label: {
            Label(configuration.selectTextTitle, systemImage: "text.cursor")
        }
        .accessibilityIdentifier("chat.timeline.context.select-text")
        #endif
    }

    private var background: Color {
        let paletteRole: MessageTextCardPalette.Role = switch role {
        case .user: .user
        case .commentary: .commentary
        case .agent: .agent
        }
        return MessageTextCardPalette.background(for: paletteRole, dark: colorScheme == .dark)
    }
    private func statusColor(_ tone: UserMessageStatusPresentation.Tone) -> Color {
        switch tone {
        case .neutral: .secondary
        case .amber: .orange
        case .green: .green
        case .red: .red
        }
    }
}
