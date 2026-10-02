#if os(iOS)
import SwiftUI
import CorptieClientCore
import CorptieConversation
import UniformTypeIdentifiers

struct PadInspectorResources<Primary: View, Secondary: View>: View {
    @Bindable var store: PadInspectorStore
    let connection: PadConnection
    let sessionID: String
    @Bindable var workspace: PadWorkspace
    let primary: Primary
    let secondary: Secondary
    init(store: PadInspectorStore, connection: PadConnection, sessionID: String, workspace: PadWorkspace,
         @ViewBuilder primary: () -> Primary, @ViewBuilder secondary: () -> Secondary) {
        self.store = store
        self.connection = connection
        self.sessionID = sessionID
        self.workspace = workspace
        self.primary = primary()
        self.secondary = secondary()
    }
    @Environment(\.openURL) private var openURL
    @State private var editor: PadInspectorEdit?
    @State private var document: PadInspectorDocument?
    @State private var confirmation: PadInspectorEdit?
    @State private var allReferences = false
    @State private var allArtifacts = false
    @State private var moreArtifacts: [ClientInspectorValue] = []
    @State private var nextArtifactOffset: ClientInspectorValue?
    @State private var loadingMore = false
    @State private var importing = false
    @State private var importAsArtifact = false
    @State private var moreMemories: [ClientInspectorValue] = []
    @State private var nextMemoryCursor: ClientInspectorValue?
    @State private var worktree: ClientInspectorValue = .null
    @State private var inspectingWorktree = false
    @State private var acknowledgingUnknown = false
    private var locked: Bool { store.busy || store.pending != nil }
    private func section(_ key: String) -> ClientInspectorValue { store.sections[key] ?? .null }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            connectionStatus
            primary
            taskControls
            secondary
            if store.snapshot?.taskDefinition?["lifecycleState"].text == "done" { taskWorktree }
            if store.snapshot?.workId != nil { artifacts; memories }
            references
            if !section("schedules").items.isEmpty { schedules }
            if !section("recalls").items.isEmpty { recalls.modifier(ConversationDetailModuleSurface()) }
            if section("turn")["identity"]["turnExecutionId"] != .null {
                turnAnalysis.modifier(ConversationDetailModuleSurface())
            }
            environment
        }
        .sheet(item: $editor) { edit in
            PadInspectorEditor(edit: edit) { values in
                Task { await store.command(edit.action, fields: values, sessionID: sessionID, connection: connection) }
            }
        }
        .sheet(item: $document) { item in
            PadInspectorDocumentView(document: item, connection: connection, sessionID: sessionID, store: store)
        }
        .confirmationDialog(confirmation?.title ?? "确认操作", isPresented: Binding(
            get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
            if let value = confirmation {
                Button(value.title, role: value.destructive ? .destructive : nil) {
                    confirmation = nil
                    Task { await store.command(value.action, fields: value.fields, sessionID: sessionID, connection: connection) }
                }
            }
            Button("取消", role: .cancel) { confirmation = nil }
        }
        .onChange(of: section("artifacts")) { _, _ in moreArtifacts = []; nextArtifactOffset = nil }
        .onChange(of: section("memories")) { _, _ in moreMemories = []; nextMemoryCursor = nil }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.data]) { result in
            switch result {
            case .success(let url): Task { await importDocument(url) }
            case .failure(let error): store.error = error.localizedDescription
            }
        }
        .alert("已人工核对实际结果？", isPresented: $acknowledgingUnknown) {
            Button("已核对，解除本地锁", role: .destructive) { store.acknowledgeUnknownOutcome() }
            Button("取消", role: .cancel) { }
        } message: {
            Text("原操作可能已经执行。这只解除本地操作锁，不撤销、不重发，也不将未知结果标记为成功。请先在实际数据中核对结果。")
        }
    }

    @ViewBuilder private var connectionStatus: some View {
        if store.snapshot == nil && store.error == nil { ProgressView("正在连接详情推送…") }
        if !store.connected && store.snapshot != nil && store.error != nil {
            Label("详情连接中断，保留上次数据", systemImage: "wifi.slash").font(.footnote).foregroundStyle(.orange)
        }
        if let error = store.error { Text(error).font(.footnote).foregroundStyle(.red).textSelection(.enabled) }
        if store.pending != nil {
            Button("核对原操作结果（不重发）") { Task { await store.reconcile(connection: connection) } }.disabled(store.busy)
            Text(store.pending?.requestID ?? "").font(.caption2.monospaced()).textSelection(.enabled)
            Button("已人工核对，处理未知结果…") { acknowledgingUnknown = true }.disabled(store.busy)
        }
        ForEach(store.snapshot?.errors.keys.sorted() ?? [], id: \.self) { key in
            Text("\(key)：\(store.snapshot?.errors[key] ?? "")（保留旧数据）").font(.caption).foregroundStyle(.orange)
        }
    }

    private var references: some View {
        ConversationDetailModuleCard(title: "引用内容", systemImage: "link") {
            Menu("添加引用", systemImage: "plus") {
                Button("从 iPad 导入文件…") { importAsArtifact = false; importing = true }
                ForEach([("localFile", "Mac 本地文件"), ("webURL", "网页链接"), ("work", "Work"),
                         ("task", "Task"), ("agent", "Agent"), ("session", "其他会话")], id: \.0) { type, title in
                    Button(title) { editor = referenceEditor(type: type, title: title) }
                }
            }.disabled(locked)
            let items = section("references").items
            ForEach(allReferences ? items : Array(items.prefix(2)), id: \.inspectorID) { reference in
                referenceRow(reference)
            }
            if items.count > 2 { Button(allReferences ? "收起" : "展开全部（\(items.count)）") { allReferences.toggle() } }
            if items.isEmpty && store.snapshot?.errors["references"] == nil { Text("暂无引用").font(.footnote).foregroundStyle(.secondary) }
        }
    }
    private func referenceRow(_ reference: ClientInspectorValue) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(reference["displayName"].text ?? "引用").font(.callout)
                Text(reference["status"].text ?? "").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Toggle("启用引用", isOn: Binding(get: { reference["enabled"].flag }, set: { enabled in
                Task { await store.command("reference.update", fields: ["id": reference["referenceId"], "enabled": .bool(enabled)],
                    sessionID: sessionID, connection: connection) }
            })).labelsHidden().disabled(locked)
            Menu {
                if reference["targetType"].text == "webURL" {
                    Button("刷新快照") { perform("reference.refresh", id: reference["referenceId"]) }
                    if let value = reference["locator"].text, let url = URL(string: value), ["http", "https"].contains(url.scheme) {
                        Button("打开网页") { openURL(url) }
                    }
                }
                if reference["targetType"].text == "localFile", let path = reference["locator"].text {
                    ShareLink("分享 Mac 文件路径", item: path)
                }
                Button("移除引用", role: .destructive) {
                    confirm("移除引用？", action: "reference.delete", id: reference["referenceId"])
                }
            } label: { Image(systemName: "ellipsis").frame(width: 32, height: 44) }.disabled(locked)
                .accessibilityLabel("引用操作")
        }
    }
    private func referenceEditor(type: String, title: String) -> PadInspectorEdit {
        let local = ["localFile", "webURL"].contains(type)
        let choices: [(String, String)]
        switch type {
        case "work": choices = workspace.works.map { ($0.id, $0.name) }
        case "task": choices = workspace.tasks.map { ($0.id, $0.title) }
        case "session": choices = workspace.sessions.filter { $0.id != sessionID }.map { ($0.id, $0.title) }
        case "agent": choices = workspace.directControlSnapshot?.agents.map { ($0.id, $0.name) } ?? []
        default: choices = []
        }
        return PadInspectorEdit(title: "添加\(title)", action: "reference.create",
            fields: ["targetType": .string(type)], inputs: [
                .init(key: local ? "locator" : "targetId", label: local ? (type == "localFile" ? "Mac 上的绝对路径" : "网页 URL") : title,
                      choices: choices), .init(key: "displayName", label: "显示名称（可选）")])
    }

    private var artifacts: some View {
        ConversationDetailModuleCard(title: store.snapshot?.taskId == nil ? "Artifacts" : "Artifact 引用", systemImage: "doc.on.doc") {
            Button("创建 Artifact", systemImage: "plus") {
                editor = .init(title: "创建 Artifact", action: "artifact.create", fields: ["mimeType": .string("text/markdown")],
                    inputs: [.init(key: "title", label: "标题"), .init(key: "summary", label: "摘要"), .init(key: "content", label: "正文", multiline: true)])
                if store.snapshot?.taskId != nil {
                    editor?.fields["relation"] = .string("implementation_spec")
                    editor?.fields["required"] = .bool(false)
                    editor?.fields["versionPolicy"] = .string("fixed")
                    editor?.inputs += [
                        .init(key: "relation", label: "引用关系", choices: ["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"].map { ($0, $0) }),
                        .init(key: "required", label: "必需文档", choices: [("false", "否"), ("true", "是")]),
                        .init(key: "versionPolicy", label: "版本策略", choices: [("fixed", "固定版本"), ("latest_approved", "最新已批准版本")])]
                }
            }.disabled(locked)
            Button("导入本地文档", systemImage: "square.and.arrow.down") { importAsArtifact = true; importing = true }.disabled(locked)
            let values = section("artifacts")["items"].items + moreArtifacts
            ForEach(allArtifacts ? values : Array(values.prefix(2)), id: \.inspectorID) { artifact in
                Button {
                    document = .init(title: artifact["title"].text ?? "Artifact", resource: "artifact", value: artifact,
                        parameters: artifactReadParameters(artifact, taskID: store.snapshot?.taskId))
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(artifact["title"].text ?? "Artifact")
                        Text(artifact["summary"].text ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        Text(artifact["visibility"].text ?? "").font(.caption2).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }.buttonStyle(.plain)
            }
            if values.count > 2 || section("artifacts")["hasMore"].flag {
                Button(allArtifacts ? "收起" : "展开全部") { allArtifacts.toggle() }
            }
            if allArtifacts, let offset = (nextArtifactOffset ?? section("artifacts")["nextOffset"]).number {
                Button("加载更多 Artifact") { Task { await loadMoreArtifacts(offset) } }.disabled(loadingMore)
            }
        }
    }
    private func loadMoreArtifacts(_ offset: Double) async {
        loadingMore = true; defer { loadingMore = false }
        do {
            let api = ClientInspectorAPI(transport: try await connection.transport())
            let page = try await api.read(sessionID: sessionID, resource: "artifacts", parameters: ["offset": .number(offset)])
            guard !Task.isCancelled else { return }
            moreArtifacts += page["items"].items; nextArtifactOffset = page["nextOffset"]
        } catch { store.error = PadWorktreeFailure.describe(error, stage: "加载更多 Artifact") }
    }

    private var memories: some View {
        ConversationDetailModuleCard(title: store.snapshot?.taskId == nil ? "Work 记忆" : "Task 记忆", systemImage: "brain") {
            Button("记录记忆", systemImage: "plus") {
                editor = .init(title: "记录记忆", action: "memory.create", inputs: [
                    .init(key: "kind", label: "类型", choices: ["fact", "lesson", "preference", "procedure", "dev_experience", "feedback", "episodic", "skill"].map { ($0, $0) }),
                    .init(key: "content", label: "内容", multiline: true), .init(key: "tags", label: "标签（逗号分隔）")])
            }.disabled(locked)
            ForEach(section("memories")["items"].items + moreMemories, id: \.inspectorID) { memory in
                DisclosureGroup(memory["kind"].text ?? "记忆") {
                    ConversationDetailText(text: memory["content"].text ?? "")
                    Text("\(memory["sourceType"].text ?? "") · \(memory["trustLevel"].text ?? "")").font(.caption).foregroundStyle(.secondary)
                    Button("查看审计") { document = .init(title: "记忆审计", resource: "memory-audit", value: memory, parameters: ["id": memory["id"]]) }
                    Button("编辑记忆") {
                        editor = .init(title: "编辑记忆", action: "memory.update", fields: ["id": memory["id"], "expectedVersion": memory["version"],
                            "content": memory["content"], "tags": .string(memory["tags"].items.compactMap(\.text).joined(separator: ","))],
                            inputs: [.init(key: "content", label: "内容", multiline: true), .init(key: "tags", label: "标签（逗号分隔）")])
                    }.disabled(locked || memory["revokedAt"] != .null)
                    Button(memory["revokedAt"] == .null ? "撤销记忆" : "恢复记忆") {
                        confirmation = .init(title: memory["revokedAt"] == .null ? "撤销这条记忆？" : "恢复这条记忆？",
                            action: memory["revokedAt"] == .null ? "memory.revoke" : "memory.restore",
                            fields: ["id": memory["id"], "expectedVersion": memory["version"], "confirmed": .bool(true)], destructive: memory["revokedAt"] == .null)
                    }.disabled(locked)
                }
            }
            if (nextMemoryCursor ?? section("memories")["nextCursor"]) != .null {
                Button("加载更多记忆") { Task { await loadMoreMemories() } }.disabled(loadingMore)
            }
        }
    }
    private func loadMoreMemories() async {
        loadingMore = true; defer { loadingMore = false }
        do {
            let api = ClientInspectorAPI(transport: try await connection.transport())
            let page = try await api.read(sessionID: sessionID, resource: "memories", parameters: ["cursor": nextMemoryCursor ?? section("memories")["nextCursor"]])
            guard !Task.isCancelled else { return }
            moreMemories += page["items"].items; nextMemoryCursor = page["nextCursor"]
        } catch { store.error = PadWorktreeFailure.describe(error, stage: "加载更多记忆") }
    }
    @ViewBuilder private var taskControls: some View {
        if let definition = store.snapshot?.taskDefinition {
            ConversationDetailModuleCard(title: "Task 摘要与设置", systemImage: "checklist") {
                let summary = definition["summary"]["content"]
                ForEach(["messageSummary", "focus", "progress", "nextAction"], id: \.self) { key in
                    if let text = summary[key].text, !text.isEmpty { ConversationDetailText(text: text) }
                }
                Button("编辑 Task 定义与执行 Agent") {
                    editor = .init(title: "编辑 Task", action: "task.update", fields: definition.fields,
                        inputs: [.init(key: "title", label: "标题"), .init(key: "description", label: "描述", multiline: true),
                                 .init(key: "acceptanceCriteria", label: "验收标准", multiline: true), .init(key: "verificationCriteria", label: "验证标准", multiline: true),
                                 .init(key: "priority", label: "优先级", choices: ["low", "medium", "high", "urgent"].map { ($0, $0) }),
                                 .init(key: "mainAgentId", label: "Agent", choices: definition["agents"].items.compactMap {
                                     guard let id = $0["id"].text else { return nil }; return (id, $0["name"].text ?? id)
                                 })])
                    editor?.fields.removeValue(forKey: "summary"); editor?.fields.removeValue(forKey: "agents")
                    editor?.fields.removeValue(forKey: "lifecycleState")
                }.disabled(locked)
            }
        }
    }
    private var schedules: some View {
        ConversationDetailModuleCard(title: "定时任务", systemImage: "clock.badge") {
            ForEach(section("schedules").items, id: \.inspectorID) { task in
                VStack(alignment: .leading, spacing: 3) {
                    Text(task["name"].text ?? "定时任务")
                    Text("\(task["scheduleType"].text ?? "") · \(task["status"].text ?? "")").font(.caption)
                    Text(task["nextRunAt"].text ?? task["runAt"].text ?? "").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
    private var taskWorktree: some View {
        ConversationDetailModuleCard(title: "Worktree", systemImage: "arrow.triangle.branch") {
            if worktree != .null {
                Text(worktree["worktree"]["branchName"].text ?? worktree["status"].text ?? "")
                Text(worktree["worktree"]["path"].text ?? "").font(.caption.monospaced()).textSelection(.enabled)
                if let blocker = worktree["blocker"].text { Text(blocker).font(.caption).foregroundStyle(.orange) }
                if worktree["worktree"]["mergedIntoMain"].flag { Label("已合并", systemImage: "checkmark.circle").font(.caption) }
                if worktree["worktree"]["dirty"].flag { Text("存在未提交修改").font(.caption).foregroundStyle(.orange) }
                if worktree["canReclaim"].flag {
                    Button("回收 Worktree", role: .destructive) {
                        confirmation = .init(title: "回收已合并的 Worktree 和本地分支？会话历史会保留。", action: "task.reclaimWorktree",
                            fields: ["confirmed": .bool(true)], destructive: true)
                    }.disabled(locked)
                }
            }
            Button(inspectingWorktree ? "检查中…" : "检查 Worktree 状态") {
                Task {
                    inspectingWorktree = true; defer { inspectingWorktree = false }
                    do {
                        let api = ClientInspectorAPI(transport: try await connection.transport())
                        worktree = try await api.read(sessionID: sessionID, resource: "task-worktree")
                    } catch { store.error = PadWorktreeFailure.describe(error, stage: "检查 Worktree") }
                }
            }.disabled(inspectingWorktree || locked)
        }
    }
    private var recalls: some View {
        DisclosureGroup("记忆召回") {
            ForEach(Array(section("recalls").items.enumerated()), id: \.offset) { _, recall in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(recall["phase"].text ?? "") · \(recall["mode"].text ?? "")").font(.caption.bold())
                    Text("\(recall["reason"].text ?? "") · hit \(recall["selectedIds"].items.count)/\(recall["candidateIds"].items.count)").font(.caption)
                }
            }
            if section("recalls").items.isEmpty { Text("尚无召回记录").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var turnAnalysis: some View {
        DisclosureGroup("Turn 时间分析") {
            let turn = section("turn")
            if let id = turn["identity"]["turnExecutionId"].text {
                let duration = turn["wall"]["wallClockMs"].number ?? turn["wall"]["observedWatermarkMs"].number ?? 0
                LabeledContent("总耗时", value: String(format: "%.2f s", duration / 1000)).monospacedDigit()
                LabeledContent("关键路径", value: String(format: "%.2f s", (turn["wallPartition"]["attributedUnionMs"].number ?? 0) / 1000)).monospacedDigit()
                LabeledContent("未归因", value: String(format: "%.2f s", (turn["wallPartition"]["unattributedMs"].number ?? 0) / 1000)).monospacedDigit()
                if turn["inclusive"]["provider.opaque"] != .null && turn["inclusive"]["provider.model_sampling"] == .null {
                    Text("边界观测 · 数值为估算").font(.caption).foregroundStyle(.orange)
                }
                Text(turn["completeness"]["state"].text ?? "").font(.caption).foregroundStyle(.secondary)
                ForEach(turn["inclusive"].fields.keys.sorted(), id: \.self) { category in
                    LabeledContent(category, value: String(format: "%.2f s", (turn["inclusive"][category].number ?? 0) / 1000)).font(.caption).monospacedDigit()
                }
                Button("详细 Trace（按需加载）") { document = .init(title: "Turn Trace", resource: "trace", value: turn, parameters: ["id": .string(id)]) }
            } else { Text("暂无已完成 Turn 的时间摘要").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var environment: some View {
        ConversationDetailModuleCard(title: "工作空间与 Provider", systemImage: "cpu") {
            if workspace.selection == sessionID {
                if let provider = store.snapshot?.environment["provider"].text {
                    LabeledContent("Provider", value: provider)
                }
                if let model = workspace.composerConfiguration?.currentModel ?? workspace.selectedSessionUsage?.route?.modelId {
                    LabeledContent("模型", value: model)
                }
                if let reasoning = workspace.composerConfiguration?.currentReasoningLevel {
                    LabeledContent("推理强度", value: reasoning)
                }
            }
            if let cwd = store.snapshot?.environment["cwd"].text { Text(cwd).font(.caption.monospaced()).textSelection(.enabled); ShareLink("分享工作空间路径", item: cwd) }
            Menu("切换 Provider") {
                ForEach(section("providers").items, id: \.inspectorID) { provider in
                    Button(provider["name"].text ?? provider["id"].text ?? "Provider") {
                        confirmation = .init(title: "切换 Provider？", action: "provider.switch", fields: [
                            "providerId": provider["id"], "expectedRoutingVersion": store.snapshot?.environment["routingVersion"] ?? .null, "confirmed": .bool(true)])
                    }.disabled(!provider["available"].flag)
                }
            }.disabled(locked)
        }
    }
    private func perform(_ action: String, id: ClientInspectorValue) {
        Task { await store.command(action, fields: ["id": id], sessionID: sessionID, connection: connection) }
    }
    private func importDocument(_ url: URL) async {
        let artifact = importAsArtifact
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try await Task.detached(priority: .userInitiated) {
                let info = try url.resourceValues(forKeys: [.fileSizeKey])
                guard let size = info.fileSize, size > 0, size <= 8 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
                return try Data(contentsOf: url)
            }.value
            await store.command(artifact ? "artifact.import" : "reference.import", fields: [
                "fileName": .string(url.lastPathComponent), "dataBase64": .string(data.base64EncodedString())],
                sessionID: sessionID, connection: connection)
        } catch { store.error = PadWorktreeFailure.describe(error, stage: "导入文档（上限 8 MB）") }
    }
    private func confirm(_ title: String, action: String, id: ClientInspectorValue) {
        confirmation = .init(title: title, action: action, fields: ["id": id, "confirmed": .bool(true)], destructive: true)
        if action == "reference.delete" { confirmation?.fields.removeValue(forKey: "confirmed") }
    }
}

extension ClientInspectorValue {
    var inspectorID: String {
        for key in ["referenceId", "artifactId", "id", "taskId"] { if let value = self[key].text { return value } }
        return "unknown"
    }
}
func artifactReadParameters(_ artifact: ClientInspectorValue, taskID: String?) -> [String: ClientInspectorValue] {
    let reference = artifact["references"].items.first { taskID != nil && $0["taskId"].text == taskID && $0["revokedAt"] == .null }
    let version = ClientInspectorValue.number(Double(ConversationInspectorPolicy.preferredArtifactVersion(
        pinned: reference?["pinnedVersion"].number.map(Int.init), approved: artifact["approvedVersion"].number.map(Int.init),
        current: Int(artifact["currentVersion"].number ?? 1))))
    let hash = reference?["pinnedHash"] ?? artifact["versions"].items.first { $0["version"] == version }?["contentHash"] ?? .null
    var result: [String: ClientInspectorValue] = ["id": artifact["artifactId"], "version": version, "contentHash": hash]
    if let reference { result["referenceId"] = reference["referenceId"] }
    return result
}
#endif
