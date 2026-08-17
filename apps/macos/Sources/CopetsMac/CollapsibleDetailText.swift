import SwiftUI

enum CollapsibleDetailTextLayout {
    static func isOverflowing(
        fullHeight: CGFloat,
        collapsedHeight: CGFloat,
        tolerance: CGFloat = 0.5
    ) -> Bool {
        fullHeight > collapsedHeight + tolerance
    }
}

/// A shared read-only detail text presentation that keeps long content from
/// dominating its card while still making the complete value accessible.
struct CollapsibleDetailText: View {
    let text: String
    var collapsedLineLimit = 5
    var font: Font = .system(size: 12)
    var color: Color = .secondary
    var lineSpacing: CGFloat = 2

    @State private var isExpanded = false
    @State private var fullTextHeight: CGFloat = 0
    @State private var collapsedTextHeight: CGFloat = 0

    private var isOverflowing: Bool {
        CollapsibleDetailTextLayout.isOverflowing(
            fullHeight: fullTextHeight,
            collapsedHeight: collapsedTextHeight
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            renderedText
                .lineLimit(isExpanded ? nil : collapsedLineLimit)
                .background(measurementViews)

            if isOverflowing {
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) {
                        isExpanded.toggle()
                    }
                } label: {
                    Label(
                        L10n(isExpanded ? "Collapse" : "Expand"),
                        systemImage: isExpanded ? "chevron.up" : "chevron.down"
                    )
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("collapsible-detail-text-toggle")
            }
        }
        .onPreferenceChange(FullDetailTextHeightPreferenceKey.self) {
            fullTextHeight = $0
        }
        .onPreferenceChange(CollapsedDetailTextHeightPreferenceKey.self) {
            collapsedTextHeight = $0
        }
        .onChange(of: text) { _, _ in
            isExpanded = false
        }
    }

    private var renderedText: some View {
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    private var measurementViews: some View {
        ZStack {
            renderedText
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: FullDetailTextHeightPreferenceKey.self,
                            value: proxy.size.height
                        )
                    }
                }

            renderedText
                .lineLimit(collapsedLineLimit)
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: CollapsedDetailTextHeightPreferenceKey.self,
                            value: proxy.size.height
                        )
                    }
                }
        }
        .hidden()
        .accessibilityHidden(true)
    }
}

private struct FullDetailTextHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct CollapsedDetailTextHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
