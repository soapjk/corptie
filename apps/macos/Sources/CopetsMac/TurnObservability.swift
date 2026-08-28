import Foundation
import SwiftUI

struct TurnTimeCategory: Decodable, Equatable {
    let inclusiveMs: Double?
    let estimateMs: Double?
    let precise: Bool

    var durationMs: Double { inclusiveMs ?? estimateMs ?? 0 }
}

struct TurnDataCompleteness: Decodable, Equatable {
    let status: String
    let coverageRatio: Double
    let exact: Bool
    let spanCount: Int
}

struct TurnTimeSummary: Decodable, Equatable {
    let tenantId: String
    let sessionId: String
    let logicalTurnId: String
    let turnRunId: String
    let providerId: String
    let providerSessionId: String?
    let bindingId: String
    let agentId: String?
    let objectiveId: String?
    let workItemId: String?
    let workspaceId: String?
    let analysisVersion: String
    let observabilityLevel: String
    let wallClockMs: Double
    let criticalPathMs: Double?
    let estimatedCriticalPathMs: Double?
    let unattributedMs: Double?
    let estimatedUnattributedMs: Double?
    let categories: [String: TurnTimeCategory]
    let developmentOperations: [String: TurnTimeCategory]?
    let spanCount: Int
    let dataCompleteness: TurnDataCompleteness
    let retryCount: Int
    let recovered: Bool
    let startedAt: String
    let endedAt: String

    var displayedCriticalPathMs: Double? { criticalPathMs ?? estimatedCriticalPathMs }
    var displayedUnattributedMs: Double? { unattributedMs ?? estimatedUnattributedMs }
    var isBoundaryOnly: Bool { observabilityLevel == "boundary-only" }
}

struct TurnTimeSummaryEnvelope: Decodable { let summary: TurnTimeSummary }

struct TurnTraceSpan: Decodable, Identifiable, Equatable {
    let traceId: String
    let spanId: String
    let parentSpanId: String?
    let name: String
    let startTimeUnixNano: String
    let endTimeUnixNano: String
    let status: String
    let attributes: [String: TurnTraceAttribute]

    var id: String { spanId }
    var category: String { attributes["corptie.category"]?.stringValue ?? "other" }
    var operation: String { attributes["corptie.operation"]?.stringValue ?? "other" }
    var activityPhase: String? { attributes["corptie.activity.phase"]?.stringValue }
    var codeLocation: String? {
        guard let path = attributes["code.file.path"]?.stringValue else { return nil }
        let line = attributes["code.line.number"]?.stringValue
        let function = attributes["code.function.name"]?.stringValue
        let normalizedLine = line.map { $0.hasSuffix(".0") ? String($0.dropLast(2)) : $0 }
        return [normalizedLine.map { "\(path):\($0)" } ?? path, function]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
    var durationMs: Double {
        guard let start = Decimal(string: startTimeUnixNano),
              let end = Decimal(string: endTimeUnixNano) else { return 0 }
        return NSDecimalNumber(decimal: end - start).doubleValue / 1_000_000
    }

    enum CodingKeys: CodingKey { case traceId, spanId, parentSpanId, name, startTimeUnixNano, endTimeUnixNano, status, attributes }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        traceId = try container.decode(String.self, forKey: .traceId)
        spanId = try container.decode(String.self, forKey: .spanId)
        parentSpanId = try container.decodeIfPresent(String.self, forKey: .parentSpanId)
        name = try container.decode(String.self, forKey: .name)
        startTimeUnixNano = try container.decode(String.self, forKey: .startTimeUnixNano)
        endTimeUnixNano = try container.decode(String.self, forKey: .endTimeUnixNano)
        status = try container.decode(String.self, forKey: .status)
        let values = try container.decode([String: JSONScalar].self, forKey: .attributes)
        attributes = values.mapValues(TurnTraceAttribute.init)
    }
}

struct TurnTraceAttribute: Equatable {
    let stringValue: String
    init(_ scalar: JSONScalar) { stringValue = scalar.description }
}

enum JSONScalar: Decodable, CustomStringConvertible {
    case string(String), number(Double), boolean(Bool)

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let string = try? value.decode(String.self) { self = .string(string) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let boolean = try? value.decode(Bool.self) { self = .boolean(boolean) }
        else { throw DecodingError.typeMismatch(JSONScalar.self, .init(codingPath: decoder.codingPath, debugDescription: "Trace attributes must be scalar.")) }
    }

    var description: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return String(value)
        case .boolean(let value): return String(value)
        }
    }
}

struct TurnRawTrace: Decodable, Equatable {
    let observabilityLevel: String
    let spans: [TurnTraceSpan]
}

enum TurnTracePresentationTier: Equatable {
    case spans
    case categoryAggregation

    static func resolve(spanCount: Int, threshold: Int = 200) -> Self {
        spanCount > threshold ? .categoryAggregation : .spans
    }
}

@MainActor
final class TurnObservabilityClient {
    static let shared = TurnObservabilityClient()
    private let baseURL = CorptieAppEnvironment.backendBaseURL

    func latestSummary(sessionId: String) async throws -> TurnTimeSummary {
        let envelope: TurnTimeSummaryEnvelope = try await get("sessions/\(encoded(sessionId))/turn-observability/latest")
        return envelope.summary
    }

    func rawTrace(turnRunId: String) async throws -> TurnRawTrace {
        try await get("turn-runs/\(encoded(turnRunId))/trace")
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }
}

@MainActor
final class TurnObservabilityViewModel: ObservableObject {
    @Published private(set) var summary: TurnTimeSummary?
    @Published private(set) var trace: TurnRawTrace?
    @Published private(set) var isLoadingSummary = false
    @Published private(set) var isLoadingTrace = false
    @Published private(set) var error: String?
    private var loadedSessionId: String?
    private var loadedRunId: String?

    func loadSummary(sessionId: String) async {
        guard loadedSessionId != sessionId else { return }
        loadedSessionId = sessionId
        loadedRunId = nil
        summary = nil
        trace = nil
        error = nil
        isLoadingSummary = true
        defer { isLoadingSummary = false }
        do { summary = try await TurnObservabilityClient.shared.latestSummary(sessionId: sessionId) }
        catch { self.error = error.localizedDescription }
    }

    func loadTraceIfNeeded() async {
        guard let runId = summary?.turnRunId, loadedRunId != runId else { return }
        loadedRunId = runId
        isLoadingTrace = true
        defer { isLoadingTrace = false }
        do { trace = try await TurnObservabilityClient.shared.rawTrace(turnRunId: runId) }
        catch { self.error = error.localizedDescription; loadedRunId = nil }
    }
}

struct SessionTurnObservabilityView: View {
    let sessionId: String
    @StateObject private var model = TurnObservabilityViewModel()
    @State private var isAnalysisExpanded = false
    @State private var isTraceExpanded = false

    private let categoryOrder = ["queue", "dispatch", "context", "model", "tool", "mcp", "persistence", "delivery", "other"]
    private let operationOrder = ["history.read", "code.search", "code.read", "code.edit", "shell", "git", "test", "build", "mcp", "model.reasoning", "persistence", "other"]

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            DisclosureGroup(isExpanded: $isAnalysisExpanded) {
                Group {
                    if model.isLoadingSummary {
                        ProgressView().controlSize(.small)
                    } else if let summary = model.summary {
                        summaryContent(summary)
                    } else {
                        Text("暂无已完成 Turn 的时间摘要")
                            .font(.system(size: 10))
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.top, 4)
            } label: {
                HStack(spacing: 6) {
                    Label("Turn 时间分析", systemImage: "point.3.connected.trianglepath.dotted")
                    Spacer(minLength: 6)
                    if model.isLoadingSummary {
                        ProgressView().controlSize(.mini)
                    } else if let summary = model.summary {
                        Text("上一次 \(durationText(summary.wallClockMs))")
                            .fontDesign(.monospaced)
                    } else {
                        Text("暂无数据")
                    }
                }
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
            }
        }
        .task(id: sessionId) {
            isAnalysisExpanded = false
            isTraceExpanded = false
            await model.loadSummary(sessionId: sessionId)
        }
    }

    @ViewBuilder
    private func summaryContent(_ summary: TurnTimeSummary) -> some View {
        HStack(spacing: 8) {
            metric("总耗时", summary.wallClockMs)
            metric("关键路径", summary.displayedCriticalPathMs)
            metric("未归因", summary.displayedUnattributedMs)
        }
        Text(summary.isBoundaryOnly ? "边界观测 · 数值为估算" : "\(summary.observabilityLevel) · 覆盖 \(Int(summary.dataCompleteness.coverageRatio * 100))%")
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(summary.isBoundaryOnly ? Color.orange : Color.secondary)
        categoryBars(summary)
        if let operations = summary.developmentOperations,
           operations.values.contains(where: { $0.durationMs > 0 }) {
            Divider().opacity(0.45)
            Text("开发链路")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.tertiary)
            operationRows(operations)
        }
        DisclosureGroup(isExpanded: $isTraceExpanded) {
            traceContent(summary)
                .task(id: isTraceExpanded) { if isTraceExpanded { await model.loadTraceIfNeeded() } }
        } label: {
            Text("详细 Trace（按需加载）")
                .font(.system(size: 10, weight: .medium))
        }
    }

    private func metric(_ label: String, _ milliseconds: Double?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 8)).foregroundStyle(.tertiary)
            Text(milliseconds.map { durationText($0) } ?? "—").font(.system(size: 10, weight: .semibold, design: .monospaced))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func categoryBars(_ summary: TurnTimeSummary) -> some View {
        VStack(spacing: 4) {
            ForEach(categoryOrder, id: \.self) { category in
                if let value = summary.categories[category], value.durationMs > 0 {
                    HStack(spacing: 5) {
                        Text(categoryLabel(category)).frame(width: 42, alignment: .leading)
                        GeometryReader { geometry in
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color.accentColor.opacity(0.55))
                                .frame(width: max(2, geometry.size.width * min(1, value.durationMs / max(1, summary.wallClockMs))))
                        }
                        .frame(height: 4)
                        Text(durationText(value.durationMs)).font(.system(size: 8, design: .monospaced)).frame(width: 44, alignment: .trailing)
                    }
                    .font(.system(size: 8))
                }
            }
        }
    }

    private func operationRows(_ operations: [String: TurnTimeCategory]) -> some View {
        VStack(spacing: 4) {
            ForEach(operationOrder, id: \.self) { operation in
                if let value = operations[operation], value.durationMs > 0 {
                    HStack(spacing: 5) {
                        Text(operationLabel(operation))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(durationText(value.durationMs))
                            .fontDesign(.monospaced)
                    }
                    .font(.system(size: 9))
                }
            }
        }
    }

    @ViewBuilder
    private func traceContent(_ summary: TurnTimeSummary) -> some View {
        if model.isLoadingTrace {
            ProgressView().controlSize(.small).padding(.vertical, 5)
        } else if let trace = model.trace {
            if TurnTracePresentationTier.resolve(spanCount: trace.spans.count) == .categoryAggregation {
                Text("大型 Trace（\(trace.spans.count) spans）已按类别分级聚合；JSON/OTLP 导出可获取完整数据。")
                    .font(.system(size: 9)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(trace.spans.enumerated()), id: \.element.id) { index, span in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 5) {
                                Text(operationLabel(span.operation)).foregroundStyle(.secondary).frame(width: 58, alignment: .leading)
                                Text(span.name).lineLimit(1)
                                Spacer(minLength: 2)
                                Text(durationText(span.durationMs)).fontDesign(.monospaced)
                            }
                            if let location = span.codeLocation {
                                Text(location)
                                    .font(.system(size: 8, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            if let explanation = reasoningExplanation(for: span, at: index, in: trace.spans) {
                                Text(explanation)
                                    .font(.system(size: 8))
                                    .foregroundStyle(explanation.hasPrefix("推断") ? Color.orange : Color.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .font(.system(size: 8))
                    }
                }
            }
        }
    }

    private func durationText(_ value: Double) -> String { value >= 1_000 ? String(format: "%.2fs", value / 1_000) : String(format: "%.0fms", value) }
    private func categoryLabel(_ value: String) -> String { ["queue": "排队", "dispatch": "调度", "context": "上下文", "model": "模型", "tool": "工具", "mcp": "MCP", "persistence": "持久化", "delivery": "交付", "other": "其他"][value] ?? value }
    private func reasoningExplanation(for span: TurnTraceSpan, at index: Int, in spans: [TurnTraceSpan]) -> String? {
        guard span.operation == "model.reasoning" else { return nil }
        if let phase = span.activityPhase, phase != "provider-reasoning", phase != "unknown" {
            return "模型阶段：\(activityPhaseLabel(phase))"
        }
        let ignored = Set(["model.reasoning", "persistence", "other"])
        if let next = spans.suffix(from: min(index + 1, spans.count))
            .first(where: { !ignored.contains($0.operation) }) {
            return "推断用途：为下一步「\(operationLabel(next.operation))」进行分析"
        }
        if index > 0, let previous = spans[..<index]
            .last(where: { !ignored.contains($0.operation) }) {
            return "推断用途：处理「\(operationLabel(previous.operation))」结果并形成下一步"
        }
        return "用途不可判定 · Provider 未提供安全阶段标签"
    }

    private func activityPhaseLabel(_ value: String) -> String { [
        "task-planning": "任务规划", "provider-reasoning": "Provider 推理", "progress-update": "进度整理",
        "result-synthesis": "结果整理", "code-navigation": "代码定位", "implementation": "实现",
        "verification": "验证", "context-loading": "上下文加载", "tool-execution": "工具执行", "unknown": "未知"
    ][value] ?? value }

    private func operationLabel(_ value: String) -> String { [
        "history.read": "历史读取", "code.search": "代码定位", "code.read": "代码读取", "code.edit": "代码修改",
        "shell": "Shell", "git": "Git", "test": "测试", "build": "构建", "mcp": "MCP",
        "model.reasoning": "模型推理", "persistence": "数据写入", "other": "其他"
    ][value] ?? value }
}
