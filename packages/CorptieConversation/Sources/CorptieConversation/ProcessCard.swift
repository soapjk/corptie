import SwiftUI

/// Shared process-card chrome. Platforms supply the selectable detail text leaf.
public struct ProcessCard<Details: View>: View {
    private let summary: String
    private let symbol: String
    private let tint: Color
    private let expanded: Bool
    private let toggle: () -> Void
    private let details: () -> Details

    public init(summary: String, symbol: String, tint: Color, expanded: Bool,
                toggle: @escaping () -> Void, @ViewBuilder details: @escaping () -> Details) {
        self.summary = summary; self.symbol = symbol; self.tint = tint
        self.expanded = expanded; self.toggle = toggle; self.details = details
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    Image(systemName: symbol).foregroundStyle(tint)
                    Text(summary).font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(Color(red: 0.24, green: 0.27, blue: 0.29))
                        .lineLimit(1)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summary)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
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
    }
}
