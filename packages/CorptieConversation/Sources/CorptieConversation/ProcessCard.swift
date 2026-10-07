import SwiftUI
import Observation
import CorptieClientCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Shared process-card chrome. Platforms supply the selectable detail text leaf.
@MainActor @Observable
public final class ProcessCardSummary {
    public var text: String?
    public init(text: String? = nil) { self.text = text }
}

/// Viewport geometry for the one visible, expanded process card that can be
/// collapsed after its ordinary disclosure header has scrolled away.
public struct ProcessCollapseCandidate: Equatable, Sendable {
    public let id: String
    public let frame: CGRect
    public let headerHeight: CGFloat

    public init(id: String, frame: CGRect, headerHeight: CGFloat) {
        self.id = id
        self.frame = frame
        self.headerHeight = headerHeight
    }
}

public struct ProcessCollapsePlacement: Equatable, Sendable {
    public let id: String
    public let origin: CGPoint
}

public enum ProcessCollapsePlacementPolicy {
    public static func placement(candidates: [ProcessCollapseCandidate], viewport: CGRect,
                                 handleSize: CGSize, margin: CGFloat = 10) -> ProcessCollapsePlacement? {
        guard viewport.width > 0, viewport.height > 0 else { return nil }
        let centerY = viewport.midY
        var selected: (placement: ProcessCollapsePlacement, containsCenter: Bool, visibleHeight: CGFloat)?
        for candidate in candidates {
            let visible = candidate.frame.intersection(viewport)
            guard !visible.isNull, visible.height >= max(68, handleSize.height + 2 * margin),
                  visible.width >= handleSize.width + 2 * margin,
                  candidate.frame.minY + candidate.headerHeight <= viewport.minY - 8 else { continue }
            let placement = ProcessCollapsePlacement(id: candidate.id, origin: CGPoint(
                x: visible.maxX - handleSize.width - margin,
                y: visible.maxY - handleSize.height - margin
            ))
            let containsCenter = visible.minY <= centerY && visible.maxY >= centerY
            if let current = selected {
                if current.containsCenter && !containsCenter { continue }
                if current.containsCenter == containsCenter,
                   current.visibleHeight >= visible.height { continue }
            }
            selected = (placement, containsCenter, visible.height)
        }
        return selected?.placement
    }
}

public struct ProcessCard<Details: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var summarySize: CGFloat = 10.5
    @ScaledMetric(relativeTo: .caption) private var secondarySize: CGFloat = 9.5
    @ScaledMetric(relativeTo: .caption) private var progressSize: CGFloat = 9
    @ScaledMetric(relativeTo: .caption) private var headerHeight: CGFloat = 22
    private let summary: String
    private let summaryOverride: ProcessCardSummary?
    private let liveSummary: ((Date) -> String)?
    private let secondary: String?
    private let symbol: String
    private let tint: Color
    private let expanded: Bool
    private let progress: Double?
    private let progressLabel: String?
    private let toggle: () -> Void
    private let details: () -> Details

    private var surfaceColor: Color {
        #if os(macOS)
        Color(nsColor: .controlBackgroundColor)
        #else
        Color(uiColor: .secondarySystemBackground)
        #endif
    }

    public init(summary: String, summaryOverride: ProcessCardSummary? = nil,
                liveSummary: ((Date) -> String)? = nil, secondary: String? = nil,
                symbol: String, tint: Color, expanded: Bool,
                progress: Double? = nil, progressLabel: String? = nil,
                toggle: @escaping () -> Void, @ViewBuilder details: @escaping () -> Details) {
        self.summary = summary; self.secondary = secondary
        self.summaryOverride = summaryOverride; self.liveSummary = liveSummary
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
                        ProcessCardSummaryLabel(summary: summary, override: summaryOverride, liveSummary: liveSummary)
                            .font(.system(size: summarySize, weight: .medium)).monospacedDigit()
                            .foregroundStyle(.primary)
                            #if os(macOS)
                            .lineLimit(expanded ? nil : 1)
                            #else
                            .lineLimit(nil)
                            #endif
                            #if os(macOS)
                            .fixedSize(horizontal: !expanded, vertical: true)
                            #else
                            .fixedSize(horizontal: false, vertical: true)
                            #endif
                            .layoutPriority(1)
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
        .modifier(ConversationContentSurface(cornerRadius: expanded ? 12 : 10,
            tint: tint, fallback: surfaceColor, tintOpacity: expanded ? 0.08 : 0.06))
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

/// Only this text leaf observes elapsed-time changes; details and geometry stay static.
private struct ProcessCardSummaryLabel: View {
    let summary: String
    let override: ProcessCardSummary?
    let liveSummary: ((Date) -> String)?

    var body: some View {
        Group {
            if let liveSummary {
                ProcessCardLiveSummaryLabel(summary: liveSummary)
            } else {
                Text(override?.text ?? summary)
            }
        }
    }
}

private struct ProcessCardLiveSummaryLabel: View {
    let summary: (Date) -> String
    @State private var visible = false

    var body: some View {
        TimelineView(.animation(minimumInterval: ConversationProcessPresentation.elapsedRefreshInterval,
                                paused: !visible)) { context in
            Text(summary(context.date))
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
    }
}
