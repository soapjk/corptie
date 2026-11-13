import SwiftUI
import CorptieClientCore

/// One shared native control; no timer, global observation or optimistic state.
public struct ConversationTaskCoordinationControl: View {
    public let enabled: Bool
    public let updating: Bool
    public let onChange: (Bool) -> Void
    public let dispatches: [ClientTaskCoordinationDispatch]
    public let execution: ClientCoordinationExecution?
    @State private var reportsExpanded = false
    private var explanation: String {
        if let reason = execution?.reason, !reason.isEmpty { return reason }
        return "开发由子任务执行，当前会话负责讨论与派发；关闭后已派发任务仍会继续。"
    }
    public init(enabled: Bool, updating: Bool = false, dispatches: [ClientTaskCoordinationDispatch] = [], execution: ClientCoordinationExecution? = nil, onChange: @escaping (Bool) -> Void) {
        self.enabled = enabled; self.updating = updating; self.onChange = onChange
        self.execution = execution
        self.dispatches = Array(dispatches.prefix(5))
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle("协调模式", isOn: Binding(get: { enabled }, set: onChange))
                .disabled(updating || (!enabled && execution?.status == "unsupported"))
            if enabled {
                Text(execution?.statusLabel ?? "执行限制尚未验证")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(explanation)
                .font(.caption).foregroundStyle(.secondary)
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
    }
}
