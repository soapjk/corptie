import SwiftUI
import CorptieClientCore

/// A bounded, provider-neutral presentation of one tool or change-set item.
/// Full backend-sanitized input, output and diff remain on demand in the host.
public struct ExecutionStructuredStepPresentation: Sendable {
    public struct Row: Identifiable, Sendable {
        public enum Kind: Equatable, Sendable { case input, result, file, more, detail }
        public let id: Int
        public let kind: Kind
        public let label: String
        public let value: String
        public let symbol: String
    }

    public let step: ConversationExecutionStep
    public let rows: [Row]
    public let hasOverflow: Bool
    public var height: CGFloat { 18 + CGFloat(rows.count) * 22 }

    public init(step: ConversationExecutionStep) {
        self.step = step
        var rows: [Row] = []
        var overflow = false
        func append(_ kind: Row.Kind, label: String, value: String, symbol: String = "") {
            rows.append(.init(id: rows.count, kind: kind, label: label,
                value: value, symbol: symbol))
        }
        func preview(_ value: String) -> String {
            let flat = value.replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if flat != value || flat.count > 90 { overflow = true }
            return flat.count > 90 ? String(flat.prefix(90)) + "…" : flat
        }
        if let tool = step.tool {
            if let input = tool.input, !input.isEmpty, step.changeSet == nil {
                append(.input, label: "输入", value: preview(input))
            } else if tool.input?.isEmpty == false {
                overflow = true // Change-set owns the visible file input.
            }
            if let result = tool.result, !result.isEmpty {
                append(.result, label: "结果", value: preview(result))
            }
        }
        if let changes = step.changeSet {
            append(.detail, label: "文件", value: "\(changes.changes.count) 个变更")
            for change in changes.changes.prefix(3) {
                append(.file, label: change.kind, value: preview(change.path), symbol: change.marker)
                if change.diffPreview?.isEmpty == false || change.diffTruncated { overflow = true }
            }
            if changes.changes.count > 3 {
                append(.more, label: "还有", value: "\(changes.changes.count - 3) 个文件")
                overflow = true
            }
            if changes.truncated { overflow = true }
        }
        if let detail = step.detail, !detail.isEmpty {
            append(.detail, label: "说明", value: preview(detail))
        }
        self.rows = rows
        hasOverflow = overflow
    }
}

public struct ExecutionStructuredStepView: View {
    public let presentation: ExecutionStructuredStepPresentation
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var titleSize: CGFloat = 10.5
    @ScaledMetric(relativeTo: .caption) private var statusSize: CGFloat = 9.5
    @ScaledMetric(relativeTo: .caption) private var labelSize: CGFloat = 9
    @ScaledMetric(relativeTo: .caption) private var valueSize: CGFloat = 10
    @ScaledMetric(relativeTo: .caption) private var markerWidth: CGFloat = 12

    public init(presentation: ExecutionStructuredStepPresentation) {
        self.presentation = presentation
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: presentation.step.changeSet == nil ? "terminal" : "doc.text")
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text(presentation.step.tool?.name ?? presentation.step.title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                Spacer(minLength: 4)
                Image(systemName: statusSymbol)
                    .foregroundStyle(statusColor)
                    .accessibilityHidden(true)
                Text(statusLabel)
                    .font(.system(size: statusSize, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .frame(height: headerHeight)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(presentation.step.title)，\(statusLabel)")

            ForEach(presentation.rows) { row in
                HStack(spacing: 6) {
                    if !row.symbol.isEmpty {
                        Text(row.symbol).font(.system(size: valueSize, weight: .bold))
                            .foregroundStyle(row.label == "delete" ? Color.red : Color.secondary)
                            .frame(width: markerWidth)
                            .accessibilityHidden(true)
                    }
                    Text(row.label)
                        .font(.system(size: labelSize, weight: .medium))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: true, vertical: false)
                    Text(row.value)
                        .font(.system(size: valueSize, design: row.kind == .file ? .monospaced : .default))
                        .foregroundStyle(.primary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                        .truncationMode(.middle)
                }
                .frame(height: detailRowHeight, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(row.label)：\(row.value)")
            }
        }
        .frame(height: cardHeight, alignment: .topLeading)
        .accessibilityIdentifier("execution-structured-step")
    }

    private var headerHeight: CGFloat? {
        #if os(iOS)
        nil
        #else
        18
        #endif
    }

    private var detailRowHeight: CGFloat? {
        #if os(iOS)
        nil
        #else
        17
        #endif
    }

    private var cardHeight: CGFloat? {
        #if os(iOS)
        nil
        #else
        presentation.height
        #endif
    }

    private var statusLabel: String {
        switch presentation.step.state {
        case .running: "进行中"
        case .completed: "已完成"
        case .failed: "失败"
        case .cancelled: "已取消"
        case .unknown: "状态未知"
        }
    }

    private var statusSymbol: String {
        switch presentation.step.state {
        case .running: "circle.dotted"
        case .completed: "checkmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        case .cancelled: "stop.circle"
        case .unknown: "questionmark.circle"
        }
    }

    private var statusColor: Color {
        switch presentation.step.state {
        case .running: .accentColor
        case .completed: .green
        case .failed: .red
        case .cancelled, .unknown: .secondary
        }
    }
}
