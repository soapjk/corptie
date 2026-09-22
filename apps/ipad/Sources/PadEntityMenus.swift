import SwiftUI
import CorptieClientCore
import CorptieConversation

/// Dialogs and sheets for touch-based Work / Task management actions.
enum PadEntityRoute: Identifiable {
    case editWork(ClientWork)
    case renameTask(ClientTask)
    case editTask(ClientTask)
    case deleteTask(ClientTask)
    case deleteWork(ClientWork)

    var id: String {
        switch self {
        case .editWork(let w): return "edit-work-\(w.id)"
        case .renameTask(let t): return "rename-task-\(t.id)"
        case .editTask(let t): return "edit-task-\(t.id)"
        case .deleteTask(let t): return "delete-task-\(t.id)"
        case .deleteWork(let w): return "delete-work-\(w.id)"
        }
    }
}

struct PadEditWorkSheet: View {
    let connection: PadConnection
    let commands: PadEntityCommandState
    let work: ClientWork
    let onFinished: () -> Void
    @State private var name: String
    @State private var submitting = false
    @Environment(\.dismiss) private var dismiss

    init(connection: PadConnection, commands: PadEntityCommandState, work: ClientWork, onFinished: @escaping () -> Void) {
        self.connection = connection
        self.commands = commands
        self.work = work
        self.onFinished = onFinished
        _name = State(initialValue: work.name)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Work 名称") {
                    TextField("名称", text: $name)
                }
            }
            .navigationTitle("编辑 Work")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        submitting = true
                        Task {
                            var body = ClientWorkUpdate(requestId: "")
                            body.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
                            _ = await commands.run(connection, target: .work(work.id), kind: "work_update", label: "编辑 Work") { api, requestID in
                                let update = ClientWorkUpdate(requestId: requestID)
                                var req = update
                                req.name = body.name
                                return try await api.workCommand(workId: work.id, command: .update, body: req)
                            }
                            submitting = false
                            onFinished()
                            dismiss()
                        }
                    }
                    .disabled(submitting || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

struct PadRenameTaskSheet: View {
    let connection: PadConnection
    let commands: PadEntityCommandState
    let task: ClientTask
    let onFinished: () -> Void
    @State private var title: String
    @State private var submitting = false
    @Environment(\.dismiss) private var dismiss

    init(connection: PadConnection, commands: PadEntityCommandState, task: ClientTask, onFinished: @escaping () -> Void) {
        self.connection = connection
        self.commands = commands
        self.task = task
        self.onFinished = onFinished
        _title = State(initialValue: task.title)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Task 标题") {
                    TextField("标题", text: $title)
                }
            }
            .navigationTitle("重命名 Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        submitting = true
                        Task {
                            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
                            _ = await commands.run(connection, target: .task(task.id), kind: "task_update", label: "重命名 Task") { api, requestID in
                                var req = ClientTaskUpdate(requestId: requestID)
                                req.title = trimmed
                                return try await api.taskCommand(taskId: task.id, command: .update, body: req)
                            }
                            submitting = false
                            onFinished()
                            dismiss()
                        }
                    }
                    .disabled(submitting || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

struct PadEditTaskSheet: View {
    let connection: PadConnection
    let commands: PadEntityCommandState
    let task: ClientTask
    let onFinished: () -> Void
    @State private var title: String
    @State private var submitting = false
    @Environment(\.dismiss) private var dismiss

    init(connection: PadConnection, commands: PadEntityCommandState, task: ClientTask, onFinished: @escaping () -> Void) {
        self.connection = connection
        self.commands = commands
        self.task = task
        self.onFinished = onFinished
        _title = State(initialValue: task.title)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Task 信息") {
                    TextField("标题", text: $title)
                }
            }
            .navigationTitle("编辑 Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        submitting = true
                        Task {
                            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
                            _ = await commands.run(connection, target: .task(task.id), kind: "task_update", label: "编辑 Task") { api, requestID in
                                var req = ClientTaskUpdate(requestId: requestID)
                                req.title = trimmed
                                return try await api.taskCommand(taskId: task.id, command: .update, body: req)
                            }
                            submitting = false
                            onFinished()
                            dismiss()
                        }
                    }
                    .disabled(submitting || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
