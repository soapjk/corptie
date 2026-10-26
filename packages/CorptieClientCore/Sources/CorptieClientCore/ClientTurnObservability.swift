import Foundation
import Observation

public struct ClientTurnTimeBreakdown: Decodable, Equatable, Sendable {
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
        guard inspectorValue["schemaVersion"].number == 1, let policy = inspectorValue["policyVersion"].text,
              let total = inspectorValue["totalMs"].number, total.isFinite, total >= 0 else { return nil }
        func entries(_ value: ClientInspectorValue) -> [Entry]? {
            guard case .array(let items) = value, items.count <= 128 else { return nil }
            var result: [Entry] = []
            for item in items {
                guard let id = item["id"].text, !id.isEmpty,
                      let duration = item["durationMs"].number, duration.isFinite, duration >= 0 else { return nil }
                guard !result.contains(where: { $0.id == id }) else { return nil }
                result.append(.init(id: id, durationMs: duration))
            }
            return result
        }
        guard let categories = entries(inspectorValue["categories"]), let operations = entries(inspectorValue["toolOperations"]) else { return nil }
        schemaVersion = 1; policyVersion = policy; totalMs = total; self.categories = categories; toolOperations = operations
    }
}
public struct ClientTurnCompleteness: Decodable, Equatable, Sendable {
    public let state: String
    public let droppedEventCount: Int
    public let missingTerminal: Bool
    public let rawCaptureStatus: String
    public var status: String { state }
    public var exact: Bool { state == "complete" }
}
public struct ClientTurnIdentity: Decodable, Equatable, Sendable {
    public let logicalSessionId: String
    public let turnId: String
    public let turnExecutionId: String
    public let providerBindingId: String
    public let bindingGeneration: Int
}
public struct ClientTurnWall: Decodable, Equatable, Sendable {
    public let finalized: Bool
    public let wallClockMs: Double?
    public let observedWatermarkMs: Double?
}
public struct ClientTurnPartition: Decodable, Equatable, Sendable {
    public let attributedUnionMs: Double
    public let unattributedMs: Double
    public let overlapMs: Double
}
public struct ClientTurnSummary: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let identity: ClientTurnIdentity
    public let analysisVersion: String
    public let wall: ClientTurnWall
    public let wallPartition: ClientTurnPartition
    public let timeBreakdown: ClientTurnTimeBreakdown?
    public let inclusive: [String: Double]
    public let spanCount: Int
    public let completeness: ClientTurnCompleteness
    public var sessionId: String { identity.logicalSessionId }
    public var logicalTurnId: String { identity.turnId }
    public var turnExecutionId: String { identity.turnExecutionId }
    public var observabilityLevel: String { completeness.state }
    public var wallClockMs: Double { wall.wallClockMs ?? wall.observedWatermarkMs ?? 0 }
    public var displayedAttributedMs: Double? { wallPartition.attributedUnionMs }
    public var displayedUnattributedMs: Double? { wallPartition.unattributedMs }
    public var isBoundaryOnly: Bool { inclusive.keys.contains("provider.opaque") && !inclusive.keys.contains("provider.model_sampling") }
    public var dataCompleteness: ClientTurnCompleteness { completeness }

    public init?(inspectorValue value: ClientInspectorValue, expectedSessionIDs: [String]) {
        func integer(_ value: ClientInspectorValue, default fallback: Int) -> Int? {
            if value == .null { return fallback }
            guard let number = value.number, number.isFinite, number.rounded(.towardZero) == number,
                  number >= 0, number <= 9_007_199_254_740_991 else { return nil }
            return Int(number)
        }
        let source = value["identity"]
        guard let session = source["logicalSessionId"].text, expectedSessionIDs.contains(session),
              let execution = source["turnExecutionId"].text, !execution.isEmpty,
              let schema = integer(value["schemaVersion"], default: 1),
              let generation = integer(source["bindingGeneration"], default: 0),
              let count = integer(value["spanCount"], default: 0),
              let dropped = integer(value["completeness"]["droppedEventCount"], default: 0) else { return nil }
        schemaVersion = schema
        identity = .init(logicalSessionId: session, turnId: source["turnId"].text ?? "", turnExecutionId: execution,
            providerBindingId: source["providerBindingId"].text ?? "", bindingGeneration: generation)
        analysisVersion = value["analysisVersion"].text ?? ""
        wall = .init(finalized: value["wall"]["finalized"].flag, wallClockMs: value["wall"]["wallClockMs"].number,
            observedWatermarkMs: value["wall"]["observedWatermarkMs"].number)
        guard let attributed = value["wallPartition"]["attributedUnionMs"].number,
              let unattributed = value["wallPartition"]["unattributedMs"].number else { return nil }
        wallPartition = .init(attributedUnionMs: attributed, unattributedMs: unattributed, overlapMs: value["wallPartition"]["overlapMs"].number ?? 0)
        timeBreakdown = ClientTurnTimeBreakdown(inspectorValue: value["timeBreakdown"])
        if value["timeBreakdown"] != .null, timeBreakdown == nil { return nil }
        inclusive = value["inclusive"].fields.compactMapValues(\.number)
        spanCount = count
        let completeness = value["completeness"]
        self.completeness = .init(state: completeness["state"].text ?? "partial",
            droppedEventCount: dropped, missingTerminal: completeness["missingTerminal"].flag,
            rawCaptureStatus: completeness["rawCaptureStatus"].text ?? "")
    }
    public var isValid: Bool {
        let values = [wall.wallClockMs, wall.observedWatermarkMs, wallPartition.attributedUnionMs, wallPartition.unattributedMs, wallPartition.overlapMs].compactMap { $0 }
        return schemaVersion == 1 && !identity.logicalSessionId.isEmpty && !identity.turnExecutionId.isEmpty
            && spanCount >= 0 && values.allSatisfy { $0.isFinite && $0 >= 0 }
            && inclusive.count <= 128 && inclusive.values.allSatisfy { $0.isFinite && $0 >= 0 }
            && (timeBreakdown.map { $0.totalMs.isFinite && $0.totalMs >= 0 && $0.categories.count <= 128 && $0.toolOperations.count <= 128
                && ($0.categories + $0.toolOperations).allSatisfy { $0.durationMs.isFinite && $0.durationMs >= 0 }
                && $0.categories.reduce(0, { $0 + $1.durationMs }) <= $0.totalMs + max(1, $0.totalMs * 0.001) } ?? true)
    }
}
public struct ClientTurnTraceSpan: Decodable, Identifiable, Equatable, Sendable {
    public let traceId: String
    public let spanId: String
    public let parentSpanId: String?
    public let operation: String
    public let intervalClass: String
    public let startObservedAtUnixNano: String
    public let endObservedAtUnixNano: String
    public let status: String
    private let measuredDurationMs: Double
    public var id: String { spanId }
    public var category: String { intervalClass }
    public var operationDetail: String? { nil }
    public var activityPhase: String? { nil }
    public var codeLocation: String? { nil }
    public var durationMs: Double { measuredDurationMs }
    private enum CodingKeys: String, CodingKey { case traceId, spanId, parentSpanId, operation, intervalClass, startObservedAtUnixNano, endObservedAtUnixNano, status }
    public init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        traceId = try value.decode(String.self, forKey: .traceId); spanId = try value.decode(String.self, forKey: .spanId)
        parentSpanId = try value.decodeIfPresent(String.self, forKey: .parentSpanId)
        operation = try value.decode(String.self, forKey: .operation); intervalClass = try value.decode(String.self, forKey: .intervalClass)
        startObservedAtUnixNano = try value.decode(String.self, forKey: .startObservedAtUnixNano)
        endObservedAtUnixNano = try value.decode(String.self, forKey: .endObservedAtUnixNano); status = try value.decode(String.self, forKey: .status)
        measuredDurationMs = ConversationInspectorPolicy.spanDurationMilliseconds(start: startObservedAtUnixNano, end: endObservedAtUnixNano)
        guard measuredDurationMs.isFinite, measuredDurationMs >= 0 else { throw ClientDetailFailure.invalidGraph }
    }
    public init?(inspectorValue value: ClientInspectorValue) {
        guard let span = value["spanId"].text, !span.isEmpty, let start = value["startObservedAtUnixNano"].text,
              let end = value["endObservedAtUnixNano"].text else { return nil }
        traceId = value["traceId"].text ?? ""; spanId = span; parentSpanId = value["parentSpanId"].text
        operation = value["operation"].text ?? ""; intervalClass = value["intervalClass"].text ?? ""
        startObservedAtUnixNano = start; endObservedAtUnixNano = end; status = value["status"].text ?? ""
        measuredDurationMs = ConversationInspectorPolicy.spanDurationMilliseconds(start: start, end: end)
        guard measuredDurationMs.isFinite, measuredDurationMs >= 0 else { return nil }
    }
}
public struct ClientTurnTrace: Decodable, Equatable, Sendable {
    public let spans: [ClientTurnTraceSpan]
    public let nextCursor: String?
    public let windowClipped: Bool
    private enum CodingKeys: String, CodingKey { case spans = "items", nextCursor }
    public init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        let spans = try value.decode([ClientTurnTraceSpan].self, forKey: .spans)
        let cursor = try value.decodeIfPresent(String.self, forKey: .nextCursor)
        try Self.validate(spans, cursor: cursor)
        self.spans = spans; nextCursor = cursor; windowClipped = false
    }
    public init(inspectorValue value: ClientInspectorValue) throws {
        guard case .array(let rows) = value["items"], rows.count <= 2000 else { throw ClientDetailFailure.limit }
        let spans = rows.compactMap { ClientTurnTraceSpan(inspectorValue: $0) }
        guard spans.count == rows.count else { throw ClientDetailFailure.invalidGraph }
        let cursor = value["nextCursor"].text
        try Self.validate(spans, cursor: cursor)
        self.spans = spans; nextCursor = cursor; windowClipped = false
    }
    private init(spans: [ClientTurnTraceSpan], nextCursor: String?, clipped: Bool) {
        self.spans = spans; self.nextCursor = nextCursor; windowClipped = clipped
    }
    private static func validate(_ spans: [ClientTurnTraceSpan], cursor: String?) throws {
        guard spans.count <= 2000, cursor.map({ !$0.isEmpty && $0.utf8.count <= 512 }) ?? true,
              spans.allSatisfy({ !$0.id.isEmpty && $0.id.utf8.count <= 512 && $0.operation.utf8.count <= 4096 }) else { throw ClientDetailFailure.limit }
        let ids = spans.map(\.id).sorted()
        guard !zip(ids, ids.dropFirst()).contains(where: { pair in pair.0 == pair.1 }) else { throw ClientDetailFailure.invalidGraph }
    }
    public func appending(_ page: Self) throws -> Self {
        var rows = spans
        for row in page.spans where !rows.contains(where: { $0.id == row.id }) { rows.append(row) }
        if rows.count >= 2000 { return .init(spans: Array(rows.prefix(2000)), nextCursor: nil, clipped: page.nextCursor != nil || rows.count > 2000) }
        return .init(spans: rows, nextCursor: page.nextCursor, clipped: false)
    }
}

@MainActor @Observable public final class ClientDetailTurnState {
    public struct PresentationSnapshot: Equatable, Sendable {
        public let summary: ClientTurnSummary?
        public let trace: ClientTurnTrace?
        public let slowestSpans: [ClientTurnTraceSpan]
        public let loading: Bool
        public let loadingTrace: Bool
        public let error: String?
    }
    public private(set) var summary: ClientTurnSummary?
    public private(set) var trace: ClientTurnTrace?
    public private(set) var slowestSpans: [ClientTurnTraceSpan] = []
    public var loading = false
    public var loadingTrace = false
    public var error: String?
    public private(set) var lifetime = UUID()
    @ObservationIgnored private var summaryTask: Task<Void, Never>?
    @ObservationIgnored private var summaryRequest: String?
    @ObservationIgnored private var traceTask: Task<Void, Never>?
    @ObservationIgnored var contentChanged: (() -> Void)?
    @ObservationIgnored private var traceBytes = 0
    @ObservationIgnored private var traceCursors: [String] = []
    public init() {}
    public func makePresentationSnapshot() -> PresentationSnapshot {
        .init(summary: summary, trace: trace, slowestSpans: slowestSpans,
              loading: loading, loadingTrace: loadingTrace, error: error)
    }
    public func applyPresentationSnapshot(_ value: PresentationSnapshot) {
        if summary != value.summary { summary = value.summary }
        if trace != value.trace { trace = value.trace }
        if slowestSpans != value.slowestSpans { slowestSpans = value.slowestSpans }
        if loading != value.loading { loading = value.loading }
        if loadingTrace != value.loadingTrace { loadingTrace = value.loadingTrace }
        if error != value.error { error = value.error }
    }
    public func apply(_ summary: ClientTurnSummary, expectedSessionIDs: [String], executionID: String) throws {
        guard summary.isValid, expectedSessionIDs.contains(summary.sessionId), summary.turnExecutionId == executionID else { throw ClientDetailFailure.invalidGraph }
        if self.summary != summary { trace = nil; slowestSpans = []; traceBytes = 0; traceCursors = [] }
        if self.summary != summary { self.summary = summary }
        error = nil
    }
    public func applyTrace(_ trace: ClientTurnTrace, executionID: String) throws {
        guard summary?.turnExecutionId == executionID, trace.spans.count <= 2000 else { throw ClientDetailFailure.limit }
        self.trace = trace
        slowestSpans = Array(trace.spans.filter { $0.operation != "persistence" && $0.durationMs > 0.01 }
            .sorted { $0.durationMs > $1.durationMs }.prefix(trace.spans.count > 200 ? 30 : 10))
        traceBytes = trace.spans.reduce(0) { $0 + 512 + ($1.operation.utf8.count + $1.traceId.utf8.count + $1.spanId.utf8.count
            + ($1.parentSpanId?.utf8.count ?? 0) + $1.intervalClass.utf8.count + $1.status.utf8.count) * 2 }
    }
    public func loadSummary(executionID: String, expectedSessionIDs: [String], force: Bool = false, using read: @escaping @MainActor () async throws -> ClientTurnSummary) async {
        if !force, summary?.turnExecutionId == executionID { return }
        if summaryRequest == executionID, let summaryTask { await summaryTask.value; return }
        summaryTask?.cancel()
        traceTask?.cancel(); traceTask = nil; loadingTrace = false
        let token = UUID(); lifetime = token; summaryRequest = executionID; loading = true; error = nil
        let task = Task { @MainActor in
            defer { if lifetime == token { loading = false; summaryTask = nil; summaryRequest = nil } }
            do {
                let value = try await read()
                guard !Task.isCancelled, lifetime == token else { return }
                try apply(value, expectedSessionIDs: expectedSessionIDs, executionID: executionID)
                contentChanged?()
            } catch { if !Task.isCancelled, lifetime == token { self.error = "Turn 摘要暂不可用，请刷新重试" } }
        }
        summaryTask = task; await task.value
    }
    public func loadTrace(more: Bool = false, using read: @escaping @MainActor (String, String?) async throws -> ClientTurnTrace) async {
        if trace != nil && !more { return }
        if let traceTask { await traceTask.value; return }
        guard let executionID = summary?.turnExecutionId else { return }
        let cursor = more ? trace?.nextCursor : nil
        if more {
            guard let cursor else { return }
            guard !traceCursors.contains(cursor) else { error = "Trace 游标未推进，请刷新摘要后重试"; return }
        }
        let token = lifetime; loadingTrace = true; error = nil
        let task = Task { @MainActor in
            defer { if lifetime == token { loadingTrace = false; traceTask = nil } }
            do {
                let page = try await read(executionID, cursor)
                guard !Task.isCancelled, lifetime == token else { return }
                guard cursor == nil || trace?.nextCursor == cursor, page.nextCursor == nil || page.nextCursor != cursor else { throw ClientDetailFailure.invalidGraph }
                let next: ClientTurnTrace
                if more, let previous = trace { next = try previous.appending(page) } else { next = page }
                try applyTrace(next, executionID: executionID); contentChanged?()
                if let cursor { traceCursors.append(cursor) }
            } catch { if !Task.isCancelled, lifetime == token { self.error = "Trace 暂不可用，未重新发送任何操作" } }
        }
        traceTask = task; await task.value
    }
    public func refresh() { summaryTask?.cancel(); traceTask?.cancel(); summaryTask = nil; traceTask = nil; summaryRequest = nil; lifetime = UUID(); loading = false; loadingTrace = false }
    public func retire() {
        guard summary != nil || trace != nil || summaryTask != nil || traceTask != nil || loading || loadingTrace || error != nil else { return }
        refresh(); summary = nil; trace = nil; slowestSpans = []; traceBytes = 0; traceCursors = []; error = nil
    }
    public var estimatedRetainedBytes: Int { 16384 + traceBytes }
}
