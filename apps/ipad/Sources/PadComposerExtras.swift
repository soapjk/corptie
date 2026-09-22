import SwiftUI
import CorptieClientCore
import CorptieConversation

struct PadScheduleMessageView: View {
    @Environment(\.dismiss) private var dismiss
    let connection: PadConnection
    let workspace: PadWorkspace
    let sessionID: String
    @State private var runAt = Date().addingTimeInterval(3600)
    @State private var expiresAt = Date().addingTimeInterval(86400 * 7)
    @State private var interval = 0
    @State private var submitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("消息") { Text(workspace.drafts[sessionID] ?? "").lineLimit(8) }
                Section("触发时间") {
                    DatePicker("首次发送", selection: $runAt, in: Date()...)
                    Picker("重复", selection: $interval) {
                        Text("不重复").tag(0)
                        Text("每小时").tag(3600)
                        Text("每天").tag(86400)
                        Text("每周").tag(604800)
                    }
                    DatePicker("到期时间", selection: $expiresAt, in: runAt...)
                    Text("由 Mac 后端执行。Mac 需要在线；撤销本设备授权后不再发送。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !workspace.conversationNotice.isEmpty { Text(workspace.conversationNotice) }
            }
            .navigationTitle("定时消息").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(submitting) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") {
                        submitting = true
                        Task {
                            await workspace.command(connection, stop: false, schedule: ClientMessageSchedule(
                                runAt: runAt, expiresAt: expiresAt, intervalSeconds: interval == 0 ? nil : interval))
                            submitting = false
                            if workspace.pending != nil || (workspace.drafts[sessionID] ?? "").isEmpty { dismiss() }
                        }
                    }.disabled(submitting || connection.busy || workspace.selection != sessionID
                        || runAt <= Date() || expiresAt <= runAt)
                }
            }
            .interactiveDismissDisabled(submitting)
        }
    }
}
