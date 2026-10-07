import Foundation
import SwiftUI
import CorptieClientCore
import CorptieConversation

struct TurnDataCompleteness: Decodable, Equatable {
    let state: String
    let droppedEventCount: Int
    let missingTerminal: Bool
    let rawCaptureStatus: String

    var status: String { state }
    var exact: Bool { state == "complete" }
}

struct TurnObservabilityIdentity: Decodable, Equatable {
    let logicalSessionId: String
    let turnId: String
    let turnExecutionId: String
    let providerBindingId: String
    let bindingGeneration: Int
}

struct TurnWallSummary: Decodable, Equatable {
    let finalized: Bool
    let wallClockMs: Double?
    let observedWatermarkMs: Double?
}

struct TurnWallPartition: Decodable, Equatable {
    let attributedUnionMs: Double
    let unattributedMs: Double
    let overlapMs: Double
}

struct TurnTimeSummary: Decodable, Equatable {
    let schemaVersion: Int
    let identity: TurnObservabilityIdentity
    let analysisVersion: String
    let wall: TurnWallSummary
    let wallPartition: TurnWallPartition
    let timeBreakdown: ConversationTurnTimeBreakdown?
    let inclusive: [String: Double]
    let spanCount: Int
    let completeness: TurnDataCompleteness

    var sessionId: String { identity.logicalSessionId }
    var logicalTurnId: String { identity.turnId }
    var turnExecutionId: String { identity.turnExecutionId }
    var observabilityLevel: String { completeness.state }
    var wallClockMs: Double { wall.wallClockMs ?? wall.observedWatermarkMs ?? 0 }
    var displayedAttributedMs: Double? { wallPartition.attributedUnionMs }
    var displayedUnattributedMs: Double? { wallPartition.unattributedMs }
    var isBoundaryOnly: Bool { inclusive.keys.contains("provider.opaque") && !inclusive.keys.contains("provider.model_sampling") }
    var dataCompleteness: TurnDataCompleteness { completeness }
}

struct TurnTimeSummaryEnvelope: Decodable { let summary: TurnTimeSummary }

struct TurnTraceSpan: Decodable, Identifiable, Equatable {
    let traceId: String
    let spanId: String
    let parentSpanId: String?
    let operation: String
    let intervalClass: String
    let startObservedAtUnixNano: String
    let endObservedAtUnixNano: String
    let status: String

    var id: String { spanId }
    var category: String { intervalClass }
    var operationDetail: String? { nil }
    var activityPhase: String? { nil }
    var codeLocation: String? { nil }
    var durationMs: Double {
        ConversationInspectorPolicy.spanDurationMilliseconds(start: startObservedAtUnixNano, end: endObservedAtUnixNano)
    }
}

struct TurnRawTrace: Decodable, Equatable {
    let spans: [TurnTraceSpan]

    enum CodingKeys: String, CodingKey { case spans = "items" }
}

private struct TurnObservabilityErrorEnvelope: Decodable { let error: String }

private enum TurnObservabilityClientError: LocalizedError {
    case server(String)
    var errorDescription: String? {
        switch self { case .server(let message): message }
    }
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

    func rawTrace(turnExecutionId: String) async throws -> TurnRawTrace {
        try await get("turn-executions/\(encoded(turnExecutionId))/spans")
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode(TurnObservabilityErrorEnvelope.self, from: data).error)
                ?? "服务端没有返回可用的 Trace"
            throw TurnObservabilityClientError.server(message)
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
    private var loadedExecutionId: String?

    func loadSummary(sessionId: String) async {
        guard loadedSessionId != sessionId else { return }
        loadedSessionId = sessionId
        loadedExecutionId = nil
        summary = nil
        trace = nil
        error = nil
        isLoadingSummary = true
        defer { isLoadingSummary = false }
        do { summary = try await TurnObservabilityClient.shared.latestSummary(sessionId: sessionId) }
        catch { self.error = error.localizedDescription }
    }

    func loadTraceIfNeeded() async {
        guard let executionId = summary?.turnExecutionId, loadedExecutionId != executionId else { return }
        loadedExecutionId = executionId
        error = nil
        isLoadingTrace = true
        defer { isLoadingTrace = false }
        do { trace = try await TurnObservabilityClient.shared.rawTrace(turnExecutionId: executionId) }
        catch { self.error = error.localizedDescription; loadedExecutionId = nil }
    }
}

struct SessionTurnObservabilityView: View {
    let sessionId: String
    @StateObject private var model = TurnObservabilityViewModel()
    @State private var isAnalysisExpanded = false
    @State private var isTraceExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ConversationDetailDisclosure(isExpanded: $isAnalysisExpanded, header: {
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
            }, content: {
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
            })
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
            metric("已归因", summary.displayedAttributedMs)
            metric("未归因", summary.displayedUnattributedMs)
        }
        Text(summary.isBoundaryOnly ? "仅有 Provider 边界观测；内部耗时未细分" : summary.observabilityLevel == "complete" ? "观测完整" : "观测不完整")
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(summary.isBoundaryOnly ? Color.orange : Color.secondary)
        if let breakdown = summary.timeBreakdown {
            ConversationTurnTimeBreakdownView(breakdown)
        } else {
            Text("旧版摘要不含分类占比")
                .font(.caption).foregroundStyle(.secondary)
        }
        ConversationDetailDisclosure(isExpanded: $isTraceExpanded, header: {
            Text("详细 Trace（按需加载）")
                .font(.system(size: 10, weight: .medium))
        }, content: {
            traceContent(summary)
                .task(id: isTraceExpanded) { if isTraceExpanded { await model.loadTraceIfNeeded() } }
        })
    }

    private func metric(_ label: String, _ milliseconds: Double?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 8)).foregroundStyle(.tertiary)
            Text(milliseconds.map { durationText($0) } ?? "—").font(.system(size: 10, weight: .semibold, design: .monospaced))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func traceContent(_ summary: TurnTimeSummary) -> some View {
        if model.isLoadingTrace {
            ProgressView().controlSize(.small).padding(.vertical, 5)
        } else if let trace = model.trace {
            if trace.spans.isEmpty {
                Text("Trace 已返回，但没有可展示的 Span")
                    .font(.system(size: 9)).foregroundStyle(.secondary)
            } else {
                let isLarge = TurnTracePresentationTier.resolve(spanCount: trace.spans.count) == .categoryAggregation
                let diagnosticSpans = trace.spans
                    .filter { $0.operation != "persistence" && $0.durationMs > 0.01 }
                    .sorted { $0.durationMs > $1.durationMs }
                let slowest = Array(diagnosticSpans.prefix(isLarge ? 30 : 10))
                LazyVStack(alignment: .leading, spacing: 4) {
                    Text("最慢操作")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                    ForEach(slowest) { span in
                        spanRow(span, index: trace.spans.firstIndex(where: { $0.id == span.id }) ?? 0, spans: trace.spans)
                    }
                    if isLarge {
                        Text("大型 Trace 共 \(trace.spans.count) 个 Span，已展示最慢 \(slowest.count) 项；JSON/OTLP 导出保留完整数据。")
                            .font(.system(size: 9)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Divider().opacity(0.45).padding(.vertical, 2)
                        Text("完整时间线")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                        ForEach(Array(trace.spans.enumerated()), id: \.element.id) { index, span in
                            spanRow(span, index: index, spans: trace.spans)
                        }
                    }
                }
            }
        } else if let error = model.error {
            VStack(alignment: .leading, spacing: 5) {
                Text("Trace 加载失败：\(error)")
                    .font(.system(size: 9)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                Button("重试") { Task { await model.loadTraceIfNeeded() } }
                    .buttonStyle(.link).font(.system(size: 9))
            }
        } else {
            Text("Trace 尚未加载")
                .font(.system(size: 9)).foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private func spanRow(_ span: TurnTraceSpan, index: Int, spans: [TurnTraceSpan]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Text(operationLabel(span.operation)).foregroundStyle(.secondary).frame(width: 58, alignment: .leading)
                Text(span.operationDetail ?? span.operation).lineLimit(1).truncationMode(.middle)
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
            if let explanation = reasoningExplanation(for: span, at: index, in: spans) {
                Text(explanation)
                    .font(.system(size: 8))
                    .foregroundStyle(explanation.hasPrefix("推断") ? Color.orange : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.system(size: 8))
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
