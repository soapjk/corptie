import SwiftUI

/// One scroll owner and header for both platform Detail rails.
public struct ConversationDetailDashboard<Actions: View, Content: View>: View {
    private let title: String
    private let actions: Actions
    private let content: Content

    public init(title: String = "Detail", @ViewBuilder actions: () -> Actions,
                @ViewBuilder content: () -> Content) {
        self.title = title
        self.actions = actions()
        self.content = content()
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                actions
            }
            .frame(minHeight: 44)
            .padding(.horizontal, 16)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) { content }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
        }
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

/// A single adaptive monochrome surface for Detail modules on both platforms.
public struct ConversationDetailModuleSurface: ViewModifier {
    public init() {}

    public func body(content: Content) -> some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.055),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

public struct ConversationDetailModuleCard<Content: View>: View {
    private let title: String
    private let systemImage: String
    private let content: Content

    public init(title: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.content = content()
    }

    public var body: some View {
        ConversationInspectorSection(title: title, systemImage: systemImage) { content }
            .modifier(ConversationDetailModuleSurface())
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
                        .fill(WorkbenchCanvasSurface.color)
                        .overlay { shape.fill(Color.primary.opacity(0.045)) }
                }
            }
            .overlay {
                if enabled {
                    shape.strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
                }
            }
            .shadow(color: Color.black.opacity(enabled ? 0.055 : 0),
                    radius: enabled ? 9 : 0, x: 0, y: enabled ? 3 : 0)
    }
}

/// Shared Detail rail content. Ownership, requests and navigation stay in the host.
public struct ConversationInspectorSection<Content: View>: View {
    private let title: String
    private let systemImage: String
    private let content: Content
    public init(title: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.title = title; self.systemImage = systemImage; self.content = content()
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            content
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

public struct ConversationTaskDefinition: View {
    private let values: [String]
    private let titles: [String]
    private let expandLabel: String
    private let collapseLabel: String
    nonisolated public static func hasContent(description: String, acceptance: String, verification: String) -> Bool {
        [description, acceptance, verification].contains {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
    public init(description: String, acceptance: String, verification: String,
                descriptionTitle: String = "描述", acceptanceTitle: String = "验收标准",
                verificationTitle: String = "验证标准", expandLabel: String = "展开", collapseLabel: String = "收起") {
        values = [description, acceptance, verification]
        titles = [descriptionTitle, acceptanceTitle, verificationTitle]
        self.expandLabel = expandLabel; self.collapseLabel = collapseLabel
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(values.indices, id: \.self) { index in
                if !values[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ConversationInspectorSection(title: titles[index],
                        systemImage: ["text.alignleft", "checklist", "checkmark.seal"][index]) {
                        ConversationDetailText(text: values[index], expandLabel: expandLabel, collapseLabel: collapseLabel)
                    }
                }
            }
        }
    }
}
