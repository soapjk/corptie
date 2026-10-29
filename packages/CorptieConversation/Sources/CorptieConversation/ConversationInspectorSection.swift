import SwiftUI

/// One scroll owner for both platform Detail rails.
public struct ConversationDetailDashboard<Content: View>: View {
    private let content: Content
    #if os(macOS)
    @State private var scrollRouter = DetailScrollRouter()
    #endif

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        ScrollView {
            // This rail contains a bounded dashboard whose custom layout already
            // places every card. Lazily realizing the dashboard can repeatedly
            // retire/recreate nested scroll content during Task navigation.
            VStack(alignment: .leading, spacing: 12) {
                content
            }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
                #if os(macOS)
                .padding(.top, 2)
                #else
                .padding(.top, 12)
                #endif
                #if os(macOS)
                .background(DetailRailProbe(router: scrollRouter))
                .environment(\.detailScrollRouter, scrollRouter)
                #endif
        }
        .coordinateSpace(name: "conversation.detail.rail")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WorkbenchCanvasSurface.color)
    }
}

/// A compact pair falls back to one column before either card becomes unreadable.
public struct ConversationDetailCompactPair<Leading: View, Trailing: View>: View {
    private let leading: Leading
    private let trailing: Trailing

    public init(@ViewBuilder leading: () -> Leading, @ViewBuilder trailing: () -> Trailing) {
        self.leading = leading()
        self.trailing = trailing()
    }

    public var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 8) {
                leading.frame(minWidth: 136, maxWidth: .infinity, alignment: .topLeading)
                trailing.frame(minWidth: 136, maxWidth: .infinity, alignment: .topLeading)
            }
            VStack(alignment: .leading, spacing: 12) { leading; trailing }
        }
    }
}

/// Detail uses light content material, not navigation Liquid Glass.
public struct ConversationDetailContentSurface: ViewModifier {
    private let cornerRadius: CGFloat

    public init(cornerRadius: CGFloat) {
        self.cornerRadius = cornerRadius
    }

    public func body(content: Content) -> some View {
        content.modifier(ConversationContentSurface(cornerRadius: cornerRadius, isPanel: true))
    }
}

/// One static material and color surface per Detail module; no nested glass.
public struct ConversationDetailModuleSurface: ViewModifier {
    @Environment(\.detailWidgetSize) private var widgetSize
    public init() {}

    public func body(content: Content) -> some View {
        Group {
            if let widgetSize {
                ScrollView(.vertical) {
                    // Preserve the viewport proposal for lazy collection rows.
                    // An ideal-height override makes nested lazy layout keep
                    // invalidating as paged content and scrollbars change.
                    content.frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(widgetSize.columns == 1 || widgetSize == .strip ? 12 : 16)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            } else {
                content
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
            .modifier(ConversationDetailContentSurface(cornerRadius: 18))
            #if os(macOS)
            .modifier(DetailCardScrollActivation())
            #endif
    }
}

public struct ConversationDetailModuleCard<Content: View, HeaderActions: View>: View {
    @Environment(\.detailArranging) private var arranging
    private let title: String
    private let systemImage: String
    private let headerActions: HeaderActions
    private let content: Content

    public init(title: String, systemImage: String,
                @ViewBuilder headerActions: () -> HeaderActions,
                @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.headerActions = headerActions()
        self.content = content()
    }

    public var body: some View {
        ConversationInspectorSection(title: title, systemImage: systemImage,
            headerActions: {
                headerActions.opacity(arranging ? 0 : 1).allowsHitTesting(!arranging)
                    .accessibilityHidden(arranging)
                if arranging {
                    Image(systemName: "line.3.horizontal").foregroundStyle(.secondary)
                        .accessibilityLabel("拖动卡片调整顺序")
                }
            }) { content }
            .modifier(ConversationDetailModuleSurface())
    }
}

public extension ConversationDetailModuleCard where HeaderActions == EmptyView {
    init(title: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.init(title: title, systemImage: systemImage, headerActions: { EmptyView() }, content: content)
    }
}

/// The icon has a full native hit target; the owning Button or Menu supplies its accessible name.
public struct ConversationDetailHeaderIcon: View {
    public let systemName: String

    public init(systemName: String) { self.systemName = systemName }

    public var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 12, weight: .semibold))
            #if os(macOS)
            .frame(width: 28, height: 28)
            #else
            .frame(width: 44, height: 44)
            #endif
            .contentShape(Rectangle())
    }
}

/// Rail framing only. Module cards own their material; the rail must not add
/// another blur or opaque canvas that hides the user's wallpaper.
public struct ConversationDetailCardSurface: ViewModifier {
    public let enabled: Bool

    public init(enabled: Bool = true) {
        self.enabled = enabled
    }

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: enabled ? 12 : 0, style: .continuous)
        content
            .clipShape(shape)
            .background {
                if enabled {
                    shape.fill(Color.primary.opacity(0.025))
                }
            }
            .overlay {
                if enabled {
                    shape.strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
                }
            }
    }
}

/// Shared Detail rail content. Ownership, requests and navigation stay in the host.
public struct ConversationInspectorSection<Content: View, HeaderActions: View>: View {
    @Environment(\.detailCardDrag) private var cardDrag
    #if os(macOS)
    @Environment(\.detailCardReorderController) private var cardReorder
    #endif
    private let title: String
    private let systemImage: String
    private let headerActions: HeaderActions
    private let content: Content
    public init(title: String, systemImage: String,
                @ViewBuilder headerActions: () -> HeaderActions,
                @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.headerActions = headerActions()
        self.content = content()
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top, spacing: 6) {
                if let cardDrag {
                    #if os(macOS)
                    if let cardReorder {
                        titleLabel.modifier(DetailCardReorderHandle(controller: cardReorder, id: cardDrag.cardID))
                            .help("拖动标题调整卡片顺序，按 Escape 取消")
                    } else { titleLabel }
                    #else
                    titleLabel.contentShape(Rectangle()).draggable(cardDrag)
                        .accessibilityHint("长按或拖动标题调整卡片顺序")
                    #endif
                } else { titleLabel }
                HStack(spacing: 2) { headerActions }
                    .fixedSize(horizontal: true, vertical: false)
            }
            content
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var titleLabel: some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            .lineLimit(1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

public extension ConversationInspectorSection where HeaderActions == EmptyView {
    init(title: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.init(title: title, systemImage: systemImage, headerActions: { EmptyView() }, content: content)
    }
}

/// A single native button makes the disclosure arrow and the entire title row one hit target.
public struct ConversationDetailDisclosure<Header: View, Content: View>: View {
    @Binding private var isExpanded: Bool
    private let header: Header
    private let content: Content

    public init(isExpanded: Binding<Bool>, @ViewBuilder header: () -> Header,
                @ViewBuilder content: () -> Content) {
        _isExpanded = isExpanded
        self.header = header()
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button { isExpanded.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .accessibilityHidden(true)
                    header.frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: .infinity, minHeight: headerHeight, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isExpanded ? "已展开" : "已收起")
            if isExpanded { content }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headerHeight: CGFloat {
        #if os(iOS)
        44
        #else
        28
        #endif
    }
}

public struct ConversationTaskDefinition: View {
    private let values: [String]
    private let titles: [String]
    private let expandLabel: String
    private let collapseLabel: String
    nonisolated public static func hasContent(description: String, acceptance: String) -> Bool {
        [description, acceptance].contains {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
    public init(description: String, acceptance: String,
                descriptionTitle: String = "描述", acceptanceTitle: String = "验收标准",
                expandLabel: String = "展开", collapseLabel: String = "收起") {
        values = [description, acceptance]
        titles = [descriptionTitle, acceptanceTitle]
        self.expandLabel = expandLabel; self.collapseLabel = collapseLabel
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(values.indices, id: \.self) { index in
                if !values[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ConversationStampedParagraph(title: titles[index], text: values[index],
                        expandLabel: expandLabel, collapseLabel: collapseLabel)
                }
            }
        }
    }
}
