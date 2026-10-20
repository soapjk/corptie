import SwiftUI

/// Shared width negotiation for Work headers. The title wins over dispensable
/// trailing whitespace, while independent actions retain their intrinsic size.
/// The background handles empty-area clicks without a second flexible Button
/// participating in HStack measurement or nesting any of the foreground buttons.
public struct WorkOutlineHeaderRow<Title: View, Discussion: View, Actions: View>: View {
    private let minimumHeight: CGFloat
    private let toggleExpanded: () -> Void
    private let title: Title
    private let discussion: Discussion
    private let actions: Actions

    public init(minimumHeight: CGFloat = 28, toggleExpanded: @escaping () -> Void,
                @ViewBuilder title: () -> Title,
                @ViewBuilder discussion: () -> Discussion,
                @ViewBuilder actions: () -> Actions) {
        self.minimumHeight = minimumHeight
        self.toggleExpanded = toggleExpanded
        self.title = title(); self.discussion = discussion(); self.actions = actions()
    }

    public var body: some View {
        HStack(spacing: 0) {
            title.layoutPriority(1)
            discussion
            Spacer(minLength: 4).layoutPriority(-1)
            actions.fixedSize(horizontal: true, vertical: false)
        }
        .frame(maxWidth: .infinity, minHeight: minimumHeight, alignment: .leading)
        .background {
            Button(action: toggleExpanded) {
                Color.clear.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        }
    }
}
