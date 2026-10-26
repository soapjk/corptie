import SwiftUI
import CorptieClientCore

struct ConversationNativeBusinessDetail: View {
    let store: ClientDetailBusinessStore
    var commandStore: ClientDetailBusinessStore? = nil
    private var operationStore: ClientDetailBusinessStore { commandStore ?? store }
    let api: ClientDetailAPI?
    let actions: ConversationDetailActions?
    let context: ClientDetailContext
    let adapters: ConversationDetailAdapters
    let handle: ClientDetailBusinessHandle
    let arrangement: ConversationDetailCardArrangement
    let arranging: Bool
    let refresh: @MainActor () async -> Void
    var renderState: ConversationDetailRenderState? = nil
    var activity: ConversationDetailPresentationActivity? = nil
    let canCommand: (String, ClientDetailAction) -> Bool
    let perform: (String, ClientDetailAction, [String: ClientInspectorValue]) -> Void
    private var cards: [ClientDetailBusinessCardState] {
        arrangement.ordered(ClientDetailCardPolicy.orderedCards(in: store, context: context))
    }
    var body: some View {
        if #available(macOS 27.0, iOS 27.0, *) {
            DetailWidgetLayout(sizes: cards.map { DetailWidgetSizing.preferredSize(for: $0.card) }) {
                rows.reorderable()
            }
            .reorderContainer(for: ClientDetailBusinessCardState.self, isEnabled: arranging) { difference in
                guard arranging else { return }
                let destination: String?
                switch difference.destination.position {
                case .before(let id): destination = id
                case .end: destination = nil
                @unknown default: return
                }
                arrangement.move(difference.sources, before: destination, cards: cards)
            }
            .environment(\.detailArranging, arranging)
        } else {
            DetailWidgetLayout(sizes: cards.map { DetailWidgetSizing.preferredSize(for: $0.card) }) { rows }
        }
    }
    private var rows: ForEach<[ClientDetailBusinessCardState], String, some View> {
        ForEach(cards) { state in
            Group {
                if state.card.loadState == "error" {
                    NativeBusinessCard(state: state, api: api, store: store, commandStore: operationStore, activity: activity, actions: actions, references: adapters.referenceManagement, openArtifact: adapters.openArtifact, workID: context.workID,
                        canCommand: { canCommand(state.id, $0) }, perform: { perform(state.id, $0, $1) }, retry: { Task { await refresh() } })
                        .environment(\.detailSectionPrefix, state.id)
                } else {
                    sharedCard(state).environment(\.detailSectionPrefix, state.id)
                }
            }
            .detailWidget(DetailWidgetSizing.preferredSize(for: state.card))
        }
    }
    @ViewBuilder private func sharedCard(_ state: ClientDetailBusinessCardState) -> some View {
        switch state.card.payload {
        case .provider:
            ConversationDetailProviderCard(configuration: adapters.configuration, scope: handle.scope.sessionID,
                select: adapters.selectConfiguration, reload: adapters.reloadConfiguration).disabled(!store.isCurrent)
        case .turn(let value):
            if let id = value.turnId {
                ConversationDetailTurnCard(state: handle.turn, executionID: id,
                    expectedSessionIDs: [handle.scope.sessionID, store.sessionID ?? ""],
                    readSummary: { try await adapters.readTurnSummary(id) }, readTrace: adapters.readTurnTrace, liveSnapshot: adapters.turnSnapshot,
                    presentationState: renderState?.turn, activity: activity)
                    .disabled(!store.isCurrent)
            }
        case .worktree(let value):
            ConversationWorktreeCard(sessionID: handle.scope.sessionID, refreshID: "\(value.worktreeId ?? ""):\(state.card.revision)",
                api: { try await adapters.worktreeAPI(value.worktreeId) }, onJob: adapters.onWorktreeJob,
                state: handle.worktree, expectedWorktreeID: value.worktreeId,
                presentationState: renderState?.worktree, activity: activity)
                .disabled(!store.isCurrent)
        default:
            NativeBusinessCard(state: state, api: api, store: store, commandStore: operationStore, activity: activity, actions: actions, references: adapters.referenceManagement, openArtifact: adapters.openArtifact, workID: context.workID,
                canCommand: { canCommand(state.id, $0) }, perform: { perform(state.id, $0, $1) }, retry: { Task { await refresh() } })
        }
    }
}

private struct NativeBusinessCard: View {
    @Environment(\.detailWidgetSize) private var widgetSize
    @Bindable var state: ClientDetailBusinessCardState
    let api: ClientDetailAPI?
    let store: ClientDetailBusinessStore
    var commandStore: ClientDetailBusinessStore? = nil
    private var operationStore: ClientDetailBusinessStore { commandStore ?? store }
    let activity: ConversationDetailPresentationActivity?
    let actions: ConversationDetailActions?
    let references: ConversationReferenceManagement?
    let openArtifact: ((ClientResourceFocus) -> Void)?
    let workID: String?
    let canCommand: (ClientDetailAction) -> Bool
    let perform: (ClientDetailAction, [String: ClientInspectorValue]) -> Void
    let retry: () -> Void
    @State private var addingReference = false
    @State private var locator = ""
    @State private var displayName = ""
    @State private var artifactSelection: NativeArtifactSelection?
    private var card: ClientDetailBusinessCard { state.card }
    var body: some View {
        ConversationDetailModuleCard(title: title, systemImage: symbol) {
            ForEach(card.actions.filter { card.loadState != "error" && $0.kind == "navigation" && $0.operation == "editor.open" && $0.target?.resourceType == "task" }) { action in
                NativeBusinessNavigation(action: action, symbol: "square.and.pencil", actions: actions)
            }
            if card.kind == "contextReferences", let references {
                Menu {
                    ForEach(references.addKinds) { kind in
                        Button(kind.title) { references.add(kind) }
                    }
                } label: { ConversationDetailHeaderIcon(systemName: "plus") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden)
                .disabled(!store.isCurrent || !references.canAdd || card.loadState == "error"
                    || !card.actions.contains(where: { $0.operation == "reference.add" && $0.available }))
                .help("添加引用").accessibilityLabel("添加引用")
            } else if card.loadState != "error", card.actions.contains(where: { $0.operation == "reference.add" }) {
                Button { addingReference.toggle() } label: { Image(systemName: "plus").frame(minWidth: 24, minHeight: 24) }
                    .buttonStyle(.plain).foregroundStyle(Color.accentColor).help("添加引用").accessibilityLabel("添加引用")
            }
        } content: {
            if card.loadState == "error" {
                HStack(alignment: .top) {
                    Label("暂时无法读取", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button(action: retry) { ConversationDetailHeaderIcon(systemName: "arrow.clockwise") }
                        .buttonStyle(.plain).disabled(api == nil).help("重试读取").accessibilityLabel("重试读取")
                }
            } else { content }
            if addingReference, let action = card.actions.first(where: { $0.operation == "reference.add" }) {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("网页地址", text: $locator).textFieldStyle(.roundedBorder)
                    TextField("名称（可选）", text: $displayName).textFieldStyle(.roundedBorder)
                    Text("添加后服务器会读取该网页").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("添加") { perform(action, ["locator": .string(locator), "displayName": .string(displayName)]) }
                            .disabled(!canCommand(action) || !ConversationDetailFormInputPolicy.acceptsReferenceLocator(locator))
                        Button("取消") { addingReference = false }
                    }
                }
            }
        }
        .sheet(item: $artifactSelection) { selection in
            if let api {
            ConversationNativeArtifactReader(title: selection.row.title, artifactID: selection.row.id,
                version: selection.row.version ?? 0, hash: selection.row.contentHash, action: selection.action,
                cardID: card.id, documentID: store.documentID ?? "", sessionID: store.sessionID ?? "", api: api,
                openInResources: openArtifact, workID: workID)
            }
        }
        .onChange(of: store.generation) { _, _ in artifactSelection = nil }
        .onChange(of: store.error) { _, value in if value != nil { artifactSelection = nil } }
    }
    @ViewBuilder private var content: some View {
        switch card.payload {
        case .session(let value):
            NativeBusinessProperty(title: "Session", value: value.sessionId)
            if !value.workName.isEmpty { NativeBusinessProperty(title: "Work", value: value.workName) }
        case .summary(let value): NativeBusinessTextSection(title: "会话摘要", text: value.text)
        case .work(let value):
            Text(value.name).font(.system(size: 12, weight: .medium))
            NativeBusinessTextSection(title: "Work 概述", text: value.description)
        case .task(let value):
            Text(value.title).font(.system(size: 12, weight: .medium)).textSelection(.enabled)
            HStack {
                NativeBusinessStatus(status: value.status)
                Spacer(minLength: 8)
                ForEach(card.actions.filter { $0.operation == "resource.open" && $0.target?.resourceType == "session" }) { action in
                    NativeBusinessNavigation(action:action,symbol:"arrow.up.backward",actions:actions)
                }
            }
            if let hierarchy = value.hierarchy, hierarchy.childCount > 0 {
                Text("\(hierarchy.completedChildCount)/\(hierarchy.childCount) 子任务已完成")
                    .font(.caption).foregroundStyle(.secondary)
            }
            NativeBusinessSummary(summary: value.summary)
            NativeBusinessTextSection(title: "描述", text: value.description)
            NativeBusinessTextSection(title: "验收标准", text: value.acceptanceCriteria)
            NativeBusinessTextSection(title: "验证标准", text: value.verificationCriteria)
        case .artifacts(let list):
            listContainer(count: list.items.count) {
                ForEach(list.items) { row in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "doc.text").foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 4) {
                            if let action = card.actions.first(where: { $0.operation == "artifact.content" && $0.target?.id == row.id }) {
                                Button { artifactSelection = .init(row: row, action: action) } label: {
                                    Text(row.title).font(.system(size: 12, weight: .bold))
                                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).foregroundStyle(.primary)
                                .disabled(!row.readAvailable || !action.available || !store.isCurrent || api == nil)
                                .accessibilityLabel("预览 \(row.title)").help("打开小窗预览")
                            } else { Text(row.title).font(.system(size: 12, weight: .bold)).foregroundStyle(.primary) }
                            if !row.summary.isEmpty { Text(row.summary).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        case .focus(let list):
            Text("当前 Work 中需要关注的未完成 Task，点击可打开对应会话。")
                .font(.caption).foregroundStyle(.secondary)
            listContainer(count: list.items.count) {
                ForEach(list.items) { row in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.title).font(.system(size: 12, weight: .medium))
                            NativeBusinessSummary(summary: row.summary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        if let id = row.sessionId, let action = navigation(target: id) {
                            NativeBusinessNavigation(action: action, symbol: "arrow.up.right.square", actions: actions,
                                fields: ["sourceResourceType": .string("task"), "sourceResourceId": .string(row.taskId)])
                        }
                    }
                }
            }
        case .references(let list):
            if list.items.isEmpty {
                Text("暂无引用").font(.caption).foregroundStyle(.secondary)
                pageTail
            } else { listContainer(count: list.items.count) {
                ForEach(list.items) { row in
                    HStack {
                        Image(systemName: ConversationReferenceSymbol.symbol(for: row.targetType)).foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.title).font(.system(size: 12, weight: .medium))
                            Text(ConversationReferenceStatus.label(for: row.status, targetType: row.targetType, enabled: row.enabled))
                                .font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        if let references {
                            Menu {
                                ForEach(references.operations(row.id)) { operation in
                                    Button(operation.title, role: operation == .remove ? .destructive : nil) {
                                        references.perform(row.id, operation)
                                    }
                                }
                            } label: { ConversationDetailHeaderIcon(systemName: "ellipsis") }
                            .menuStyle(.borderlessButton).menuIndicator(.hidden)
                            .disabled(!store.isCurrent).accessibilityLabel("引用操作")
                        } else {
                            if let action = navigation(target: row.id) { NativeBusinessNavigation(action: action, symbol: "arrow.up.right.square", actions: actions) }
                            if let action = command("reference.remove", target: row.id) { commandButton(action, symbol: "trash") }
                        }
                    }
                }
            } }
        case .memories(let list), .hits(let list):
            listContainer(count: list.items.count, longContent: list.items.contains { $0.content.count > 1000 }) {
                ForEach(list.items) { row in
                    NativeBusinessMemoryRow(row: row, isHit: card.kind == "memoryHits", actions: card.actions.filter { $0.target?.id == row.id },
                        canCommand: canCommand, perform: perform, onEditingChanged: { operationStore.setEditing(cardID: state.id, resourceID: row.id, $0) })
                        .environment(\.detailSectionPrefix, "\(card.id):\(row.id)")
                }
            }
        case .schedules(let list):
            listContainer(count: list.items.count) {
                ForEach(list.items) { row in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(row.name).font(.system(size: 12, weight: .medium)).frame(maxWidth: .infinity, alignment: .leading)
                            if let action = navigation(target: row.id) { NativeBusinessNavigation(action: action, symbol: "arrow.up.right.square", actions: actions) }
                            if let action = command("schedule.cancel", target: row.id) { commandButton(action, symbol: "xmark.circle") }
                        }
                        NativeBusinessStatus(status: row.status)
                        if let raw = row.nextRunAt ?? row.runAt { NativeBusinessDate(raw: raw) }
                    }
                }
            }
        case .provider(let value):
            NativeBusinessProperty(title: "Provider", value: value.name.isEmpty ? "未设置" : value.name)
            NativeBusinessProperty(title: "模型", value: value.model.isEmpty ? "未设置" : value.model)
            if !value.reasoning.isEmpty { NativeBusinessProperty(title: "推理配置", value: value.reasoning) }
            if value.switching { Label("正在切换", systemImage: "arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.orange) }
        case .worktree(let value):
            if value.attached, let tree = value.tree {
                NativeBusinessProperty(title: "分支", value: tree.branchName)
                NativeBusinessProperty(title: "主分支", value: value.mainBranch)
                if let dirty = tree.dirty { Text(dirty ? "有未提交改动" : "工作区干净").font(.caption).foregroundStyle(dirty ? Color.orange : Color.green) }
                if let count = tree.changedFileCount { NativeBusinessProperty(title: "变更文件", value: String(count)) }
                if let ahead = tree.aheadOfMain { NativeBusinessProperty(title: "领先主分支", value: String(ahead)) }
                if let behind = tree.behindMain { NativeBusinessProperty(title: "落后主分支", value: String(behind)) }
                if let job = value.job { NativeBusinessStatus(status: job.status) }
            } else { Text("未关联 Worktree").font(.caption).foregroundStyle(.secondary) }
            if !value.blockedReason.isEmpty { Text("当前绑定暂不可操作，请打开管理查看原因").font(.caption).foregroundStyle(.orange) }
        case .turn(let value):
            if value.turnId == nil { Text("暂无执行数据").font(.caption).foregroundStyle(.secondary) }
            else {
                if value.completeness != "complete" { Text("部分执行数据").font(.caption).foregroundStyle(.orange) }
                NativeBusinessMetrics(title: "耗时", values: value.wall)
                NativeBusinessMetrics(title: "阶段耗时", values: value.wallPartition)
                NativeBusinessMetrics(title: "累计耗时", values: value.inclusive)
            }
        case .unsupported: Text("需要支持此卡片版本的客户端").font(.caption).foregroundStyle(.secondary)
        }
    }
    private func navigation(target: String) -> ClientDetailAction? { card.actions.first { $0.kind == "navigation" && $0.operation == "resource.open" && $0.target?.id == target } }
    private func command(_ operation: String, target: String) -> ClientDetailAction? { card.actions.first { $0.operation == operation && $0.target?.id == target } }
    private func commandButton(_ action: ClientDetailAction, symbol: String) -> some View {
        Button { perform(action, [:]) } label: { Image(systemName: symbol).frame(minWidth: 24, minHeight: 24) }
            .buttonStyle(.plain).foregroundStyle(Color.red).disabled(!canCommand(action)).help(action.label.fallback).accessibilityLabel(action.label.fallback)
    }
    @ViewBuilder private func listContainer<Rows: View>(count: Int, longContent: Bool = false, @ViewBuilder rows: () -> Rows) -> some View {
        if count == 0 {
            Text("暂无内容").font(.caption).foregroundStyle(.secondary)
            pageTail
        } else if widgetSize != nil {
            LazyVStack(alignment: .leading, spacing: 12) { windowNotice; rows(); pageTail }
        } else if count > 4 || card.nextCursor != nil || longContent {
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 12) { windowNotice; rows(); pageTail }
            }.frame(height: 280)
        } else { VStack(alignment: .leading, spacing: 12) { windowNotice; rows(); pageTail } }
    }
    @ViewBuilder private var windowNotice: some View {
        if state.windowClipped { Text("较早内容已移出当前窗口，刷新可回到开头").font(.caption).foregroundStyle(.secondary) }
    }
    @ViewBuilder private var pageTail: some View {
        if let message = state.pageError {
            VStack(alignment: .leading) {
                Text(message).font(.caption).foregroundStyle(.secondary)
                Button("重试加载") { if let api { Task { guard activity?.allows(generation: activity?.generation ?? 0) ?? true else { return }; await operationStore.loadMore(cardID: state.id, api: api, retry: true) } } }.font(.caption).disabled(state.loading || api == nil || !store.isCurrent)
            }
        } else if card.nextCursor != nil {
            // A task on a lazy tail can repeatedly appear/cancel at the viewport
            // boundary, invalidating layout even when loadMore returns early.
            // Keep paging tied to an explicit action, outside appearance state.
            Button {
                if let api { Task { guard activity?.allows(generation: activity?.generation ?? 0) ?? true else { return }; await operationStore.loadMore(cardID: state.id, api: api, retry: true) } }
            } label: {
                HStack(spacing: 6) {
                    if state.loading { ProgressView().controlSize(.small) }
                    Text(state.loading ? "正在加载…" : "加载更多")
                }
            }
            .font(.caption)
            .disabled(state.loading || api == nil || !store.isCurrent)
            .accessibilityLabel("加载更多")
            .accessibilityIdentifier("detail.collection.load-more.\(state.id)")
        }
    }
    private var title: String {
        switch card.kind {
        case "sessionInfo": "会话信息"
        case "chatSummary": "会话摘要"
        case "taskInfo": "Task 信息"
        case "workOverview": "Work 概述"
        case "focusTasks": "待关注 Task"
        case "contextReferences": "引用"
        case "artifacts": "Artifact"
        case "memoryHits": "本 Session 已命中记忆"
        case "memoryResources": "记忆管理"
        case "schedules": "计划任务"
        case "provider": "Provider"
        case "worktree": "Workspace / Worktree"
        case "turnMetrics": "Turn 分析"
        default: "卡片暂不支持"
        }
    }
    private var symbol: String {
        switch card.kind { case "taskInfo", "focusTasks": "checklist"; case "artifacts": "doc.text"; case "memoryHits", "memoryResources": "brain"; case "schedules": "clock"; case "worktree": "arrow.triangle.branch"; default: "info.circle" }
    }
}
private struct NativeArtifactSelection: Identifiable {
    let row: ClientDetailBusinessArtifact
    let action: ClientDetailAction
    var id: String { row.id + ":" + row.contentHash }
}

private struct NativeBusinessMemoryRow: View {
    let row: ClientDetailBusinessMemory
    let isHit: Bool
    let actions: [ClientDetailAction]
    let canCommand: (ClientDetailAction) -> Bool
    let perform: (ClientDetailAction, [String: ClientInspectorValue]) -> Void
    let onEditingChanged: (Bool) -> Void
    @Environment(\.detailPresentation) private var presentation
    @Environment(\.detailSectionPrefix) private var prefix
    @State private var localDraft = ConversationDetailDraft()
    private var retainedDraft: ConversationDetailDraft? { presentation?.draft(prefix) }
    private var draftState: ConversationDetailDraft { retainedDraft ?? localDraft }
    private var editing: Bool {
        get { draftState.editing } nonmutating set { draftState.editing = newValue }
    }
    private var draft: String {
        get { draftState.text } nonmutating set { draftState.text = String(newValue.prefix(16000)) }
    }
    private var draftRevision: String? {
        get { draftState.revision } nonmutating set { draftState.revision = newValue }
    }
    private var save: ClientDetailAction? { actions.first { $0.operation == "memory.update" } }
    private var conflicted: Bool { editing && draftRevision != save?.expectedResourceRevision }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            NativeBusinessTextSection(title: kindTitle,
                text: row.unavailable ? "内容已不可用，仅保留命中记录" : row.content)
            if (!isHit && save != nil) || actions.contains(where: { $0.operation == "memory.delete" }) {
              HStack {
                Spacer(minLength: 0)
                if !isHit, let save {
                    Button { draft = row.content; draftRevision = save.expectedResourceRevision; editing.toggle() } label: { Image(systemName: "square.and.pencil").frame(minWidth: 24, minHeight: 24) }
                        .buttonStyle(.plain).help("编辑记忆").accessibilityLabel("编辑记忆")
                }
                if let remove = actions.first(where: { $0.operation == "memory.delete" }) {
                    Button { perform(remove, [:]) } label: { Image(systemName: "trash").frame(minWidth: 24, minHeight: 24) }
                        .buttonStyle(.plain).foregroundStyle(Color.red).disabled(!canCommand(remove)).help("撤销记忆").accessibilityLabel("撤销记忆")
                }
              }
            }
            if editing, let save {
                TextEditor(text: Binding(get: { draft }, set: { draft = $0 })).font(.system(size: 12)).frame(height: 140)
                if retainedDraft == nil { Text("其他草稿已占满保留窗口；此草稿仅在本次打开期间保留").font(.caption).foregroundStyle(.secondary) }
                if conflicted {
                    Text("资源已变化，草稿保留；请重新加载后确认").font(.caption).foregroundStyle(.orange)
                    Button("重新加载") { draft = row.content; draftRevision = save.expectedResourceRevision }
                }
                HStack {
                    Button("保存") { perform(save, ["content": .string(draft)]) }
                        .disabled(conflicted || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.utf16.count > 16000 || !canCommand(save))
                    Button("取消") { editing = false }
                }
            }
        }
        .onChange(of: editing) { _, value in onEditingChanged(value) }
        .onAppear { onEditingChanged(editing) }
    }
    private var kindTitle: String { switch row.kind { case "preference": "偏好"; case "fact": "事实"; case "workflow": "工作方式"; case "lesson": "经验"; default: "记忆" } }
}

private struct NativeBusinessTextSection: View {
    let title: String
    let text: String
    @Environment(\.detailPresentation) private var presentation
    @Environment(\.detailSectionPrefix) private var prefix
    @State private var localExpanded = false
    private var expansion: ConversationDetailExpansion? { presentation?.section("\(prefix):\(title)") }
    private var expanded: Bool { expansion?.expanded ?? localExpanded }
    var body: some View {
        if !text.isEmpty {
            ConversationStampedParagraph(title: title, text: text, expansion: Binding(
                get: { expanded }, set: { value in
                    if let expansion { expansion.expanded = value } else { localExpanded = value }
                }))
        }
    }
}
private struct NativeBusinessNavigation: View {
    let action: ClientDetailAction
    let symbol: String
    let actions: ConversationDetailActions?
    var fields: [String: ClientInspectorValue] = [:]
    var body: some View {
        Button { guard action.available, actions?.canPerform(action) == true else { return }; actions?.perform(action, fields) } label: {
            if action.operation == "editor.open" { ConversationDetailHeaderIcon(systemName: symbol) }
            else { Image(systemName: symbol).frame(minWidth: 24, minHeight: 24) }
        }
            .buttonStyle(.plain).foregroundStyle(Color.accentColor).disabled(!action.available || actions?.canPerform(action) != true)
            .accessibilityLabel(action.label.fallback).help(action.label.fallback)
    }
}
private struct NativeBusinessProperty: View {
    let title: String; let value: String
    var body: some View { HStack(alignment: .top, spacing: 8) { Text(title).foregroundStyle(.secondary); Spacer(minLength: 0); Text(value).textSelection(.enabled) }.font(.caption) }
}
private struct NativeBusinessStatus: View {
    let status: String
    var body: some View { Text(label).font(.caption).foregroundStyle(color) }
    private var label: String {
        switch status { case "done", "completed": "已完成"; case "blocked", "failed": "受阻"; case "active", "running", "in_progress": "进行中"; case "pending", "planned": "待处理"; case "available", "ready": "可用"; case "cancelled": "已取消"; case "disabled": "已停用"; default: "状态已更新" }
    }
    private var color: Color { ["done", "completed", "available", "ready"].contains(status) ? .green : ["blocked", "failed"].contains(status) ? .orange : .secondary }
}
private struct NativeBusinessSummary: View {
    let summary: ClientDetailBusinessTaskSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if summary.current == false { Text("摘要待更新").font(.caption2).foregroundStyle(.secondary) }
            if !summary.focus.isEmpty { NativeBusinessProperty(title: "当前重点", value: summary.focus) }
            if !summary.progress.isEmpty { NativeBusinessProperty(title: "进展", value: summary.progress) }
            if summary.intervention == "required", summary.current != false {
                Text(summary.nextAction.isEmpty ? summary.reason : summary.nextAction).font(.caption).foregroundStyle(.orange)
            }
        }
    }
}
private struct NativeBusinessDate: View {
    let raw: String
    private var date: Date? { ClientDetailV2Catalog.date(raw) }
    var body: some View { if let date { Text(date, format: .dateTime.year().month().day().hour().minute()).font(.caption).foregroundStyle(.secondary) } }
}
private struct NativeBusinessMetrics: View {
    let title: String; let values: [String: String]
    var body: some View {
        if !values.isEmpty {
            DisclosureGroup(title) {
                ForEach(values.keys.sorted(), id: \.self) { key in NativeBusinessProperty(title: metricTitle(key), value: values[key] ?? "") }
            }.font(.caption)
        }
    }
    private func metricTitle(_ key: String) -> String {
        switch key { case "total", "totalMs": "总计（ms）"; case "model", "modelMs": "模型（ms）"; case "tools", "toolMs": "工具（ms）"; case "queue", "queueMs": "排队（ms）"; case "provider", "providerMs": "Provider（ms）"; default: key }
    }
}
