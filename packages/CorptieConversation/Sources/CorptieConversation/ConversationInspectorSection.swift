import SwiftUI

/// One scroll owner for both platform Detail rails.
public struct ConversationDetailDashboard<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                content
            }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WorkbenchCanvasSurface.color)
        #if os(macOS)
        .contentMargins(.top, 40, for: .scrollContent)
        #endif
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

/// Keep the native glass, but clip its final composited output to the card.
/// Clipping a descendant inside a shared GlassEffectContainer does not clip
/// the glass that the container lifts into its own rendering layer.
public struct ConversationDetailGlassSurface: ViewModifier {
    private let cornerRadius: CGFloat

    public init(cornerRadius: CGFloat) {
        self.cornerRadius = cornerRadius
    }

    @ViewBuilder public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(macOS 26.0, iOS 26.0, *) {
            GlassEffectContainer(spacing: 0) {
                content.platformGlassSurface(in: shape)
            }
            .clipShape(shape)
        } else {
            content.platformGlassSurface(in: shape)
                .clipShape(shape)
        }
    }
}

/// A locally composited glass surface for each Detail module.
public struct ConversationDetailModuleSurface: ViewModifier {
    public init() {}

    public func body(content: Content) -> some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(ConversationDetailGlassSurface(cornerRadius: 18))
    }
}

public struct ConversationDetailModuleCard<Content: View, HeaderActions: View>: View {
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
            headerActions: { headerActions }) { content }
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

/// One inexpensive, adaptive full-height Detail card surface on macOS and iPadOS.
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
                    shape
                        .fill(WorkbenchCanvasSurface.defaultColor)
                        .overlay { shape.fill(Color.primary.opacity(0.045)) }
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
            HStack(spacing: 6) {
                Label(title, systemImage: systemImage)
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                HStack(spacing: 2) { headerActions }
                    .fixedSize(horizontal: true, vertical: false)
            }
            content
        }.frame(maxWidth: .infinity, alignment: .leading)
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
        VStack(alignment: .leading, spacing: 14) {
            ForEach(values.indices, id: \.self) { index in
                if !values[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ConversationInspectorSection(title: titles[index],
                        systemImage: ["text.alignleft", "checklist"][index]) {
                        ConversationDetailText(text: values[index], expandLabel: expandLabel, collapseLabel: collapseLabel)
                    }
                }
            }
        }
    }
}
