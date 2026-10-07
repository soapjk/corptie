import Foundation
import SwiftUI
import CorptieClientCore

/// Mutually exclusive wall-clock slices supplied by the observability service.
public struct ConversationTurnTimeBreakdown: Decodable, Equatable, Sendable {
    public struct Entry: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let durationMs: Double
    }

    public let schemaVersion: Int
    public let policyVersion: String
    public let totalMs: Double
    public let categories: [Entry]
    public let toolOperations: [Entry]

    public init?(inspectorValue: ClientInspectorValue) {
        guard let version = inspectorValue["schemaVersion"].number,
              version == 1,
              let policy = inspectorValue["policyVersion"].text,
              let total = inspectorValue["totalMs"].number,
              total.isFinite, total >= 0 else { return nil }
        func entries(_ value: ClientInspectorValue) -> [Entry]? {
            guard case .array = value else { return nil }
            return value.items.compactMap { item in
                guard let id = item["id"].text, let duration = item["durationMs"].number,
                      duration.isFinite, duration >= 0 else { return nil }
                return Entry(id: id, durationMs: duration)
            }
        }
        guard let categories = entries(inspectorValue["categories"]),
              let operations = entries(inspectorValue["toolOperations"]) else { return nil }
        self.schemaVersion = Int(version)
        self.policyVersion = policy
        self.totalMs = total
        self.categories = categories
        self.toolOperations = operations
    }
}

public struct ConversationTurnTimeBreakdownView: View {
    public let breakdown: ConversationTurnTimeBreakdown
    @State private var toolsExpanded = false

    public init(_ breakdown: ConversationTurnTimeBreakdown) { self.breakdown = breakdown }

    private var categories: [ConversationTurnTimeBreakdown.Entry] {
        breakdown.categories.filter { $0.durationMs > 0 }.sorted { $0.durationMs > $1.durationMs }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            GeometryReader { geometry in
                HStack(spacing: 0) {
                    ForEach(categories) { entry in
                        color(entry.id).frame(width: max(0, geometry.size.width * entry.durationMs / max(1, breakdown.totalMs)))
                    }
                }
                .frame(height: 8)
                .clipShape(RoundedRectangle(cornerRadius: 4))
            }
            .frame(height: 8)
            .accessibilityHidden(true)
            ForEach(categories) { entry in
                row(entry, total: breakdown.totalMs)
            }
            if !breakdown.toolOperations.isEmpty {
                DisclosureGroup("工具细分", isExpanded: $toolsExpanded) {
                    ForEach(breakdown.toolOperations.filter { $0.durationMs > 0 }.sorted { $0.durationMs > $1.durationMs }) { entry in
                        row(entry, total: breakdown.categories.first(where: { $0.id == "tool" })?.durationMs ?? 0, isTool: true)
                    }
                }
                .font(.caption)
            }
            Text("并行跨类单列；未知时间不归入模型或网络")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func row(_ entry: ConversationTurnTimeBreakdown.Entry, total: Double, isTool: Bool = false) -> some View {
        HStack(spacing: 6) {
            if !isTool { Circle().fill(color(entry.id)).frame(width: 6, height: 6).accessibilityHidden(true) }
            Text(label(entry.id)).frame(maxWidth: .infinity, alignment: .leading)
            Text(format(entry.durationMs)).monospacedDigit()
            Text(percent(entry.durationMs, total: total)).monospacedDigit().frame(width: 42, alignment: .trailing)
        }
        .font(.caption)
        .accessibilityElement(children: .combine)
    }

    private func percent(_ value: Double, total: Double) -> String {
        guard total > 0 else { return "0%" }
        let percentage = value / total * 100
        return percentage > 0 && percentage < 1 ? "<1%" : String(format: "%.0f%%", percentage)
    }

    private func format(_ value: Double) -> String {
        value >= 1_000 ? String(format: "%.2fs", value / 1_000) : String(format: "%.0fms", value)
    }

    private func label(_ id: String) -> String {
        ["setup": "准备与排队", "model": "模型响应", "provider": "Provider 未细分", "tool": "工具与本地操作",
         "wait": "等待", "overlap": "跨类并行", "unattributed": "未归因", "code.edit": "代码修改",
         "code.search": "代码搜索", "code.read": "代码读取", "test": "测试", "build": "构建", "git": "版本控制",
         "mcp": "MCP", "artifact": "产物操作", "parallel": "工具内并行", "other": "其他工具时间"][id] ?? id
    }

    private func color(_ id: String) -> Color {
        switch id {
        case "model": .blue
        case "tool": .green
        case "setup": .purple
        case "wait": .orange
        case "provider": .teal
        case "overlap": .pink
        default: .gray
        }
    }
}
