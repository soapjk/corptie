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
    @State private var commandNotice: String?
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
                if let commandNotice {
                    Section {
                        Text(commandNotice).font(.footnote).foregroundStyle(.red)
                    }
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
                        commandNotice = nil
                        Task {
                            var body = ClientWorkUpdate(requestId: "")
                            body.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
                            let receipt = await commands.run(connection, target: .work(work.id), kind: "work_update", label: "编辑 Work") { api, requestID in
                                let update = ClientWorkUpdate(requestId: requestID)
                                var req = update
                                req.name = body.name
                                return try await api.workCommand(workId: work.id, command: .update, body: req)
                            }
                            submitting = false
                            if receipt?.status == "completed" {
                                onFinished()
                                dismiss()
                            } else if !commands.notice.isEmpty {
                                commandNotice = commands.notice
                            }
                        }
                    }
                    .disabled(submitting || commands.isBusy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
    @State private var commandNotice: String?
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
                if let commandNotice {
                    Section {
                        Text(commandNotice).font(.footnote).foregroundStyle(.red)
                    }
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
                        commandNotice = nil
                        Task {
                            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
                            let receipt = await commands.run(connection, target: .task(task.id), kind: "task_update", label: "重命名 Task") { api, requestID in
                                var req = ClientTaskUpdate(requestId: requestID)
                                req.title = trimmed
                                return try await api.taskCommand(taskId: task.id, command: .update, body: req)
                            }
                            submitting = false
                            if receipt?.status == "completed" {
                                onFinished()
                                dismiss()
                            } else if !commands.notice.isEmpty {
                                commandNotice = commands.notice
                            }
                        }
                    }
                    .disabled(submitting || commands.isBusy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
    @State private var commandNotice: String?
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
                if let commandNotice {
                    Section {
                        Text(commandNotice).font(.footnote).foregroundStyle(.red)
                    }
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
                        commandNotice = nil
                        Task {
                            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
                            let receipt = await commands.run(connection, target: .task(task.id), kind: "task_update", label: "编辑 Task") { api, requestID in
                                var req = ClientTaskUpdate(requestId: requestID)
                                req.title = trimmed
                                return try await api.taskCommand(taskId: task.id, command: .update, body: req)
                            }
                            submitting = false
                            if receipt?.status == "completed" {
                                onFinished()
                                dismiss()
                            } else if !commands.notice.isEmpty {
                                commandNotice = commands.notice
                            }
                        }
                    }
                    .disabled(submitting || commands.isBusy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

struct PadDeleteTaskSheet: View {
    let connection: PadConnection
    let commands: PadEntityCommandState
    let task: ClientTask
    let onFinished: () -> Void

    @State private var plan: ClientTaskDeletionPlan?
    @State private var loading = true
    @State private var inspectError: String?
    @State private var showForceConfirmation = false
    @State private var acknowledgeDataLoss = false
    @State private var deleteWorktree = true
    @State private var artifactDisposition = "delete"
    @State private var submitting = false
    @State private var deleteNotice: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                if loading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("正在检查关联资源与风险…").font(.footnote).foregroundStyle(.secondary)
                    }
                } else if let error = inspectError {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.callout).foregroundStyle(.red)
                        Button("重试检查") {
                            Task { await loadPlan() }
                        }
                    }
                } else if let plan {
                    deletionForm(plan)
                }
            }
            .navigationTitle(showForceConfirmation ? "二次确认强制删除" : "删除 Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .disabled(submitting)
                }
            }
            .task { await loadPlan() }
            .onChange(of: deleteWorktree) { _, enabled in
                if !enabled {
                    showForceConfirmation = false
                    acknowledgeDataLoss = false
                }
            }
        }
        .interactiveDismissDisabled(submitting)
    }

    @ViewBuilder
    private func deletionForm(_ plan: ClientTaskDeletionPlan) -> some View {
        let blockers = effectiveBlockers(for: plan)
        let risks = effectiveRisks(for: plan)

        Section("Task") {
            Text(task.title).font(.headline)
            Text("删除会永久清除所有关联会话及完整会话历史，无法撤销。Worktree 和 Artifact 仅按下方选项处理。")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.red)
            if plan.associatedSessionCount > 0 {
                LabeledContent("关联会话数", value: "\(plan.associatedSessionCount)")
            }
            if !plan.artifacts.isEmpty {
                LabeledContent("关联合成物", value: "\(plan.artifacts.count) 个")
            }
        }

        if let worktree = plan.worktree {
            Section("Worktree 分支") {
                if let branch = worktree.branchName {
                    LabeledContent("分支名称", value: branch)
                }
                LabeledContent("未合并提交", value: "\(worktree.aheadOfMain) 个")
                LabeledContent("工作区未提交修改", value: worktree.dirty ? "有待保存修改" : "干净")
                Toggle("删除工作区与分支", isOn: $deleteWorktree)
            }
        }

        if !plan.artifacts.isEmpty {
            Section("Artifact 处理") {
                Picker("处理方式", selection: $artifactDisposition) {
                    Text("删除").tag("delete")
                    Text("移入 Work 层级").tag("work")
                    Text("留在原地").tag("retain")
                }
                ForEach(plan.artifacts.prefix(5)) { artifact in
                    Text(artifact.title).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }

        if !blockers.isEmpty {
            Section("阻止删除的原因") {
                ForEach(blockers, id: \.code) { blocker in
                    riskLabel(blocker, color: .red, symbol: "xmark.octagon.fill")
                }
            }
        }

        if !risks.isEmpty {
            Section("可能丢失的内容") {
                ForEach(risks, id: \.code) { risk in
                    riskLabel(risk, color: .orange, symbol: "exclamationmark.triangle.fill")
                }
            }
        }

        if requiresForce(for: plan), !canForceDelete(plan) {
            Section {
                Label("无法确认 Worktree 的完整分支名，因此不能强制删除。请保留 Worktree，或先在 Mac 上修复分支状态。",
                      systemImage: "xmark.octagon.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }

        if showForceConfirmation {
            Section("永久删除确认") {
                Text("强制删除将永久丢弃上述未提交修改、未跟踪文件和未合并提交，且无法恢复。")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.red)
                Toggle("我理解这些内容可能永久丢失", isOn: $acknowledgeDataLoss)
            }
        }

        if let notice = deleteNotice {
            Section {
                Text(notice).font(.footnote).foregroundStyle(.red)
                Button("重新检查删除条件") {
                    showForceConfirmation = false
                    acknowledgeDataLoss = false
                    Task { await loadPlan() }
                }
                .disabled(submitting || commands.isBusy)
            }
        }

        Section {
            if requiresForce(for: plan), !showForceConfirmation {
                Button("进入强制删除确认", role: .destructive) {
                    showForceConfirmation = true
                    acknowledgeDataLoss = false
                }
                .disabled(submitting || commands.isBusy || !blockers.isEmpty || !canForceDelete(plan))
            } else {
                Button(role: .destructive) {
                    executeDeletion(plan: plan, force: requiresForce(for: plan))
                } label: {
                    HStack {
                        Spacer()
                        if submitting {
                            ProgressView().controlSize(.small).padding(.trailing, 4)
                        }
                        Text(showForceConfirmation ? "确认强制删除" : "删除 Task")
                            .fontWeight(.semibold)
                        Spacer()
                    }
                }
                .disabled(
                    submitting
                        || commands.isBusy
                        || !blockers.isEmpty
                        || (requiresForce(for: plan) && (!canForceDelete(plan) || !acknowledgeDataLoss))
                )
            }
        }
    }

    private func effectiveBlockers(for plan: ClientTaskDeletionPlan) -> [ClientTaskDeletionPlan.Risk] {
        deleteWorktree ? plan.blockers : plan.blockers.filter { $0.code == "START_IN_PROGRESS" }
    }

    private func effectiveRisks(for plan: ClientTaskDeletionPlan) -> [ClientTaskDeletionPlan.Risk] {
        deleteWorktree ? plan.risks : []
    }

    private func requiresForce(for plan: ClientTaskDeletionPlan) -> Bool {
        !effectiveRisks(for: plan).isEmpty
    }

    private func canForceDelete(_ plan: ClientTaskDeletionPlan) -> Bool {
        guard requiresForce(for: plan) else { return true }
        return plan.worktree?.branchName?.isEmpty == false
    }

    private func riskLabel(_ risk: ClientTaskDeletionPlan.Risk, color: Color, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(risk.message.isEmpty ? risk.code : risk.message, systemImage: symbol)
                .font(.footnote)
                .foregroundStyle(color)
            ForEach((risk.files ?? []).prefix(8), id: \.self) { file in
                Text(file)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @MainActor
    private func loadPlan() async {
        loading = true
        inspectError = nil
        deleteNotice = nil
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let response = try await api.taskDeletionPlan(taskId: task.id)
            guard !Task.isCancelled else { return }
            plan = response
            loading = false
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            inspectError = PadConnection.explain(error)
            loading = false
        }
    }

    private func executeDeletion(plan: ClientTaskDeletionPlan, force: Bool) {
        submitting = true
        deleteNotice = nil
        Task {
            let receipt = await commands.run(connection, target: .task(task.id), kind: "task_delete", label: "删除 Task") { api, requestID in
                var request = ClientTaskDeletion(requestId: requestID)
                request.mode = force ? "force" : "safe"
                request.deleteWorktree = deleteWorktree
                request.artifactDisposition = artifactDisposition
                if force {
                    request.acknowledgeDataLoss = true
                    request.confirmedBranchName = plan.worktree?.branchName
                }
                return try await api.taskCommand(taskId: task.id, command: .delete, body: request)
            }
            submitting = false
            if receipt?.status == "completed" {
                onFinished()
                dismiss()
            } else if !commands.notice.isEmpty {
                deleteNotice = commands.notice
            }
        }
    }
}

struct PadDeleteWorkSheet: View {
    let connection: PadConnection
    let commands: PadEntityCommandState
    let work: ClientWork
    let onFinished: () -> Void

    @State private var submitting = false
    @State private var deleteNotice: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("确定要删除 Work「\(work.name)」吗？")
                        .font(.headline)
                    Text("删除后会永久清除该 Work、头像，以及其中的所有 Task 和关联数据，无法撤销。如果已有 Task 正在删除，请稍后重试。")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                if let notice = deleteNotice {
                    Section {
                        Text(notice).font(.footnote).foregroundStyle(.red)
                    }
                }

                Section {
                    Button(role: .destructive) {
                        submitting = true
                        deleteNotice = nil
                        Task {
                            let receipt = await commands.run(connection, target: .work(work.id), kind: "work_delete", label: "删除 Work") { api, requestID in
                                try await api.workCommand(workId: work.id, command: .delete, body: ClientEntityRequest(requestId: requestID))
                            }
                            submitting = false
                            if receipt?.status == "completed" {
                                onFinished()
                                dismiss()
                            } else if !commands.notice.isEmpty {
                                deleteNotice = commands.notice
                            }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if submitting {
                                ProgressView().controlSize(.small)
                                    .padding(.trailing, 4)
                            }
                            Text("删除 Work")
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .disabled(submitting || commands.isBusy)
                }
            }
            .navigationTitle("删除 Work")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .disabled(submitting)
                }
            }
        }
        .interactiveDismissDisabled(submitting)
    }
}
