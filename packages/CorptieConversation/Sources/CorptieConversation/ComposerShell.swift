import SwiftUI

/// Geometry of the message composer row, identical on macOS (`MessageComposer`)
/// and iPad. Hosts keep their own text engine (NSTextView / UITextView); the
/// clamp, chip strip, action glyphs and model menu frame live here.
public enum ComposerShellMetrics {
    public static let minimumInputHeight: CGFloat = 30
    public static let maximumInputHeight: CGFloat = 96
    public static let inputFontSize: CGFloat = 12
    public static let textInsetHeight: CGFloat = 6
    public static let cornerRadius: CGFloat = 13
    public static let actionGlyphEdge: CGFloat = 24
    public static let actionHitEdge: CGFloat = 28
    public static let attachmentStripHeight: CGFloat = 62
    public static let attachmentChipEdge: CGFloat = 48
    public static let attachmentChipCornerRadius: CGFloat = 8
    public static let attachmentSpacing: CGFloat = 7
    public static let maximumAttachments = 8
    public static let maximumMentions = 8
    public static let modelMenuHeight: CGFloat = 30
    public static let modelMenuCornerRadius: CGFloat = 12

    /// A single text line plus insets at rest; grow with content up to 96pt.
    public static func resolvedInputHeight(for contentHeight: CGFloat) -> CGFloat {
        min(maximumInputHeight, max(minimumInputHeight, ceil(contentHeight)))
    }

    /// The model menu yields to the editor: a sixth of the row, 54–74pt.
    public static func modelMenuMaxWidth(composerWidth: CGFloat) -> CGFloat {
        guard composerWidth > 0 else { return 74 }
        return max(54, min(74, composerWidth / 6))
    }
}

/// Hardware-key semantics of the editor (`ComposerSubmitTextView.keyDown`):
/// Return submits, Shift+Return inserts a newline, marked text always belongs
/// to the input method, and an open mention menu owns arrows / Return / Escape.
public enum ComposerKeyPolicy {
    public enum Key: Sendable { case `return`, upArrow, downArrow, escape }
    public enum Action: Equatable, Sendable {
        case passThrough, submit, mentionMove(Int), mentionSelect, mentionDismiss
    }

    /// `mentionMenuActive` is "a query exists and has candidates". A query
    /// without candidates does not capture Return: the host clears it and sends.
    public static func action(for key: Key, shift: Bool, hasMarkedText: Bool, mentionMenuActive: Bool) -> Action {
        switch key {
        case .downArrow: return mentionMenuActive ? .mentionMove(1) : .passThrough
        case .upArrow: return mentionMenuActive ? .mentionMove(-1) : .passThrough
        case .escape: return mentionMenuActive ? .mentionDismiss : .passThrough
        case .return:
            if hasMarkedText || shift { return .passThrough }
            return mentionMenuActive ? .mentionSelect : .submit
        }
    }
}

/// Model / reasoning labels of the composer's model menu.
public enum ComposerModelLabel {
    public static let maximumCharacterCount = 15

    public static func compact(_ value: String) -> String {
        guard value.count > maximumCharacterCount else { return value }
        return String(value.prefix(maximumCharacterCount - 1)) + "…"
    }

    public static func reasoningShort(_ value: String) -> String {
        switch value.lowercased() {
        case "low": "L"
        case "medium": "M"
        case "high": "H"
        case "xhigh": "XH"
        default: value.uppercased()
        }
    }

    public static func reasoningTitle(_ value: String) -> String {
        switch value.lowercased() {
        case "low": "Low"
        case "medium": "Medium"
        case "high": "High"
        case "xhigh": "Extra High"
        default: value
        }
    }

    public static func menuEnabled(canSwitchModel: Bool, canSwitchReasoning: Bool,
                                   isSwitchingModel: Bool, isSwitchingReasoning: Bool) -> Bool {
        (canSwitchModel || canSwitchReasoning) && !isSwitchingModel && !isSwitchingReasoning
    }
}

/// One row of the @-mention menu. `id` is the mention identity (`type:targetId`).
public struct ComposerMentionSuggestion: Identifiable, Equatable, Sendable {
    public enum Kind: Sendable { case work, session }
    public let id: String
    public let kind: Kind
    public let targetId: String
    public let displayName: String
    public let detail: String

    public init(kind: Kind, targetId: String, displayName: String, detail: String) {
        self.kind = kind
        self.targetId = targetId
        self.displayName = displayName
        self.detail = detail
        id = (kind == .work ? "work" : "session") + ":" + targetId
    }

    public var symbol: String { kind == .work ? "briefcase" : "bubble.left.and.bubble.right" }
}

/// Candidate ordering and filtering of the desktop composer: every Work, each
/// followed by its sessions; sessions outside any Work last; already-mentioned
/// targets and the current session excluded; at most `maximumMentions` active.
public enum ComposerMentionCatalog {
    public struct Work: Sendable { public let id: String; public let name: String
        public init(id: String, name: String) { self.id = id; self.name = name } }
    public struct Session: Sendable { public let id: String; public let title: String; public let workId: String?
        public init(id: String, title: String, workId: String?) { self.id = id; self.title = title; self.workId = workId } }

    public static func suggestions(works: [Work], sessions: [Session], currentSessionID: String,
                                   activeMentionIDs: Set<String>, query: String) -> [ComposerMentionSuggestion] {
        guard activeMentionIDs.count < ComposerShellMetrics.maximumMentions else { return [] }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let available = sessions.filter { $0.id != currentSessionID }
        let byWork = Dictionary(grouping: available, by: { $0.workId ?? "" })
        let workIDs = Set(works.map(\.id))
        func session(_ candidate: Session, workName: String?) -> ComposerMentionSuggestion {
            ComposerMentionSuggestion(kind: .session, targetId: candidate.id, displayName: candidate.title,
                                      detail: workName.map { "Session · Work: \($0)" } ?? "Session")
        }
        var all: [ComposerMentionSuggestion] = []
        for work in works {
            all.append(ComposerMentionSuggestion(kind: .work, targetId: work.id, displayName: work.name, detail: "Work"))
            all.append(contentsOf: (byWork[work.id] ?? []).map { session($0, workName: work.name) })
        }
        all.append(contentsOf: available.filter { !workIDs.contains($0.workId ?? "") }.map { session($0, workName: nil) })
        return all.filter { candidate in
            !activeMentionIDs.contains(candidate.id)
                && (needle.isEmpty
                    || candidate.displayName.localizedCaseInsensitiveContains(needle)
                    || candidate.targetId.localizedCaseInsensitiveContains(needle)
                    || candidate.detail.localizedCaseInsensitiveContains(needle))
        }
    }
}

public enum ComposerMentionMenuMetrics {
    public static let width: CGFloat = 360
    public static let minimumHeight: CGFloat = 180
    public static let maximumHeight: CGFloat = 326
    private static let headerHeight: CGFloat = 38
    private static let rowHeight: CGFloat = 40
    private static let maximumVisibleRows = 7

    public static func height(candidateCount: Int) -> CGFloat {
        let visibleRows = min(max(candidateCount, 0), maximumVisibleRows)
        let contentHeight = headerHeight + CGFloat(visibleRows) * rowHeight + 8
        return min(maximumHeight, max(minimumHeight, contentHeight))
    }
}

// MARK: - Palette

/// Composer tints (the desktop `CorptiePalette` values) so hosts colour their own leaves consistently.
public enum ComposerPalette {
    public static let softBlue = adaptive(light: (0.28, 0.45, 0.70), dark: (0.50, 0.64, 0.82))
    public static let primaryText = adaptive(light: (0.10, 0.12, 0.13), dark: (0.94, 0.96, 0.96))
    public static let secondaryText = adaptive(light: (0.24, 0.27, 0.29), dark: (0.78, 0.82, 0.84))

    public static var surface: Color {
        #if canImport(UIKit)
        Color(uiColor: .systemBackground)
        #else
        Color(nsColor: .textBackgroundColor)
        #endif
    }

    private static func adaptive(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        #if canImport(UIKit)
        Color(uiColor: UIColor { trait in
            let c = trait.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
        #else
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let c = isDark ? dark : light
            return NSColor(calibratedRed: c.0, green: c.1, blue: c.2, alpha: 1)
        })
        #endif
    }
}

// MARK: - Views

/// Shared circular control surface for the conversation composer and header.
/// The system owns the Liquid Glass rendering on macOS/iOS 26; older systems
/// retain a lightweight material surface without adding a separate backdrop.
public struct ConversationGlassControlSurface: ViewModifier {
    private let tint: Color?

    public init(tint: Color? = nil) { self.tint = tint }

    @ViewBuilder
    public func body(content: Content) -> some View {
        if #available(macOS 26.0, iOS 26.0, *) {
            if let tint {
                content.glassEffect(.regular.tint(tint.opacity(0.18)).interactive(), in: .circle)
            } else {
                content.glassEffect(.regular.interactive(), in: .circle)
            }
        } else {
            content
                .background {
                    Circle().fill(.ultraThinMaterial)
                    if let tint { Circle().fill(tint.opacity(0.10)) }
                }
                .overlay {
                    Circle().strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.6)
                        .allowsHitTesting(false)
                }
        }
    }
}

public extension View {
    func conversationGlassControl(tint: Color? = nil) -> some View {
        modifier(ConversationGlassControlSurface(tint: tint))
    }
}

/// Rounded composer surface: white / text background, 13pt corners, focus-aware
/// hairline, soft drop shadow.
public struct ComposerShellSurface: ViewModifier {
    private let isFocused: Bool
    public init(isFocused: Bool) { self.isFocused = isFocused }

    public func body(content: Content) -> some View {
        content
            .background(ComposerPalette.surface,
                        in: RoundedRectangle(cornerRadius: ComposerShellMetrics.cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: ComposerShellMetrics.cornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(isFocused ? 0.16 : 0.08), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.04), radius: 8, y: 3)
    }
}

/// The same compact glass module surrounds the status row and editor on both clients.
public struct ConversationComposerChrome<Header: View, Content: View>: View {
    private let header: Header
    private let content: Content
    private let verticalPadding: CGFloat
    private let contentSpacing: CGFloat

    public init(verticalPadding: CGFloat = 6, contentSpacing: CGFloat = 2,
                @ViewBuilder header: () -> Header, @ViewBuilder content: () -> Content) {
        self.header = header()
        self.content = content()
        self.verticalPadding = verticalPadding
        self.contentSpacing = contentSpacing
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: contentSpacing) {
            header.padding(.horizontal, 8)
            content
        }
        .padding(.horizontal, 6)
        .padding(.vertical, verticalPadding)
        .modifier(ConversationComposerGlassSurface())
        .shadow(color: .black.opacity(0.06), radius: 4, y: 1.5)
    }
}

private struct ConversationComposerGlassSurface: ViewModifier {
    private let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 26.0, iOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(Color.primary.opacity(0.10), lineWidth: 0.5)
                    .allowsHitTesting(false))
        }
    }
}

/// Hosts supply their native editor and actions; spacing, border and model placement are shared.
public struct ConversationComposerEditorRow<Attachments: View, Editor: View, Send: View, More: View, Model: View>: View {
    private let showsAttachments: Bool
    private let showsModel: Bool
    private let attachments: Attachments
    private let editor: Editor
    private let send: Send
    private let more: More
    private let model: Model

    public init(showsAttachments: Bool, showsModel: Bool,
                @ViewBuilder attachments: () -> Attachments,
                @ViewBuilder editor: () -> Editor,
                @ViewBuilder send: () -> Send,
                @ViewBuilder more: () -> More,
                @ViewBuilder model: () -> Model) {
        self.showsAttachments = showsAttachments
        self.showsModel = showsModel
        self.attachments = attachments()
        self.editor = editor()
        self.send = send()
        self.more = more()
        self.model = model()
    }

    public var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                if showsAttachments { attachments }
                HStack(spacing: 2) {
                    editor
                        .frame(minWidth: 0, maxWidth: .infinity)
                        .padding(.leading, 10)
                        .padding(.trailing, 2)
                        .layoutPriority(-1)
                    send
                    more.padding(.trailing, 4)
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            .overlay {
                RoundedRectangle(cornerRadius: ComposerShellMetrics.cornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.22), lineWidth: 1)
                    .allowsHitTesting(false)
            }
            if showsModel { model.fixedSize(horizontal: true, vertical: false) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 24pt tinted circle inside a 28pt slot: the send / more glyphs of the composer.
public struct ComposerActionGlyph: View {
    private let systemName: String
    private let tint: Color
    private let isBusy: Bool
    private let weight: Font.Weight
    private let showsSurface: Bool

    public init(systemName: String, tint: Color, isBusy: Bool = false, weight: Font.Weight = .bold,
                showsSurface: Bool = true) {
        self.systemName = systemName
        self.tint = tint
        self.isBusy = isBusy
        self.weight = weight
        self.showsSurface = showsSurface
    }

    public var body: some View {
        Group {
            if isBusy {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: systemName).font(.system(size: 10, weight: weight))
            }
        }
        .frame(width: ComposerShellMetrics.actionGlyphEdge, height: ComposerShellMetrics.actionGlyphEdge)
        .background {
            if showsSurface { Circle().fill(tint.opacity(0.14)) }
        }
        .frame(width: ComposerShellMetrics.actionHitEdge, height: ComposerShellMetrics.actionHitEdge)
        .foregroundStyle(tint)
        .contentShape(Circle())
    }
}

/// Label of the model menu: compact model name plus reasoning short code.
public struct ComposerModelMenuLabel: View {
    private let modelLabel: String
    private let reasoningShortLabel: String
    private let isBusy: Bool
    private let maxWidth: CGFloat
    private let showsSurface: Bool

    public init(modelLabel: String, reasoningShortLabel: String, isBusy: Bool, maxWidth: CGFloat,
                showsSurface: Bool = true) {
        self.modelLabel = modelLabel
        self.reasoningShortLabel = reasoningShortLabel
        self.isBusy = isBusy
        self.maxWidth = maxWidth
        self.showsSurface = showsSurface
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: ComposerShellMetrics.modelMenuCornerRadius,
                                     style: .continuous)
        if showsSurface {
            if #available(macOS 26.0, iOS 26.0, *) {
                labelContent.glassEffect(.regular.interactive(), in: shape)
            } else {
                labelContent
                    .background(.ultraThinMaterial, in: shape)
                    .overlay(shape.strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.6))
            }
        } else {
            labelContent
        }
    }

    private var labelContent: some View {
        HStack(spacing: 4) {
            if isBusy {
                ProgressView().controlSize(.small).frame(width: 16, height: 16)
            }
            Text(ComposerModelLabel.compact(modelLabel))
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .truncationMode(.tail)
            if !reasoningShortLabel.isEmpty {
                Text(reasoningShortLabel)
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(ComposerPalette.secondaryText)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(ComposerPalette.primaryText)
        .frame(maxWidth: maxWidth)
        .padding(.horizontal, 8)
        .frame(height: ComposerShellMetrics.modelMenuHeight)
    }
}

/// 48pt attachment chip with the remove badge at its top-trailing corner.
public struct ComposerAttachmentChip: View {
    private let image: Image?
    private let isMissing: Bool
    private let accessibilityName: String
    private let onRemove: () -> Void

    public init(image: Image?, isMissing: Bool = false, accessibilityName: String, onRemove: @escaping () -> Void) {
        self.image = image
        self.isMissing = isMissing
        self.accessibilityName = accessibilityName
        self.onRemove = onRemove
    }

    public var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image {
                    image.resizable().scaledToFill()
                } else {
                    Image(systemName: isMissing ? "exclamationmark.triangle" : "photo").foregroundStyle(.secondary)
                }
            }
            .frame(width: ComposerShellMetrics.attachmentChipEdge, height: ComposerShellMetrics.attachmentChipEdge)
            .background(Color.black.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: ComposerShellMetrics.attachmentChipCornerRadius, style: .continuous))
            .accessibilityLabel(accessibilityName)

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.66))
                    .frame(width: 22, height: 22)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .offset(x: 5, y: -5)
            .accessibilityLabel("Remove image")
        }
        .padding(.trailing, 3)
    }
}

/// The @-mention menu: header, then a keyboard-selectable list of suggestions.
public struct ComposerMentionMenu: View {
    private let suggestions: [ComposerMentionSuggestion]
    private let selectedIndex: Int
    private let onSelect: (ComposerMentionSuggestion) -> Void

    public init(suggestions: [ComposerMentionSuggestion], selectedIndex: Int,
                onSelect: @escaping (ComposerMentionSuggestion) -> Void) {
        self.suggestions = suggestions
        self.selectedIndex = selectedIndex
        self.onSelect = onSelect
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Mention a Work or Session")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ComposerPalette.secondaryText)
                .padding(.horizontal, 10)
                .padding(.top, 8)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(suggestions.enumerated()), id: \.element.id) { index, suggestion in
                            Button {
                                onSelect(suggestion)
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: suggestion.symbol)
                                        .frame(width: 18)
                                        .foregroundStyle(ComposerPalette.softBlue)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(suggestion.displayName)
                                            .font(.system(size: 12, weight: .medium))
                                            .lineLimit(1)
                                        Text(suggestion.detail)
                                            .font(.system(size: 10))
                                            .foregroundStyle(ComposerPalette.secondaryText)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 8)
                                .padding(.leading, suggestion.kind == .session ? 12 : 0)
                                .frame(height: 38)
                                .background(
                                    index == selectedIndex ? ComposerPalette.softBlue.opacity(0.12) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                                )
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .id(suggestion.id)
                            .accessibilityLabel("\(suggestion.displayName), \(suggestion.detail)")
                            .accessibilityAddTraits(index == selectedIndex ? .isSelected : [])
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.bottom, 4)
                }
                .onChange(of: selectedIndex) { _, index in
                    guard suggestions.indices.contains(index) else { return }
                    proxy.scrollTo(suggestions[index].id, anchor: .center)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Mention suggestions")
    }
}
