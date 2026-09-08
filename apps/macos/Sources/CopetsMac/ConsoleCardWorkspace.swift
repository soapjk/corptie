import SwiftUI
import Flow

/// No transcript reads or per-card observers. Index on collection changes,
/// derive attention membership without changing the selected conversation.
struct ConsoleCardWorkspace<TaskMenu: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var isActive = true
    let works: [Work]
    let tasks: [CorptieTask]
    let sessions: [TaskSession]
    let selectedTaskID: String?
    let query: String
    @Binding var attentionCount: Int
    let refreshRevision: Int
    let openTask: (CorptieTask, TaskSession?) -> Void
    let clearSelection: () -> Void
    let discuss: (Work) -> Void
    let createTask: (Work) -> Void
    let taskMenu: (CorptieTask) -> TaskMenu
    @State private var members: [String: [String]] = [:]
    @State private var clickHistory = TaskCardClickHistory()
    @State private var canvasPositions: [String: CGPoint] = Self.loadCanvasPositions()
    @State private var frontWorkID: String?
    @State private var canvasDrag = WorkCanvasDragController()
    @State private var canvasFrames: [String: CGRect] = [:]
    private static var canvasKey: String { "console.freeWorkCanvas.positions.v1" }
    private static func loadCanvasPositions() -> [String: CGPoint] {
        guard let data = CorptieAppEnvironment.userDefaults.data(forKey: canvasKey),
              let positions = try? JSONDecoder().decode([String: CGPoint].self, from: data) else { return [:] }
        return positions.filter { $0.value.x.isFinite && $0.value.y.isFinite && $0.value.x >= 0 && $0.value.y >= 0 }
    }
    private func saveCanvasPositions() {
        if let data = try? JSONEncoder().encode(canvasPositions) {
            CorptieAppEnvironment.userDefaults.set(data, forKey: Self.canvasKey)
        }
    }
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
    @State private var deferred: [String: ConsoleAttentionPolicy.Receipt] = Self.loadDeferred()
    private static var deferredKey: String { "console.taskCards.deferred.v1" }

    private static func loadDeferred() -> [String: ConsoleAttentionPolicy.Receipt] {
        guard let data = CorptieAppEnvironment.userDefaults.data(forKey: deferredKey) else { return [:] }
        return (try? JSONDecoder().decode([String: ConsoleAttentionPolicy.Receipt].self, from: data)) ?? [:]
    }

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
                    GeometryReader { viewport in
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if orderedWorks.isEmpty {
                                Text(query.isEmpty ? "暂无需要关注的 Task" : "没有匹配的重点 Task")
                                    .font(.caption).foregroundStyle(.secondary).padding(12)
                            }
                            if let browsing {
                                Text(browsing.name).font(.headline)
                                ForEach(pageTasks.filter { !isDeferred($0) }) { task in card(task) }
                                if let loadError { Text(loadError).foregroundStyle(.red) }
                                if hasMore || loadError != nil {
                                    Button(isLoading ? "加载中…" : "加载更多") { loadPage(browsing, reset: false) }
                                        .disabled(isLoading)
                                }
                                if isLoading { ProgressView().controlSize(.small) }
                            } else {
                                FreeWorkCanvasLayout(
                                    positions: canvasPositions,
                                    viewport: CGSize(width: max(1, viewport.size.width - 20), height: max(1, viewport.size.height - 20)),
                                    frozenFrames: canvasDrag.snapshot
                                ) {
                                    ForEach(orderedWorks) { work in
                                        group(work)
                                            .geometryGroup()
                                            .modifier(WorkCanvasMotionModifier(motion: canvasDrag.motion(for: work.id),
                                                frozenSize: canvasDrag.snapshot[work.id]?.size))
                                            .transition(.opacity)
                                            .anchorPreference(key: WorkCanvasAnchors.self, value: .bounds) { [work.id: $0] }
                                            .zIndex(frontWorkID == work.id ? 1 : 0)
                                            .layoutValue(key: WorkPackingID.self, value: work.id).id(work.id)
                                    }
                                }
                                .coordinateSpace(name: "freeWorkCanvas")
                                .backgroundPreferenceValue(WorkCanvasAnchors.self) { anchors in
                                    GeometryReader { geometry in
                                        Color.clear.preference(key: WorkCanvasOrigins.self,
                                            value: canvasDrag.activeID == nil ? anchors.mapValues { geometry[$0] } : canvasFrames)
                                    }
                                }
                                .onPreferenceChange(WorkCanvasOrigins.self) { frames in
                                    guard canvasDrag.activeID == nil else { return }
                                    if canvasFrames != frames { canvasFrames = frames }
                                    let changed = frames.mapValues(\.origin).filter { canvasPositions[$0.key] != $0.value }
                                    if !changed.isEmpty {
                                        canvasPositions.merge(changed, uniquingKeysWith: { _, new in new })
                                        saveCanvasPositions()
                                    }
                                }
                                .overlayPreferenceValue(TaskCardAnchors.self) { anchors in
                                    TaskCollaborationOverlay(anchors: anchors, active: isActive)
                                }
                            }
                        }.padding(10)
                        .frame(minWidth: viewport.size.width, minHeight: viewport.size.height, alignment: .topLeading)
                    }
                    }
        }
        .onAppear { if isActive { rebuild(reset: false) } }
        .onDisappear { canvasDrag.cancel() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in canvasDrag.cancel() }
        .onChange(of: orderedWorks.map(\.id)) { _, _ in canvasDrag.cancel() }
        .onChange(of: refreshRevision) { _, _ in if isActive { rebuild(reset: true) } }
        .onChange(of: isActive) { _, active in
            if active { rebuild(reset: false) } else { canvasDrag.cancel() }
        }
        .onReceive(AppStateStore.shared.$isReachable.removeDuplicates()) { reachable = $0 }
        .onReceive(AppStateStore.shared.$syncError.removeDuplicates()) { syncError = $0 }
        .onChange(of: tasks) { _, _ in if isActive { rebuild(reset: false) } }
        .onChange(of: sessions.map(CardSessionKey.init)) { _, _ in if isActive { rebuild(reset: false) } }
        .onChange(of: selectedTaskID) { _, _ in if isActive { rebuild(reset: false) } }
        .onChange(of: works) { _, _ in if isActive { rebuild(reset: false) } }
    }

    private var orderedWorks: [Work] {
        let index = Dictionary(uniqueKeysWithValues: works.map { ($0.id, $0) })
        return workOrder.compactMap { index[$0] }.filter { !displayedTasks(for: $0).isEmpty }
    }

    // Animate structural changes, not streaming messages, hover or container width.
    private var packingAnimationKey: [[String]] {
        orderedWorks.map { work in
            [work.id, work.name] + displayedTasks(for: work).flatMap { [$0.id, $0.title] }
        }
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
        var nextDeferred = deferred
        for task in tasks {
            guard let saved = nextDeferred[task.id], let session = bindings[task.id] else { continue }
            if saved != ConsoleAttentionPolicy.receipt(task, session: session) {
                nextDeferred.removeValue(forKey: task.id)
            }
        }
        if nextDeferred != deferred {
            deferred = nextDeferred
            if let data = try? JSONEncoder().encode(nextDeferred) {
                CorptieAppEnvironment.userDefaults.set(data, forKey: Self.deferredKey)
            }
        }
        if reset { members = [:]; retainedTasks = [:]; workOrder = [] }
        let existingWorks = Set(works.map(\.id))
        members = members.filter { existingWorks.contains($0.key) }
        workOrder = workOrder.filter { existingWorks.contains($0) }
        let known = Set(workOrder)
        workOrder.append(contentsOf: works.filter { !known.contains($0.id) }.map(\.id))
        let grouped = Dictionary(grouping: tasks, by: \.workId)
        tasksByWork = grouped
        residentTaskIDs = Set(tasks.map(\.id))
        var nextAttentionCount = 0
        for work in works {
            let candidates = grouped[work.id] ?? []
            for task in candidates { retainedTasks[task.id] = task }
            let wanted = candidates.filter { task in
                let session = bindings[task.id]
                let receipt = ConsoleAttentionPolicy.receipt(task, session: session)
                let input = ConsoleAttentionPolicy.input(task, session: session,
                    selected: task.id == selectedTaskID, deferred: deferred[task.id] == receipt)
                if ConsoleAttentionPolicy.shouldShow(input) {
                    if !input.running && !input.deferred { nextAttentionCount += 1 }
                    return true
                }
                return false
            }
            let wantedIDs = Set(wanted.map(\.id))
            var ids = (members[work.id] ?? []).filter { wantedIDs.contains($0) }
            let old = Set(ids)
            ids.append(contentsOf: wanted.filter { !old.contains($0.id) }.map(\.id))
            members[work.id] = ids
        }
        if attentionCount != nextAttentionCount { attentionCount = nextAttentionCount }
        let retainedIDs = Set(members.values.flatMap { $0 })
        retainedTasks = retainedTasks.filter { retainedIDs.contains($0.key) }
    }

    private func displayedTasks(for work: Work) -> [CorptieTask] {
        (members[work.id] ?? []).compactMap { retainedTasks[$0] }.filter {
            query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || work.name.localizedCaseInsensitiveContains(query)
        }
    }

    private func group(_ work: Work) -> some View {
        return CompactWorkCard(work: work, discuss: { discuss(work) }, createTask: { createTask(work) },
            beginDrag: {
                if canvasDrag.begin(id: work.id, frames: canvasFrames, reducedMotion: reduceMotion) { frontWorkID = work.id }
            },
            updateDrag: { canvasDrag.update(id: work.id, translation: $0) },
            cancelDrag: { canvasDrag.cancel() },
            finishDrag: {
                canvasDrag.finish(id: work.id) { frames in
                    canvasPositions.merge(frames.mapValues(\.origin), uniquingKeysWith: { _, new in new })
                    canvasFrames = frames
                    saveCanvasPositions()
                }
            }) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(displayedTasks(for: work)) { task in
                    ContentSizedTaskCardLayout {
                        card(task)
                    }
                }
            }
            .fixedSize(horizontal: true, vertical: true)
        }
    }

    private func card(_ task: CorptieTask) -> some View {
        let session = sessionByTask[task.id] ?? sessions.first { $0.id == task.currentSessionId }
        let execution = session?.executionTaskStatus ?? task.executionStatus.flatMap(TaskStatus.init(rawValue:))
        let needsAttention = session?.attention != nil || ConsoleAttentionPolicy.currentSummary(task, session: session)?.intervention == "required"
        return Button {
            if let selectedTaskID { clickHistory.visit(selectedTaskID) }
            clickHistory.visit(task.id)
            openTask(task, session)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Circle()
                        .fill(execution == .running ? CorptiePalette.running : execution == .failed ? Color.red :
                            (needsAttention || execution == .blocked) ? Color.orange : Color.secondary.opacity(0.65))
                        .frame(width: 7, height: 7)
                        .help(status(task, session))
                        .accessibilityLabel(status(task, session))
                    Text(task.title).font(.system(size: 13, weight: .semibold)).lineLimit(2).help(task.title)
                    if task.hasPendingScheduledWake == true {
                        Image(systemName: "alarm").foregroundStyle(.orange).help("存在有效的待执行计划任务")
                    }
                    if let session, isSessionUnread(session) { Circle().fill(.red).frame(width: 6, height: 6) }
                }
                interventionSummary(task, session: session)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(10)
            .background(selectedTaskID == task.id ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color.accentColor.opacity(selectedTaskID == task.id ? 0.85 : 0.22), lineWidth: selectedTaskID == task.id ? 1.5 : 1)
                .allowsHitTesting(false))
            .contentShape(Rectangle())
        }.anchorPreference(key: TaskCardAnchors.self, value: .bounds) { [task.id: $0] }
        .buttonStyle(.plain).disabled(task.deletionStatus == "deleting").contextMenu {
            Button("暂不处理") {
                deferred[task.id] = ConsoleAttentionPolicy.receipt(task, session: session)
                if let data = try? JSONEncoder().encode(deferred) {
                    CorptieAppEnvironment.userDefaults.set(data, forKey: Self.deferredKey)
                }
                if selectedTaskID == task.id { returnAfterDeferring(task.id) }
                rebuild(reset: false)
            }
            .disabled(ConsoleAttentionPolicy.input(task, session: session, selected: false, deferred: false).running)
            .help("立即从本机重点面板移出；若正在浏览，返回上次点击的可用卡片。新回复或新事项出现后重新显示。")
            Divider()
            taskMenu(task)
        }
    }

    private func isDeferred(_ task: CorptieTask) -> Bool {
        guard let receipt = deferred[task.id] else { return false }
        let session = sessionByTask[task.id] ?? sessions.first { $0.id == task.currentSessionId }
        return receipt == ConsoleAttentionPolicy.receipt(task, session: session)
    }

    private func returnAfterDeferring(_ id: String) {
        let workIDs = Set(works.map(\.id))
        let candidates = Dictionary((tasks + pageTasks).filter { task in
            task.id != id && task.archived != true && task.deletionStatus == nil
                && workIDs.contains(task.workId) && !isDeferred(task)
                && (query.isEmpty || task.title.localizedCaseInsensitiveContains(query)
                    || works.first(where: { $0.id == task.workId })?.name.localizedCaseInsensitiveContains(query) == true)
        }.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard let previous = clickHistory.dismiss(id, eligible: Set(candidates.keys)),
              let task = candidates[previous] else { clearSelection(); return }
        let session = sessionByTask[task.id] ?? sessions.first { $0.id == task.currentSessionId }
        openTask(task, session)
    }

    @ViewBuilder
    private func interventionSummary(_ task: CorptieTask, session: TaskSession?) -> some View {
        let summary = ConsoleAttentionPolicy.currentSummary(task, session: session)
        let decision = ConsoleAttentionPolicy.attentionDecision(task, session: session)
        let systemAction = ConsoleAttentionPolicy.requiresSystemAction(session)
        if decision == .required || systemAction {
            let current = summary?.intervention == "required"
            let reason = systemAction ? (session?.attention?.reason ?? "等待选择或授权") :
                current ? (summary?.reason ?? "") :
                (task.userSummary?.content?.retainedAttention?.reason ?? task.userSummary?.content?.reason ?? "")
            let text = TaskCardSituationText.compact(reason, historical: !current && !systemAction)
            Text(text).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(4)
                .help(reason)
        }
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
        let execution = session?.executionTaskStatus ?? task.executionStatus.flatMap(TaskStatus.init(rawValue:))
        if execution == .running { return "执行中" }
        if execution == .failed { return "执行失败" }
        if execution == .blocked { return "执行受阻" }
        if ConsoleAttentionPolicy.currentSummary(task, session: session)?.intervention == "required" { return "需要介入" }
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

/// Keep hover state within one Work card, not the workspace projection.
private struct CompactWorkCard<Content: View>: View {
    let work: Work
    let discuss: () -> Void
    let createTask: () -> Void
    let beginDrag: () -> Void
    let updateDrag: (CGSize) -> Void
    let cancelDrag: () -> Void
    let finishDrag: () -> Void
    @ViewBuilder let content: Content
    @State private var dragging = false
    @GestureState private var gestureActive = false
    @State private var isHovering = false
    @FocusState private var isCreateTaskFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                HStack(spacing: 6) {
                    ObjectiveAvatarView(objectiveID: work.id, name: work.name, avatarPath: work.avatarPath, size: 14)
                    Text(work.name).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary).lineLimit(2)
                }
                Button("讨论", action: discuss)
                    .font(.system(size: 10))
                    .controlSize(.mini)
                    .fixedSize()
                    .help("打开 Work 讨论")
                Button(action: createTask) {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                        .frame(width: 20, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .focused($isCreateTaskFocused)
                .opacity(isHovering || isCreateTaskFocused ? 1 : 0)
                .accessibilityLabel(L10nFormat("Create Task in %@", work.name))
                .help(L10nFormat("Create Task in %@", work.name))
            }
            content
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(CorptiePalette.workCardSurface, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.accentColor.opacity(0.30), lineWidth: 1)
                .allowsHitTesting(false)
        }
        .onHover { isHovering = $0 }
        .contentShape(Rectangle())
        // Apply to the whole card, including Task buttons. The nonzero distance
        // leaves ordinary clicks intact; a recognized drag takes precedence.
        .highPriorityGesture(DragGesture(minimumDistance: 4, coordinateSpace: .named("freeWorkCanvas"))
            .updating($gestureActive) { _, active, _ in active = true }
            .onChanged { value in
                if !dragging { dragging = true; beginDrag() }
                updateDrag(value.translation)
            }
            .onEnded { value in
                updateDrag(value.translation)
                finishDrag()
                dragging = false
            }, including: .all)
        .onChange(of: gestureActive) { _, active in
            if !active && dragging { dragging = false; cancelDrag() }
        }
        .onDisappear { dragging = false }
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
    let timelineRevision: Int?

    init(_ session: TaskSession) {
        id = session.id
        taskID = session.taskId
        status = session.executionTaskStatus
        attention = session.attention
        archived = session.archived
        received = session.lastAgentMessageSequence
        read = session.lastReadMessageSequence
        timelineRevision = session.timelineRevision
    }
}
