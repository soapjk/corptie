import SwiftUI
import CorptieClientCore

/// One shared native control; no timer, global observation or optimistic state.
public struct ConversationTaskCoordinationControl: View {
    public let enabled: Bool
    public let updating: Bool
    public let onChange: (Bool) -> Void
    public let dispatches: [ClientTaskCoordinationDispatch]
    public init(enabled: Bool, updating: Bool = false, dispatches: [ClientTaskCoordinationDispatch] = [], onChange: @escaping (Bool) -> Void) {
        self.enabled = enabled; self.updating = updating; self.onChange = onChange
        self.dispatches = Array(dispatches.prefix(5))
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle("协调模式", isOn: Binding(get: { enabled }, set: onChange)).disabled(updating)
            Text("自动派发给子任务，当前会话继续讨论；关闭后已派发任务仍会执行并回报。")
                .font(.caption).foregroundStyle(.secondary)
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
