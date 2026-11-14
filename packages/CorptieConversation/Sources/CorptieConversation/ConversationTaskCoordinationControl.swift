import SwiftUI
import CorptieClientCore

/// Local presentation only. Requests stay in server order with stable IDs.
struct ConversationRequestWindow {
    static let pageSize = 10
    static let maximumCount = 100
    private(set) var limit = ConversationRequestWindow.pageSize
    mutating func showMore() { limit = min(Self.maximumCount, limit + Self.pageSize) }
    mutating func collapse() { limit = Self.pageSize }
}

/// One shared native control; no timer, global observation or optimistic state.
public struct ConversationTaskCoordinationControl: View {
    public let enabled: Bool
    public let updating: Bool
    public let canChangeMode: Bool
    public let onChange: (Bool) -> Void
    public let dispatches: [ClientTaskCoordinationDispatch]
    public let execution: ClientCoordinationExecution?
    public var onRequestControl: ((String, String) -> Void)?
    @State private var reportsExpanded = false
    @State private var requestWindow = ConversationRequestWindow()
    private var explanation: String {
        if let reason = execution?.reason, !reason.isEmpty { return reason }
        return "开发由子任务执行，当前会话负责讨论与派发；关闭后已派发任务仍会继续。"
    }
    public init(enabled: Bool, updating: Bool = false, canChangeMode: Bool = true, dispatches: [ClientTaskCoordinationDispatch] = [], execution: ClientCoordinationExecution? = nil, onRequestControl: ((String, String) -> Void)? = nil, onChange: @escaping (Bool) -> Void) {
        self.enabled = enabled; self.updating = updating; self.onChange = onChange
        self.canChangeMode = canChangeMode
        self.execution = execution
        self.onRequestControl = onRequestControl
        self.dispatches = Array(dispatches.prefix(5))
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TaskCoordinationToggle(enabled: enabled, updating: updating,
                supported: execution?.status != "unsupported", onChange: onChange)
                .disabled(!canChangeMode)
            if enabled {
                Text(execution?.statusLabel ?? "执行限制尚未验证")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(explanation)
                .font(.caption).foregroundStyle(.secondary)
            if let requests = execution?.requests, !requests.isEmpty {
                ForEach(requests.prefix(requestWindow.limit)) { request in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(request.question ?? "请求").lineLimit(2)
                            if let error = request.errorMessage {
                                Text(error).foregroundStyle(.secondary).lineLimit(3)
                            }
                        }
                        Spacer(minLength: 0)
                        Text(request.statusLabel).foregroundStyle(.secondary)
                        if let onRequestControl, let operation = request.controlAction {
                            Button(request.status == "failed" ? "重试" : "停止") {
                                onRequestControl(request.requestId, operation)
                            }.buttonStyle(.borderless)
                            .accessibilityLabel("\(request.status == "failed" ? "重试" : "停止")此请求")
                        }
                    }.font(.caption)
                }
                if requests.count > ConversationRequestWindow.pageSize {
                    HStack(spacing: 12) {
                        Text("已显示 \(min(requestWindow.limit, requests.count))/\(requests.count) 条")
                            .foregroundStyle(.secondary)
                        if requestWindow.limit < min(requests.count, ConversationRequestWindow.maximumCount) {
                            Button("显示更多") { requestWindow.showMore() }.buttonStyle(.borderless)
                        }
                        if requestWindow.limit > ConversationRequestWindow.pageSize {
                            Button("收起") { requestWindow.collapse() }.buttonStyle(.borderless)
                        }
                    }.font(.caption)
                }
            }
            if let shadow = execution?.shadow {
                HStack(spacing: 8) {
                    Text(shadow.statusLabel)
                    if shadow.pendingDecisions > 0 {
                        Text("待决策 \(shadow.pendingDecisions) 项")
                    }
                }.font(.caption).foregroundStyle(.secondary)
                if let timestamp = shadow.lastReportAt,
                   let date = try? Date(timestamp, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true).timeZone(separator: .omitted)) {
                    Text("最后汇总：\(date.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if !shadow.reports.isEmpty {
                    DisclosureGroup("后台汇总", isExpanded: $reportsExpanded) {
                        if reportsExpanded {
                            ForEach(shadow.reports) { report in
                                Text(report.text)
                                    .font(.caption).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 4)
                            }
                        }
                    }.font(.caption)
                }
            }
            ForEach(dispatches) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(item.statusLabel).foregroundStyle(.secondary)
                }.font(.caption)
            }
        }
        .onChange(of: execution?.requests?.isEmpty) { _, empty in
            if empty != false { requestWindow.collapse() }
        }
    }
}

/// The same capability-aware switch, without operational reports in the compact Detail card.
struct TaskCoordinationToggle: View {
    let enabled: Bool
    var updating = false
    var supported = true
    let onChange: (Bool) -> Void

    var body: some View {
        Toggle("协调模式", isOn: Binding(get: { enabled }, set: onChange))
            .disabled(updating || (!enabled && !supported))
            .accessibilityIdentifier("task.coordination.toggle")
    }
}
