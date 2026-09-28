import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

private struct ThreadProcessGroupView: View {
    let items: [CodexThreadItem]
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                // The owning timeline decides whether this state change is
                // animated. AppKit-hosted rows must not start a nested SwiftUI
                // transition while NSTableView is updating row geometry.
                onToggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .frame(width: 12, height: 12)
                    Text(L10n("Execution process"))
                        .font(.system(size: 10.5, weight: .semibold))
                    if let durationText {
                        Text(durationText)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(CorptiePalette.mutedText)
                    }
                    Text("\(items.count)")
                        .font(.system(size: 9.5, weight: .medium, design: .rounded))
                        .foregroundStyle(CorptiePalette.mutedText)
                }
                .foregroundStyle(CorptiePalette.secondaryText)
                .frame(height: 22)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(items) { item in
                        ProcessTimelineStep(item: item)
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .identity
                            ))
                    }
                }
                .padding(.leading, 6)
                .padding(.top, 1)
                .clipped()
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.vertical, 2)
        .frame(
            idealWidth: processContentWidth,
            maxWidth: processContentWidth,
            alignment: .leading
        )
        // Execution belongs to the Agent side of the turn, not to the user's
        // prompt. Keep the standalone disclosure card on the same leading edge
        // as the Agent reply in both the SwiftUI and AppKit-hosted timelines.
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n("Execution process"))
    }

    private var processContentWidth: CGFloat {
        isExpanded
            ? ChatBubbleWidthPolicy.maximumWidth
            : ChatBubbleWidthPolicy.collapsedProcessWidth + ChatBubbleWidthPolicy.horizontalPadding
    }

    private var durationText: String? {
        let timestamps = items.compactMap { item -> Date? in
            guard let createdAt = item.createdAt else {
                return nil
            }
            return ISO8601DateFormatter.corptieThreadItemDate(from: createdAt)
        }
        guard let start = timestamps.min(), let end = timestamps.max() else {
            return nil
        }
        let duration = max(0, end.timeIntervalSince(start))
        if duration < 0.95 {
            return "· <1s"
        }
        if duration < 10 {
            return String(format: "· %.1fs", duration)
        }
        return "· \(Int(duration.rounded()))s"
    }
}

private struct ProcessTimelineStep: View {
    let item: CodexThreadItem

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(spacing: 0) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 6, height: 6)
                    .padding(.top, 4)
                Rectangle()
                    .fill(CorptiePalette.mutedText.opacity(0.18))
                    .frame(width: 1)
                    .frame(minHeight: hasText ? 24 : 8)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(item.title)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .lineLimit(1)
                    Text(processTypeLabel)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(CorptiePalette.mutedText.opacity(0.72))
                    Spacer(minLength: 0)
                }

                if hasText {
                    Text(item.text)
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(CorptiePalette.mutedText)
                        .lineSpacing(2)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var hasText: Bool {
        !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var dotColor: Color {
        switch item.type {
        case "commandExecution":
            return CorptiePalette.amber
        case "fileChange":
            return CorptiePalette.periwinkle
        case "webSearch":
            return CorptiePalette.softBlue
        case "reasoning", "plan":
            return CorptiePalette.mutedText
        default:
            return CorptiePalette.connected
        }
    }

    private var processTypeLabel: String {
        item.type == "agentMessage" ? "commentary" : item.type
    }
}

extension ISO8601DateFormatter {
    private nonisolated(unsafe) static let corptieThreadItemWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private nonisolated(unsafe) static let corptieThreadItemWithoutFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func corptieThreadItemDate(from value: String) -> Date? {
        if let date = corptieThreadItemWithFraction.date(from: value) {
            return date
        }
        return corptieThreadItemWithoutFraction.date(from: value)
    }
}
