import SwiftUI

/// Shared process-card chrome. Platforms supply the selectable detail text leaf.
public struct ProcessCard<Details: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var summarySize: CGFloat = 10.5
    @ScaledMetric(relativeTo: .caption) private var secondarySize: CGFloat = 9.5
    @ScaledMetric(relativeTo: .caption) private var progressSize: CGFloat = 9
    @ScaledMetric(relativeTo: .caption) private var headerHeight: CGFloat = 22
    private let summary: String
    private let secondary: String?
    private let symbol: String
    private let tint: Color
    private let expanded: Bool
    private let progress: Double?
    private let progressLabel: String?
    private let toggle: () -> Void
    private let details: () -> Details

    public init(summary: String, secondary: String? = nil,
                symbol: String, tint: Color, expanded: Bool,
                progress: Double? = nil, progressLabel: String? = nil,
                toggle: @escaping () -> Void, @ViewBuilder details: @escaping () -> Details) {
        self.summary = summary; self.secondary = secondary
        self.symbol = symbol; self.tint = tint
        self.expanded = expanded; self.progress = progress; self.progressLabel = progressLabel
        self.toggle = toggle; self.details = details
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: toggle) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Image(systemName: symbol).foregroundStyle(tint)
                        Text(summary).font(.system(size: summarySize, weight: .medium))
                            .foregroundStyle(.primary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        if let progressLabel {
                            Text(progressLabel).font(.system(size: progressSize, weight: .semibold))
                                .foregroundStyle(tint)
                                .lineLimit(1)
                        }
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: progressSize, weight: .medium)).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: headerHeight, alignment: .leading)
                    if let secondary, !secondary.isEmpty {
                        Text(secondary).font(.system(size: secondarySize))
                            .foregroundStyle(.secondary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                            .padding(.leading, 20)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel([summary, progressLabel, secondary].compactMap { $0 }.joined(separator: "，"))
            .accessibilityValue(expanded ? "已展开" : "已收起")
            .accessibilityHint(expanded ? "收起执行详情" : "展开执行详情")
            .accessibilityIdentifier("chat.timeline.process-disclosure")
            if expanded { details() }
        }
        .padding(.horizontal, 10)
        .padding(.top, expanded ? 3 : 4)
        .padding(.bottom, expanded ? 13 : 4)
        .background(tint.opacity(expanded ? 0.055 : 0.035),
                    in: RoundedRectangle(cornerRadius: expanded ? 12 : 10))
        .overlay {
            RoundedRectangle(cornerRadius: expanded ? 12 : 10)
                .strokeBorder(tint.opacity(0.16), lineWidth: 1)
        }
        .overlay(alignment: .bottomLeading) {
            if let progress {
                GeometryReader { geometry in
                    Capsule().fill(tint.opacity(0.12))
                        .overlay(alignment: .leading) {
                            Capsule().fill(tint)
                                .frame(width: geometry.size.width * min(1, max(0, progress)))
                        }
                }
                .frame(height: 2)
                .padding(.horizontal, 10)
                .padding(.bottom, 2)
                .accessibilityHidden(true)
            }
        }
    }
}
