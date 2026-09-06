import SwiftUI

/// No transcript reads or per-card observers. Index on collection changes,
/// retain displayed membership until explicit refresh, and append new alerts.
struct ConsoleCardWorkspace<TaskMenu: View>: View {
    var isActive = true
    let works: [Work]
    let tasks: [CorptieTask]
    let sessions: [TaskSession]
    let selectedTaskID: String?
    let query: String
    @Binding var attentionCount: Int
    let refreshRevision: Int
    let openTask: (CorptieTask, TaskSession?) -> Void
    let discuss: (Work) -> Void
    let createTask: (Work) -> Void
    let taskMenu: (CorptieTask) -> TaskMenu
    @State private var members: [String: [String]] = [:]
    @State private var retainedTasks: [String: CorptieTask] = [:]
    @State private var sessionByTask: [String: TaskSession] = [:]
    @State private var workOrder: [String] = []
    @State private var browsing: Work?
    @State private var pageTasks: [CorptieTask] = []
    @State private var cursor: String?
    @State private var hasMore = false
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var browseGeneration = UUID()
    @State private var reachable = AppStateStore.shared.isReachable
    @State private var syncError = AppStateStore.shared.syncError
    @State private var counts: [String: (attention: Int, running: Int)] = [:]
    @State private var residentTaskIDs = Set<String>()
    @State private var tasksByWork: [String: [CorptieTask]] = [:]

    var body: some View {
        VStack(spacing: 8) {
            if !reachable || syncError != nil {
                Text("同步尚未就绪，状态和数量可能不是最新").font(.caption).foregroundStyle(.orange)
            }
            if browsing != nil {
                    Button("返回", systemImage: "arrow.left") {
                        browseGeneration = UUID()
                        browsing = nil
                        isLoading = false
                    }
                    .padding(.horizontal, 10)
            }
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if let browsing {
                                Text(browsing.name).font(.headline)
                                ForEach(pageTasks) { task in card(task) }
                                if let loadError { Text(loadError).foregroundStyle(.red) }
                                if hasMore || loadError != nil {
                                    Button(isLoading ? "加载中…" : "加载更多") { loadPage(browsing, reset: false) }
                                        .disabled(isLoading)
                                }
                                if isLoading { ProgressView().controlSize(.small) }
                            } else {
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 12, alignment: .top)], alignment: .leading, spacing: 12) {
                                    ForEach(orderedWorks) { work in group(work).id(work.id) }
                                }
                            }
                        }.padding(10)
                    }
        }
        .onAppear { if isActive { rebuild(reset: false) } }
        .onChange(of: refreshRevision) { _, _ in if isActive { rebuild(reset: true) } }
        .onChange(of: isActive) { _, active in if active { rebuild(reset: false) } }
        .onReceive(AppStateStore.shared.$isReachable.removeDuplicates()) { reachable = $0 }
        .onReceive(AppStateStore.shared.$syncError.removeDuplicates()) { syncError = $0 }
        .onChange(of: tasks) { _, _ in if isActive { rebuild(reset: false) } }
        .onChange(of: sessions.map(CardSessionKey.init)) { _, _ in if isActive { rebuild(reset: false) } }
        .onChange(of: selectedTaskID) { _, _ in if isActive { rebuild(reset: false) } }
        .onChange(of: works) { _, _ in if isActive { rebuild(reset: false) } }
    }

    private var orderedWorks: [Work] {
        let index = Dictionary(uniqueKeysWithValues: works.map { ($0.id, $0) })
        return workOrder.compactMap { index[$0] }
    }

    private func rebuild(reset: Bool) {
        let byID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        var latest: [String: TaskSession] = [:]
        for session in sessions where session.archived != true {
            guard let id = session.taskId else { continue }
            if latest[id] == nil || latest[id]!.updatedAt < session.updatedAt { latest[id] = session }
        }
        var bindings: [String: TaskSession] = [:]
        for task in tasks {
            bindings[task.id] = task.currentSessionId.flatMap { byID[$0] } ?? latest[task.id]
        }
        sessionByTask = bindings
        if reset { members = [:]; retainedTasks = [:]; workOrder = [] }
        let existingWorks = Set(works.map(\.id))
        members = members.filter { existingWorks.contains($0.key) }
        workOrder = workOrder.filter { existingWorks.contains($0) }
        let known = Set(workOrder)
        workOrder.append(contentsOf: works.filter { !known.contains($0.id) }.map(\.id))
        let grouped = Dictionary(grouping: tasks, by: \.workId)
        tasksByWork = grouped
        residentTaskIDs = Set(tasks.map(\.id))
        var nextCounts: [String: (attention: Int, running: Int)] = [:]
        for work in works {
            let candidates = (grouped[work.id] ?? []).filter {
                $0.id == selectedTaskID || ($0.archived != true && $0.lifecycleState != "done")
            }
            var wanted = candidates.filter { bindings[$0.id]?.attention != nil || $0.summaryNeedsIntervention || $0.id == selectedTaskID }
            nextCounts[work.id] = (
                candidates.filter { bindings[$0.id]?.attention != nil || $0.summaryNeedsIntervention }.count,
                candidates.filter { bindings[$0.id]?.executionTaskStatus == .running }.count)
            let wantedIDs = Set(wanted.map(\.id))
            wanted += candidates.filter {
                !wantedIDs.contains($0.id) && bindings[$0.id]?.executionTaskStatus == .running
            }.prefix(3)
            for task in grouped[work.id] ?? [] { retainedTasks[task.id] = task }
            var ids = members[work.id] ?? []
            // Keep removals from the active snapshot visible until refresh;
            // absence alone cannot distinguish completion from deletion.
            ids = ids.filter { retainedTasks[$0]?.deletionStatus != "deleted" }
            let old = Set(ids)
            let occupied = ids.filter { bindings[$0]?.attention == nil && bindings[$0]?.executionTaskStatus == .running && $0 != selectedTaskID }.count
            var remaining = max(0, 3 - occupied)
            for task in wanted where !old.contains(task.id) {
                if bindings[task.id]?.attention != nil || task.summaryNeedsIntervention || task.id == selectedTaskID {
                    ids.append(task.id)
                } else if remaining > 0 {
                    ids.append(task.id)
                    remaining -= 1
                }
            }
            members[work.id] = ids
        }
        counts = nextCounts
        let nextAttentionCount = nextCounts.values.reduce(0) { $0 + $1.attention }
        if attentionCount != nextAttentionCount { attentionCount = nextAttentionCount }
        let retainedIDs = Set(members.values.flatMap { $0 })
        retainedTasks = retainedTasks.filter { retainedIDs.contains($0.key) }
    }

    private func group(_ work: Work) -> some View {
        let visible = query.isEmpty ? (members[work.id] ?? []).compactMap { retainedTasks[$0] } : (tasksByWork[work.id] ?? [])
        let displayed = visible.filter {
            query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || work.name.localizedCaseInsensitiveContains(query)
        }
        let alerts = counts[work.id]?.attention ?? 0
        let running = counts[work.id]?.running ?? 0
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                ObjectiveAvatarView(objectiveID: work.id, name: work.name, avatarPath: work.avatarPath, size: 22)
                Text(work.name).font(.headline).lineLimit(1)
                Spacer()
                Button("讨论") { discuss(work) }
                Button("创建 Task", systemImage: "plus") { createTask(work) }.labelStyle(.iconOnly)
            }
            Text("\(alerts) 待处理 · \(running) 执行中").font(.caption).foregroundStyle(.secondary)
            ForEach(displayed) { task in card(task) }
            Button("查看全部") {
                browsing = work
                pageTasks = []
                loadPage(work, reset: true)
            }.font(.caption)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CorptiePalette.workCardSurface, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(nsColor: .separatorColor).opacity(0.3), lineWidth: 1)
                .allowsHitTesting(false)
        }
    }

    private func card(_ task: CorptieTask) -> some View {
        let session = sessionByTask[task.id] ?? sessions.first { $0.id == task.currentSessionId }
        let attention = session?.attention
        return Button {
            openTask(task, session)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(task.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    if task.hasPendingScheduledWake == true {
                        Image(systemName: "alarm").foregroundStyle(.orange).help("存在有效的待执行计划任务")
                    }
                    if let session, isSessionUnread(session) { Circle().fill(.red).frame(width: 6, height: 6) }
                }
                Text(status(task, session)).font(.caption).foregroundStyle(attention == nil ? Color.secondary : .orange)
                if task.userSummary?.content != nil {
                    TaskSummaryView(task: task, compact: true)
                }
                if let reason = attention?.reason, !reason.isEmpty {
                    Text(reason).font(.system(size: 12)).lineLimit(2).frame(height: 32, alignment: .topLeading)
                        .help("来源：\(attention?.sourceId ?? "会话状态")\n更新时间：\(attention?.updatedAt ?? "未知")")
                } else if attention != nil {
                    Text("具体原因尚未提供，请进入会话查看").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(10)
            .background(selectedTaskID == task.id ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(selectedTaskID == task.id ? Color.accentColor : .clear))
            .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(task.deletionStatus == "deleting").contextMenu { taskMenu(task) }
    }

    private func status(_ task: CorptieTask, _ session: TaskSession?) -> String {
        if browsing == nil, !residentTaskIDs.contains(task.id) { return "已移出活动集合 · 刷新后收起" }
        if task.archived == true { return "已归档" }
        if task.lifecycleState == "done" { return "已完成 · 验证情况见详情" }
        switch session?.attention?.kind {
        case "choice": return "等待选择"
        case "failed": return "执行失败"
        case "blocked": return "执行受阻 · 原因待确认"
        default: break
        }
        if session?.executionTaskStatus == .running { return "执行中" }
        if task.hasPendingScheduledWake == true { return "等待计划唤醒" }
        if session?.executionTaskStatus == .cancelled { return "已停止" }
        return session == nil ? "尚无可用会话" : "当前未执行"
    }

    private func loadPage(_ work: Work, reset: Bool) {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        let generation = UUID()
        browseGeneration = generation
        let nextCursor = reset ? nil : cursor
        Task { @MainActor in
            do {
                var url = URLComponents(url: CorptieAppEnvironment.backendBaseURL.appending(path: "works/\(work.id)/tasks"), resolvingAgainstBaseURL: false)!
                url.queryItems = [URLQueryItem(name: "limit", value: "50"), URLQueryItem(name: "includeCompleted", value: "true")]
                if let nextCursor { url.queryItems?.append(URLQueryItem(name: "cursor", value: nextCursor)) }
                let (data, response) = try await URLSession.shared.data(from: url.url!)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                let page = try JSONDecoder().decode(CorptieTaskListEnvelope.self, from: data)
                guard generation == browseGeneration else { return }
                let known = Set(pageTasks.map(\.id))
                pageTasks = reset ? page.tasks : pageTasks + page.tasks.filter { !known.contains($0.id) }
                cursor = page.nextCursor
                hasMore = page.hasMore == true
            } catch {
                guard generation == browseGeneration else { return }
                loadError = "加载失败，请重试"
            }
            if generation == browseGeneration { isLoading = false }
        }
    }
}

private struct CardSessionKey: Equatable {
    let id: String
    let taskID: String?
    let status: TaskStatus
    let attention: SessionAttention?
    let archived: Bool?
    let received: Int?
    let read: Int?

    init(_ session: TaskSession) {
        id = session.id
        taskID = session.taskId
        status = session.executionTaskStatus
        attention = session.attention
        archived = session.archived
        received = session.lastAgentMessageSequence
        read = session.lastReadMessageSequence
    }
}
