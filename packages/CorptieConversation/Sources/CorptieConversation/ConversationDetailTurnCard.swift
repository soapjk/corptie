import SwiftUI
import CorptieClientCore

public struct ConversationDetailTurnCard: View {
    private let commandState: ClientDetailTurnState
    private let presentationState: ClientDetailTurnState?
    private let activity: ConversationDetailPresentationActivity?
    private var state: ClientDetailTurnState { presentationState ?? commandState }
    private var active: Bool { activity?.isActive ?? true }
    let executionID: String
    let expectedSessionIDs: [String]
    let readSummary: @MainActor () async throws -> ClientTurnSummary
    let readTrace: @MainActor (String, String?) async throws -> ClientTurnTrace
    let liveSnapshot: ClientTurnSummary?
    @Environment(\.detailPresentation) private var presentation
    @Environment(\.detailSectionPrefix) private var prefix
    @State private var localExpanded = false
    @State private var localTraceExpanded = false
    public init(state: ClientDetailTurnState, executionID: String, expectedSessionIDs: [String],
                readSummary: @escaping @MainActor () async throws -> ClientTurnSummary,
                readTrace: @escaping @MainActor (String, String?) async throws -> ClientTurnTrace,
                liveSnapshot: ClientTurnSummary? = nil,
                presentationState: ClientDetailTurnState? = nil,
                activity: ConversationDetailPresentationActivity? = nil) {
        self.commandState = state; self.presentationState = presentationState; self.activity = activity; self.executionID = executionID; self.expectedSessionIDs = expectedSessionIDs
        self.readSummary = readSummary; self.readTrace = readTrace
        self.liveSnapshot = liveSnapshot
    }
    private var expanded: Binding<Bool> {
        Binding(get: { presentation?.section("\(prefix):summary").expanded ?? localExpanded },
            set: { if let value = presentation?.section("\(prefix):summary") { value.expanded = $0 } else { localExpanded = $0 } })
    }
    private var traceExpanded: Binding<Bool> {
        Binding(get: { presentation?.section("\(prefix):trace").expanded ?? localTraceExpanded },
            set: { if let value = presentation?.section("\(prefix):trace") { value.expanded = $0 } else { localTraceExpanded = $0 } })
    }
    public var body: some View {
        ConversationDetailModuleCard(title: "Turn 分析", systemImage: "point.3.connected.trianglepath.dotted", headerActions: {
            Button { Task { await load(force: true) } } label: { ConversationDetailHeaderIcon(systemName: "arrow.clockwise") }
                .buttonStyle(.plain).disabled(state.loading).help("刷新 Turn 摘要").accessibilityLabel("刷新 Turn 摘要")
        }) {
            ConversationDetailDisclosure(isExpanded: expanded, header: {
                HStack {
                    Text("时间分析").foregroundStyle(Color.accentColor)
                    Spacer(minLength: 4)
                    if state.loading { ProgressView().controlSize(.small) }
                    else { Text(duration(state.summary?.wall.wallClockMs ?? state.summary?.wall.observedWatermarkMs)).monospacedDigit().foregroundStyle(.secondary) }
                }.font(.caption)
            }, content: { summaryContent })
            if let error = state.error { Text(error).font(.caption).foregroundStyle(.secondary) }
        }
        .task(id: active ? executionID : nil) { guard active else { return }; await load() }
        .task(id: liveSnapshot) {
            if active, let liveSnapshot, liveSnapshot.turnExecutionId == executionID {
                try? commandState.apply(liveSnapshot, expectedSessionIDs: expectedSessionIDs, executionID: executionID)
            }
        }
        .task(id: "\(active):\(traceExpanded.wrappedValue):\(state.summary?.turnExecutionId ?? "")") {
            if active && traceExpanded.wrappedValue { await loadTrace() }
        }
    }
    @ViewBuilder private var summaryContent: some View {
        if let summary = state.summary {
            HStack(spacing: 8) {
                metric("总耗时", summary.wall.wallClockMs ?? summary.wall.observedWatermarkMs)
                metric("已归因", summary.displayedAttributedMs)
                metric("未归因", summary.displayedUnattributedMs)
            }
            Text(summary.isBoundaryOnly ? "仅有 Provider 边界观测；内部耗时未细分" : summary.observabilityLevel == "complete" ? "观测完整" : "观测不完整")
                .font(.caption).foregroundStyle(summary.isBoundaryOnly ? Color.orange : Color.secondary)
            if let breakdown = summary.timeBreakdown { ConversationTurnTimeBreakdownView(breakdown) }
            else { Text("当前摘要未提供分类统计").font(.caption).foregroundStyle(.secondary) }
            ConversationDetailDisclosure(isExpanded: traceExpanded, header: {
                Text("详细 Trace（按需加载）").font(.caption).foregroundStyle(Color.accentColor)
            }, content: { traceContent })
        } else if state.loading { Text("正在读取 Turn 摘要…").font(.caption).foregroundStyle(.secondary) }
    }
    @ViewBuilder private var traceContent: some View {
        if state.loadingTrace && state.trace == nil { ProgressView().controlSize(.small) }
        else if let trace = state.trace {
            if trace.spans.isEmpty { Text("Trace 没有可展示的操作").font(.caption).foregroundStyle(.secondary) }
            else {
                let slowest = state.slowestSpans
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(slowest) { span in
                            HStack(alignment: .top) {
                                Text(span.operation).lineLimit(2)
                                Spacer(minLength: 6)
                                Text(duration(span.durationMs)).monospacedDigit().foregroundStyle(.secondary)
                            }.font(.caption)
                        }
                        if trace.spans.count <= 200 {
                            Divider()
                            Text(trace.nextCursor == nil && !trace.windowClipped ? "完整时间线" : "已读取时间线").font(.caption).foregroundStyle(.secondary)
                            ForEach(trace.spans) { span in
                                HStack(alignment: .top) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(span.operation).lineLimit(2)
                                        Text(span.category).font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 6)
                                    Text(duration(span.durationMs)).monospacedDigit().foregroundStyle(.secondary)
                                }.font(.caption)
                            }
                        }
                        if let cursor = trace.nextCursor {
                            if state.error != nil {
                                Button("重试读取更多") { Task { await loadTrace(more: true) } }.font(.caption)
                            } else {
                                ProgressView().controlSize(.small).task(id: cursor) { await loadTrace(more: true) }
                            }
                        }
                    }
                }.frame(maxHeight: 240)
                Text("显示最慢 \(slowest.count) 项；本次读取 \(trace.spans.count) 个操作").font(.caption2).foregroundStyle(.secondary)
                if trace.windowClipped { Text("已达本次诊断窗口上限，未继续读取").font(.caption2).foregroundStyle(.secondary) }
            }
        } else {
            Button("重试读取 Trace") { Task { await loadTrace() } }.font(.caption)
        }
    }
    private func load(force: Bool = false) async {
        let generation = activity?.generation ?? 0
        guard activity?.allows(generation: generation) ?? true else { return }
        await commandState.loadSummary(executionID: executionID, expectedSessionIDs: expectedSessionIDs, force: force) {
            guard activity?.allows(generation: generation) ?? true else { throw CancellationError() }
            let value = try await readSummary()
            guard activity?.allows(generation: generation) ?? true else { throw CancellationError() }
            return value
        }
    }
    private func loadTrace(more: Bool = false) async {
        let generation = activity?.generation ?? 0
        guard activity?.allows(generation: generation) ?? true else { return }
        await commandState.loadTrace(more: more) { id, cursor in
            guard activity?.allows(generation: generation) ?? true else { throw CancellationError() }
            let value = try await readTrace(id, cursor)
            guard activity?.allows(generation: generation) ?? true else { throw CancellationError() }
            return value
        }
    }
    private func metric(_ label: String, _ value: Double?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).foregroundStyle(.secondary)
            Text(duration(value)).monospacedDigit()
        }.font(.caption).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func duration(_ milliseconds: Double?) -> String {
        guard let milliseconds, milliseconds.isFinite, milliseconds >= 0 else { return "—" }
        return String(format: "%.2f s", milliseconds / 1000)
    }
}
