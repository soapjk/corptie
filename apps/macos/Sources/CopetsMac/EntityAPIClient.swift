import Combine
import Foundation

private struct CorptieTaskCreateResponse: Decodable {
    let task: CorptieTask
    let session: TaskSession

    private enum CodingKeys: String, CodingKey { case session }

    init(from decoder: Decoder) throws {
        task = try CorptieTask(from: decoder)
        session = try decoder.container(keyedBy: CodingKeys.self)
            .decode(TaskSession.self, forKey: .session)
    }
}

struct EntityRefreshGeneration: Equatable {
    private(set) var current = 0

    mutating func begin() -> Int {
        current &+= 1
        return current
    }

    func isCurrent(_ generation: Int) -> Bool {
        generation == current
    }
}

private struct SessionGroupingEntityState: Equatable {
    let tasks: [String: CorptieTask]
    let works: [String: Work]
    let agents: [String: Agent]
}

// 实体层轻量 API 客户端（15 Phase 5 净新增）。
// 独立于 BackendClient.swift 巨石，直连后端 entityHttpApi（/works、/tasks）。
// 与 BackendClient 使用相同后端地址（CorptieAppEnvironment.backendBaseURL）与 URLSession 模式。

@MainActor
final class EntityAPIClient: ObservableObject {
    static let shared = EntityAPIClient()

    private let appState: AppStateStore
    var works: [Work] { appState.works }
    var agents: [Agent] { appState.agents }
    var tasks: [CorptieTask] { appState.tasks }
    @Published private(set) var tasksRevision: UInt64 = 0
    let sessionGroupingDidChange = PassthroughSubject<Void, Never>()
    @Published private(set) var tasksLoadError: String?
    @Published private(set) var browsedTasksHasMore = false
    @Published private(set) var browsedMemoriesHasMore = false
    @Published private(set) var worksLoadError: String?
    @Published private(set) var workspaces: [WorkspaceResource] = []

    /// 仅 Assistant 类 Agent（用于「新建会话」等自由对话入口）。
    var assistantAgents: [Agent] { agents.filter { $0.isAssistant } }
    var repositories: [GitRepository] { appState.repositories }
    var skills: [Skill] { appState.skills }
    @Published var isLoading = false
    @Published var errorMessage: String?
    private let skillDeletionHTTPClient = SkillDeletionHTTPClient()

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    private var worksRefreshGeneration = EntityRefreshGeneration()
    private var appStateCancellables = Set<AnyCancellable>()
    private var browsedTasksNextCursor: String?
    private var browsedTasksWorkId: String?
    private var browsedTasks: [CorptieTask] = []
    private var browsedMemories: [MemoryItem] = []
    private var browsedMemoryQueryItems: [URLQueryItem] = []
    private var browsedMemoryNextCursor: String?

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    init(appState: AppStateStore = .shared) {
        self.appState = appState

        appState.$state
            .map(\.tasks)
            .removeDuplicates()
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.tasksRevision &+= 1
            }
            .store(in: &appStateCancellables)

        appState.$state
            .map { state in
                SessionGroupingEntityState(
                    tasks: state.tasks,
                    works: state.works,
                    agents: state.agents
                )
            }
            .removeDuplicates()
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.sessionGroupingDidChange.send()
            }
            .store(in: &appStateCancellables)
    }

    func refreshWorks() async {
        let generation = worksRefreshGeneration.begin()
        isLoading = true
        defer {
            if worksRefreshGeneration.isCurrent(generation) {
                isLoading = false
            }
        }
        do {
            await AppStateSyncController.shared.refreshSnapshot()
            guard worksRefreshGeneration.isCurrent(generation) else { return }
            if let syncError = appState.syncError { throw EntityLaunchError(message: syncError, code: "STATE_SYNC_FAILED") }
            worksLoadError = nil
            errorMessage = nil
        } catch {
            guard worksRefreshGeneration.isCurrent(generation) else { return }
            worksLoadError = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    /// Entity requests made while the production launch agent is still starting
    /// are retried when the canonical backend Session stream becomes available.
    /// This keeps the first Work view in sync without requiring a Tab switch.
    func refreshAfterBackendConnected() async {
        await refreshWorks()
        await refreshWorkspaces()
        await refreshRepositories()
        await refreshAgents()
    }

    func refreshAgents() async {
        await AppStateSyncController.shared.refreshSnapshot()
        errorMessage = appState.syncError
    }

    func refreshRepositories() async {
        await AppStateSyncController.shared.refreshSnapshot()
        errorMessage = appState.syncError
    }

    func refreshWorkspaces() async {
        var request = URLRequest(url: baseURL.appending(path: "workspaces"))
        request.httpMethod = "GET"
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                throw EntityLaunchError(message: "加载 Workspace 失败（HTTP \(http.statusCode)）", code: nil)
            }
            workspaces = try decoder.decode(WorkspaceListEnvelope.self, from: data).workspaces
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // 拉取全局 Skill 维护中心列表：GET /skills → { skills }
    func refreshSkills() async {
        await AppStateSyncController.shared.refreshSnapshot()
        errorMessage = appState.syncError
    }

    func tasks(for work: Work) async -> [CorptieTask]? {
        await loadBrowsedTasks(workId: work.id, reset: true)
    }

    func allCorptieTasks() async -> [CorptieTask]? {
        await loadBrowsedTasks(workId: nil, reset: true)
    }

    func loadMoreBrowsedTasks() async -> [CorptieTask]? {
        guard browsedTasksHasMore, browsedTasksNextCursor != nil else { return browsedTasks }
        return await loadBrowsedTasks(workId: browsedTasksWorkId, reset: false)
    }

    func clearCorptieTasksLoadError() {
        tasksLoadError = nil
    }

    private func loadCorptieTasks(from url: URL) async -> [CorptieTask]? {
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(
                    message: envelope?.error ?? "加载 CorptieTask 失败（HTTP \(http.statusCode)）",
                    code: envelope?.code
                )
            }
            let tasks = try decoder.decode(CorptieTaskListEnvelope.self, from: data).tasks
            tasksLoadError = nil
            errorMessage = nil
            return tasks
        } catch {
            let message = Self.tasksLoadErrorMessage(error)
            tasksLoadError = message
            errorMessage = message
            return nil
        }
    }

    private func loadBrowsedTasks(workId: String?, reset: Bool) async -> [CorptieTask]? {
        do {
            let endpoint = workId.map { baseURL.appending(path: "works/\($0)/tasks") }
                ?? baseURL.appending(path: "tasks")
            var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
            var queryItems = [
                URLQueryItem(name: "limit", value: "50"),
                URLQueryItem(name: "includeCompleted", value: "true")
            ]
            if !reset, let browsedTasksNextCursor {
                queryItems.append(URLQueryItem(name: "cursor", value: browsedTasksNextCursor))
            }
            components.queryItems = queryItems
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(
                    message: envelope?.error ?? "加载 CorptieTask 失败（HTTP \(http.statusCode)）",
                    code: envelope?.code
                )
            }
            let page = try decoder.decode(CorptieTaskListEnvelope.self, from: data)
            if reset || browsedTasksWorkId != workId {
                browsedTasks = page.tasks
            } else {
                var knownIDs = Set(browsedTasks.map(\.id))
                browsedTasks.append(contentsOf: page.tasks.filter { knownIDs.insert($0.id).inserted })
            }
            browsedTasksWorkId = workId
            browsedTasksHasMore = page.hasMore == true
            browsedTasksNextCursor = page.nextCursor
            tasksLoadError = nil
            errorMessage = nil
            return browsedTasks
        } catch {
            let message = Self.tasksLoadErrorMessage(error)
            tasksLoadError = message
            errorMessage = message
            return nil
        }
    }

    static func tasksLoadErrorMessage(_ error: Error) -> String {
        let detail: String
        if let launchError = error as? EntityLaunchError {
            detail = launchError.message
        } else if case let DecodingError.keyNotFound(key, context) = error {
            let path = (context.codingPath + [key]).map(\.stringValue).joined(separator: ".")
            detail = "响应缺少字段 \(path)。"
        } else if case let DecodingError.typeMismatch(_, context) = error {
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            detail = "响应字段 \(path.isEmpty ? "<root>" : path) 的类型不兼容。"
        } else if case let DecodingError.valueNotFound(_, context) = error {
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            detail = "响应字段 \(path.isEmpty ? "<root>" : path) 缺少值。"
        } else if case let DecodingError.dataCorrupted(context) = error {
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            detail = "响应数据损坏（\(path.isEmpty ? "<root>" : path)）。"
        } else {
            detail = error.localizedDescription
        }
        return "CorptieTask 加载失败；未用空列表覆盖现有内容。此错误不代表数据已删除。\(detail)"
    }

    func task(id: String) async -> CorptieTask? {
        do {
            let url = baseURL.appending(path: "tasks/\(id)")
            let (data, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                errorMessage = "加载 CorptieTask 失败（HTTP \(http.statusCode)）"
                return nil
            }
            let task = try decoder.decode(CorptieTask.self, from: data)
            errorMessage = nil
            return task
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // 更新 CorptieTask：PATCH /tasks/:id → task（直接返回对象，非 envelope）
    @discardableResult
    func updateCorptieTask(taskId: String, title: String? = nil, description: String? = nil,
                        goal: String? = nil,
                        acceptanceCriteria: String? = nil,
                        verificationCriteria: String? = nil,
                        priority: String? = nil, lifecycleState: String? = nil,
                        mainAgentId: String? = nil) async -> CorptieTask? {
        var request = URLRequest(url: baseURL.appending(path: "tasks/\(taskId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let title { body["title"] = title }
        if let description { body["description"] = description }
        if let goal { body["goal"] = goal }
        if let acceptanceCriteria { body["acceptanceCriteria"] = acceptanceCriteria }
        if let verificationCriteria { body["verificationCriteria"] = verificationCriteria }
        if let priority { body["priority"] = priority }
        if let lifecycleState { body["lifecycleState"] = lifecycleState }
        if let mainAgentId { body["mainAgentId"] = mainAgentId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return await performEntityMutation(request, as: CorptieTask.self)
    }

    func inspectCorptieTaskDeletion(taskId: String) async -> CorptieTaskDeletionPlan? {
        let url = baseURL.appending(path: "tasks/\(taskId)/deletion")
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(message: envelope?.displayMessage ?? L10n("Unable to inspect CorptieTask deletion."), code: envelope?.code)
            }
            let plan = try decoder.decode(CorptieTaskDeletionPlan.self, from: data)
            errorMessage = nil
            return plan
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return nil
        }
    }

    func deleteCorptieTask(
        taskId: String,
        force: Bool = false,
        confirmedBranchName: String? = nil,
        deleteWorktree: Bool = true,
        artifactDisposition: CorptieTaskArtifactDisposition = .delete
    ) async -> Bool {
        var request = URLRequest(url: baseURL.appending(path: "tasks/\(taskId)/actions/delete"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "mode": force ? "force" : "safe",
            "deleteWorktree": deleteWorktree,
            "artifactDisposition": artifactDisposition.rawValue
        ]
        if force {
            body["acknowledgeDataLoss"] = true
            body["confirmedBranchName"] = confirmedBranchName ?? ""
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(message: envelope?.displayMessage ?? L10n("Unable to delete CorptieTask."), code: envelope?.code)
            }
            let result = try decoder.decode(CorptieTaskDeletionResult.self, from: data)
            guard result.ok else { throw EntityLaunchError(message: L10n("CorptieTask deletion did not complete."), code: "DELETE_INCOMPLETE") }
            await AppStateSyncController.shared.refreshSnapshot()
            if let syncError = appState.syncError { throw EntityLaunchError(message: syncError, code: "STATE_SYNC_FAILED") }
            errorMessage = nil
            return true
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return false
        }
    }

    func issueCorptieTaskCompletionIntent(
        task: CorptieTask,
        interactionId: String,
        requestId: String,
        uiSurface: String
    ) async -> CorptieTaskCompletionIntentReceipt? {
        var request = URLRequest(
            url: baseURL.appending(path: "tasks/\(task.id)/completion-intents")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let acceptanceStatus = task.acceptanceAssessment?.status ?? "not_assessed"
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "requestId": requestId,
            "interactionId": interactionId,
            "uiSurface": uiSurface,
            "displayedTaskId": task.id,
            "displayedTaskTitle": task.title,
            "displayedAcceptanceStatus": acceptanceStatus
        ])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(message: envelope?.displayMessage ?? L10n("Unable to authorize CorptieTask completion"), code: envelope?.code)
            }
            let receipt = try decoder.decode(CorptieTaskCompletionIntentReceipt.self, from: data)
            guard receipt.taskId == task.id, receipt.workId == task.workId,
                  receipt.interactionId == interactionId else {
                throw EntityLaunchError(message: L10n("Completion authorization target mismatch"), code: "COMPLETION_INTENT_TARGET_MISMATCH")
            }
            errorMessage = nil
            return receipt
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return nil
        }
    }

    // Consumes the exact immutable receipt captured at the user's click. Retry
    // uses the same request/idempotency keys and never reads current selection.
    @discardableResult
    func confirmCorptieTaskCompletion(submission: CorptieTaskCompletionSubmission) async -> CorptieTask? {
        let taskId = submission.taskId
        let receipt = submission.receipt
        var request = URLRequest(
            url: baseURL.appending(path: "tasks/\(taskId)/confirm-completion")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "intentToken": receipt.intentToken,
            "requestId": submission.requestId,
            "idempotencyKey": submission.idempotencyKey
        ])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(message: envelope?.displayMessage ?? L10n("Unable to confirm CorptieTask completion"), code: envelope?.code)
            }
            let result = try decoder.decode(CorptieTaskCompletionEnvelope.self, from: data)
            guard result.task.id == taskId else {
                throw EntityLaunchError(message: L10n("Completion response target mismatch"), code: "COMPLETION_RESPONSE_TARGET_MISMATCH")
            }
            appState.acceptCorptieTask(result.task)
            await AppStateSyncController.shared.refreshSnapshot()
            errorMessage = nil
            return result.task
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return nil
        }
    }

    func restoreCorptieTaskExecution(taskId: String) async -> EntityCorptieTaskRestoreResult {
        var request = URLRequest(
            url: baseURL.appending(path: "tasks/\(taskId)/actions/restore")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                let message = envelope?.error ?? L10n("Unable to restore CorptieTask execution")
                errorMessage = message
                return .failure(message: message, code: envelope?.code)
            }
            let restored = try decoder.decode(CorptieTaskRestoreEnvelope.self, from: data).task
            errorMessage = nil
            return .success(restored)
        } catch {
            let message = error.localizedDescription
            errorMessage = message
            return .failure(message: message)
        }
    }

    func worktreeStatus(taskId: String) async -> CorptieTaskWorktreeStatus? {
        do {
            let url = baseURL.appending(path: "tasks/\(taskId)/worktree")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(
                    message: envelope?.error ?? L10n("Unable to inspect the Worktree."),
                    code: envelope?.code
                )
            }
            let status = try decoder.decode(CorptieTaskWorktreeStatus.self, from: data)
            errorMessage = nil
            return status
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return nil
        }
    }

    func reclaimWorktree(taskId: String) async -> CorptieTaskWorktreeStatus? {
        var request = URLRequest(
            url: baseURL.appending(path: "tasks/\(taskId)/worktree/reclaim")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(
                    message: envelope?.error ?? L10n("Unable to reclaim the Worktree."),
                    code: envelope?.code
                )
            }
            let status = try decoder.decode(CorptieTaskWorktreeStatus.self, from: data)
            errorMessage = nil
            return status
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return nil
        }
    }

    // 用户明确驳回已通过的自动验收结论，保留评估证据但撤销“可完成”建议。
    @discardableResult
    func rejectCorptieTaskAcceptance(taskId: String) async -> CorptieTask? {
        var request = URLRequest(
            url: baseURL.appending(path: "tasks/\(taskId)/reject-acceptance")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["rejected": true])
        return await performEntityMutation(request, as: CorptieTask.self)
    }

    // 提交独立的验收评估。该接口要求逐条标准、结论和可核验证据；
    // Session 生命周期状态不能通过此方法隐式转换为验收通过。
    @discardableResult
    func submitAcceptanceAssessment(
        taskId: String,
        sourceSessionId: String,
        results: [CorptieTaskAcceptanceResult]
    ) async -> CorptieTask? {
        var request = URLRequest(
            url: baseURL.appending(path: "tasks/\(taskId)/acceptance-assessment")
        )
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let encoder = JSONEncoder()
        request.httpBody = try? encoder.encode(AcceptanceAssessmentRequest(
            sourceSessionId: sourceSessionId,
            results: results
        ))
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(
                    message: envelope?.error ?? "提交验收评估失败（HTTP \(http.statusCode)）",
                    code: envelope?.code
                )
            }
            let task = try decoder.decode(CorptieTask.self, from: data)
            errorMessage = nil
            return task
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return nil
        }
    }

    // 创建 CorptieTask 及其伴生 Work Session：统一 POST /tasks，一次返回两者。
    @discardableResult
    func createCorptieTask(id: String? = nil, workId: String, title: String, description: String? = nil,
                        goal: String? = nil,
                        acceptanceCriteria: String? = nil,
                        verificationCriteria: String? = nil,
                        mainAgentId: String? = nil,
                        priority: String? = nil,
                        providerId: String) async -> CorptieTask? {
        guard let sourceSession = BackendClient.shared.selectedSession else {
            errorMessage = L10n("创建 CorptieTask 需要一个已激活的源会话。")
            return nil
        }
        let sourceSessionId = sourceSession.external?.logicalSessionId ?? sourceSession.id
        var request = URLRequest(url: baseURL.appending(path: "tasks"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sourceSessionId, forHTTPHeaderField: "X-Corptie-Logical-Session-Id")
        if let id, !id.isEmpty {
            request.setValue(id, forHTTPHeaderField: "X-Corptie-Operation-Id")
        }
        let operationId = id?.isEmpty == false ? id! : "task-create:\(UUID().uuidString.lowercased())"
        var body: [String: Any] = [
            "workId": workId,
            "title": title,
            "providerId": providerId,
            "sourceSessionId": sourceSessionId,
            "idempotencyKey": operationId
        ]
        if let id, !id.isEmpty { body["id"] = id }
        if let description, !description.isEmpty { body["description"] = description }
        if let goal, !goal.isEmpty { body["goal"] = goal }
        if let acceptanceCriteria, !acceptanceCriteria.isEmpty { body["acceptanceCriteria"] = acceptanceCriteria }
        if let verificationCriteria, !verificationCriteria.isEmpty { body["verificationCriteria"] = verificationCriteria }
        if let mainAgentId, !mainAgentId.isEmpty { body["mainAgentId"] = mainAgentId }
        if let priority { body["priority"] = priority }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let created = await performEntityMutation(request, as: CorptieTaskCreateResponse.self) else {
            return nil
        }
        BackendClient.shared.acceptCreatedSession(created.session, selectImmediately: false)
        return created.task
    }

    func taskSnapshots(taskId: String) async -> [CorptieTaskSnapshot] {
        do {
            let url = baseURL.appending(path: "tasks/\(taskId)/snapshots")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw EntityLaunchError(message: L10n("Unable to load Task history."), code: "TASK_SNAPSHOTS_LOAD_FAILED")
            }
            let envelope = try decoder.decode(CorptieTaskSnapshotListEnvelope.self, from: data)
            errorMessage = nil
            return envelope.snapshots
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return []
        }
    }

    @discardableResult
    func reviseCorptieTask(
        task: CorptieTask,
        createdBySessionId: String,
        title: String,
        description: String,
        goal: String,
        acceptanceCriteria: String,
        verificationCriteria: String,
        executionSummary: String,
        sourceMessageId: String? = nil
    ) async -> CorptieTaskRevisionEnvelope? {
        var request = URLRequest(url: baseURL.appending(path: "tasks/\(task.id)/revisions"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "expectedRevision": task.revision,
            "createdBySessionId": createdBySessionId,
            "executionSummary": executionSummary,
            "next": [
                "title": title,
                "description": description,
                "goal": goal,
                "acceptanceCriteria": acceptanceCriteria,
                "verificationCriteria": verificationCriteria
            ]
        ]
        if let sourceMessageId { body["sourceMessageId"] = sourceMessageId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return await performEntityMutation(request, as: CorptieTaskRevisionEnvelope.self)
    }

    // CorptieTask execution history is a selector over the unified AppStateStore.
    // There is no view-local HTTP cache to drift from the session list.
    func sessions(for task: CorptieTask) async -> [CorptieTaskSessionSummary] {
        appState.sessions
            .filter { $0.taskId == task.id }
            .sorted { $0.updatedAt > $1.updatedAt }
            .map {
                CorptieTaskSessionSummary(
                    id: $0.id,
                    title: $0.title,
                    status: $0.status.rawValue,
                    updatedAt: $0.updatedAt
                )
            }
    }

    // 删除会话：DELETE /sessions/:id → { ok }
    func deleteSession(sessionId: String) async -> Bool {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(sessionId)"))
        request.httpMethod = "DELETE"
        do {
            _ = try await URLSession.shared.data(for: request)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // 终止会话（打断正在运行的 turn）：POST /sessions/:id/interrupt → { session }
    func interruptSession(sessionId: String) async -> Bool {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(sessionId)/interrupt"))
        request.httpMethod = "POST"
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.error ?? "终止失败（HTTP \(http.statusCode)）"
                return false
            }
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // 恢复已存在的会话（继续执行，而非新建）：POST /sessions/:id/actions/resume → { session }
    func resumeSession(sessionId: String) async -> Bool {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(sessionId)/actions/resume"))
        request.httpMethod = "POST"
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.error ?? "恢复会话失败（HTTP \(http.statusCode)）"
                return false
            }
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // 查某 owner（如 task）的记忆：GET /memories?ownerType=&ownerId= → { memories }
    func memories(ownerType: String, ownerId: String, includeRevoked: Bool = false) async -> [MemoryItem]? {
        var components = URLComponents(url: baseURL.appending(path: "memories"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "ownerType", value: ownerType),
            URLQueryItem(name: "ownerId", value: ownerId),
            URLQueryItem(name: "includeRevoked", value: includeRevoked ? "true" : "false"),
            URLQueryItem(name: "limit", value: "50")
        ]
        guard let url = components?.url else { return nil }
        return await loadMemories(url: url, reset: true)
    }

    func allMemories(includeRevoked: Bool = true) async -> [MemoryItem]? {
        var components = URLComponents(url: baseURL.appending(path: "memories"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "global", value: "true"),
            URLQueryItem(name: "includeRevoked", value: includeRevoked ? "true" : "false"),
            URLQueryItem(name: "limit", value: "50")
        ]
        guard let url = components?.url else { return nil }
        return await loadMemories(url: url, reset: true)
    }

    func loadMoreMemories() async -> [MemoryItem]? {
        guard browsedMemoriesHasMore, let browsedMemoryNextCursor else { return browsedMemories }
        var components = URLComponents(url: baseURL.appending(path: "memories"), resolvingAgainstBaseURL: false)!
        components.queryItems = browsedMemoryQueryItems
            + [URLQueryItem(name: "cursor", value: browsedMemoryNextCursor)]
        return await loadMemories(url: components.url!, reset: false)
    }

    func updateMemory(memoryId: String, tags: [String]) async -> MemoryItem? {
        var request = URLRequest(url: baseURL.appending(path: "memories/\(memoryId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["tags": tags])
        return await mutateMemory(request)
    }

    func createMemory(
        ownerType: String,
        ownerId: String,
        kind: String,
        content: String,
        tags: [String],
        sourceSessionId: String? = nil
    ) async -> MemoryItem? {
        var request = URLRequest(url: baseURL.appending(path: "memories"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "ownerType": ownerType,
            "ownerId": ownerId,
            "kind": kind,
            "content": content,
            "tags": tags
        ]
        if let sourceSessionId { body["sourceSessionId"] = sourceSessionId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            try validateMemoryResponse(response, data: data)
            errorMessage = nil
            return try decoder.decode(MemoryItem.self, from: data)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func revokeMemory(memoryId: String, reason: String) async -> MemoryItem? {
        var request = URLRequest(url: baseURL.appending(path: "memories/\(memoryId)/revoke"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["reason": reason])
        return await mutateMemory(request)
    }

    func restoreMemory(memoryId: String, reason: String) async -> MemoryItem? {
        var request = URLRequest(url: baseURL.appending(path: "memories/\(memoryId)/restore"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["reason": reason])
        return await mutateMemory(request)
    }

    func memoryRecalls(sessionId: String) async -> [MemoryRecallAudit]? {
        var components = URLComponents(url: baseURL.appending(path: "memory-recall-audit"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "sessionId", value: sessionId)]
        guard let url = components?.url else { return nil }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            try validateMemoryResponse(response, data: data)
            return try decoder.decode(MemoryRecallListEnvelope.self, from: data).recalls
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func memoryAudit(memoryId: String) async -> [MemoryAuditEntry]? {
        var components = URLComponents(url: baseURL.appending(path: "memory-audit"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "memoryId", value: memoryId)]
        guard let url = components?.url else { return nil }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            try validateMemoryResponse(response, data: data)
            return try decoder.decode(MemoryAuditListEnvelope.self, from: data).audit
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func rollbackMemoryAudit(auditId: String) async -> MemoryItem? {
        var request = URLRequest(url: baseURL.appending(path: "memory-audit/\(auditId)/rollback"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        return await mutateMemory(request)
    }

    private func loadMemories(url: URL, reset: Bool) async -> [MemoryItem]? {
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            try validateMemoryResponse(response, data: data)
            let page = try decoder.decode(MemoryListEnvelope.self, from: data)
            if reset {
                browsedMemories = page.memories
                browsedMemoryQueryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
                    .filter { $0.name != "cursor" } ?? []
            } else {
                var knownIDs = Set(browsedMemories.map(\.id))
                browsedMemories.append(contentsOf: page.memories.filter { knownIDs.insert($0.id).inserted })
            }
            browsedMemoriesHasMore = page.hasMore == true
            browsedMemoryNextCursor = page.nextCursor
            errorMessage = nil
            return browsedMemories
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func mutateMemory(_ request: URLRequest) async -> MemoryItem? {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            try validateMemoryResponse(response, data: data)
            errorMessage = nil
            return try decoder.decode(MemoryEnvelope.self, from: data).memory
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func validateMemoryResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode >= 400 else { return }
        let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
        throw EntityLaunchError(message: envelope?.error ?? "Memory request failed (HTTP \(http.statusCode)).", code: envelope?.code)
    }

    // 创建 Worker Session：必须同时绑定 CorptieTask 与 Independent Contributor。
    @discardableResult
    func createSession(
        taskId: String,
        agentId: String,
        providerId: String,
        title: String? = nil,
        sourceSession explicitSourceSession: TaskSession? = nil
    ) async -> EntitySessionLaunchResult {
        guard let sourceSession = explicitSourceSession ?? BackendClient.shared.selectedSession else {
            let message = L10n("启动 CorptieTask 需要一个已激活的源会话。请先打开所属 Work 的会话后重试。")
            errorMessage = message
            return .failure(message: message, code: "SOURCE_SESSION_NOT_FOUND")
        }
        let sourceSessionId = sourceSession.external?.logicalSessionId ?? sourceSession.id
        guard let task = await task(id: taskId) else {
            let message = errorMessage ?? L10n("CorptieTask 不存在或无法读取最新版本。")
            errorMessage = message
            return .failure(message: message, code: "TASK_NOT_FOUND")
        }
        var request = URLRequest(url: baseURL.appending(path: "tasks/\(taskId)/start"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sourceSessionId, forHTTPHeaderField: "X-Corptie-Logical-Session-Id")
        let idempotencyKey = "task-start:\(taskId):\(agentId):\(providerId)"
        let command = WorkSessionStartRequest(
            taskId: taskId,
            assigneeAgentId: agentId,
            expectedTaskVersion: task.resourceVersion,
            providerId: providerId,
            title: title,
            idempotencyKey: idempotencyKey,
            sourceSessionId: sourceSessionId
        )
        do {
            request.httpBody = try JSONEncoder().encode(command)
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                let message = envelope?.error ?? "执行失败（HTTP \(http.statusCode)）"
                errorMessage = message
                return .failure(message: message, code: envelope?.code)
            }
            let created = try decoder.decode(WorkSessionCreateEnvelope.self, from: data)
            let startup = created.start
            guard startup.receipt.taskId == taskId,
                  created.session.taskId == startup.receipt.taskId,
                  created.session.workId == startup.receipt.workId,
                  created.session.sessionKind == .worker,
                  (startup.receipt.logicalSessionId.hasPrefix("session:")
                    || startup.receipt.logicalSessionId.hasPrefix("logical:")) else {
                throw EntityLaunchError(
                    message: L10n("Work Session startup receipt is missing or mismatched"),
                    code: "START_RECEIPT_MISMATCH"
                )
            }
            let session = created.session
            errorMessage = nil
            return .success(session)
        } catch {
            let message = error.localizedDescription
            errorMessage = message
            return .failure(message: message)
        }
    }

    // Assistant Chat Session：仅凭 Assistant 开聊，不绑定 CorptieTask。
    @discardableResult
    func startAgentSession(
        agentId: String,
        providerId: String,
        title: String? = nil,
        prompt: String? = nil
    ) async -> EntitySessionLaunchResult {
        var request = URLRequest(url: baseURL.appending(path: "agents/\(agentId)/sessions"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["providerId": providerId]
        if let title, !title.isEmpty { body["title"] = title }
        if let prompt, !prompt.isEmpty { body["prompt"] = prompt }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                let message = envelope?.error ?? "启动对话失败（HTTP \(http.statusCode)）"
                errorMessage = message
                return .failure(message: message, code: envelope?.code)
            }
            let created = try decoder.decode(SessionCreateEnvelope.self, from: data)
            errorMessage = nil
            return .success(created.session)
        } catch {
            let message = error.localizedDescription
            errorMessage = message
            return .failure(message: message)
        }
    }

    @discardableResult
    func startWorkChat(
        workId: String,
        agentId: String,
        providerId: String,
        title: String? = nil,
        prompt: String? = nil
    ) async -> EntitySessionLaunchResult {
        var request = URLRequest(url: baseURL.appending(path: "works/\(workId)/sessions"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["agentId": agentId, "providerId": providerId]
        if let title, !title.isEmpty { body["title"] = title }
        if let prompt, !prompt.isEmpty { body["prompt"] = prompt }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                let message = envelope?.error ?? "启动 Work Chat 失败（HTTP \(http.statusCode)）"
                errorMessage = message
                return .failure(message: message, code: envelope?.code)
            }
            let session = try decoder.decode(SessionCreateEnvelope.self, from: data).session
            errorMessage = nil
            return .success(session)
        } catch {
            errorMessage = error.localizedDescription
            return .failure(message: error.localizedDescription)
        }
    }

    // 更新 Work：PATCH /works/:id → work（直接返回对象）
    @discardableResult
    func updateWork(workId: String, name: String? = nil, description: String? = nil,
                         profile: String? = nil, tags: [String]? = nil,
                         contributorAgentIds: [String]? = nil) async -> Work? {
        var request = URLRequest(url: baseURL.appending(path: "works/\(workId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let description { body["description"] = description }
        if let profile { body["profile"] = profile }
        if let tags { body["tags"] = tags }
        if let contributorAgentIds { body["contributorAgentIds"] = contributorAgentIds }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        if let work = await performEntityMutation(request, as: Work.self) {
            await refreshWorks()
            return work
        }
        return nil
    }

    // 删除 Work：DELETE /works/:id → { ok }
    func deleteWork(workId: String) async -> Bool {
        var request = URLRequest(url: baseURL.appending(path: "works/\(workId)"))
        request.httpMethod = "DELETE"
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.displayMessage ?? L10n("Unable to delete Work.")
                return false
            }
            errorMessage = nil
            await refreshWorks()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // Agent 辅助填写：POST /assist/draft { fieldLabel, prompt, cwd?, agentId? } → { text, providerId }
    func assistDraft(fieldLabel: String, prompt: String, cwd: String? = nil, agentId: String? = nil) async -> String? {
        var request = URLRequest(url: baseURL.appending(path: "assist/draft"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["fieldLabel": fieldLabel, "prompt": prompt]
        if let cwd, !cwd.isEmpty { body["cwd"] = cwd }
        if let agentId, !agentId.isEmpty { body["agentId"] = agentId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.error ?? "辅助填写失败（HTTP \(http.statusCode)）"
                return nil
            }
            let result = try decoder.decode(AssistDraftResponse.self, from: data)
            errorMessage = nil
            return result.text
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // 创建页统一辅助填写：一次生成全部结构化字段，只返回草稿，不创建实体。
    func assistFormDraft(
        formType: AssistFormType,
        prompt: String,
        currentValues: [String: String],
        cwd: String? = nil,
        agentId: String? = nil
    ) async -> AssistFormDraft? {
        var request = URLRequest(url: baseURL.appending(path: "assist/form-draft"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "formType": formType.rawValue,
            "prompt": prompt,
            "currentValues": currentValues
        ]
        if let cwd, !cwd.isEmpty { body["cwd"] = cwd }
        if let agentId, !agentId.isEmpty { body["agentId"] = agentId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.error ?? "表单生成失败（HTTP \(http.statusCode)）"
                return nil
            }
            let result = try decoder.decode(AssistFormDraft.self, from: data)
            guard result.formType == formType.rawValue else {
                errorMessage = "生成结果的表单类型不匹配。"
                return nil
            }
            errorMessage = nil
            return result
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // 助手对话：POST /assistant/chat { content, sessionId? } → 返回消息列表
    func assistantChat(_ content: String, sessionId: String? = nil) async -> [AssistantMessage] {
        var request = URLRequest(url: baseURL.appending(path: "assistant/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["content": content, "sessionId": sessionId as Any]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            return try decoder.decode(AssistantChatResponse.self, from: data).messages
        } catch {
            errorMessage = error.localizedDescription
            return [AssistantMessage(role: "assistant", content: "抱歉，请求失败：\(error.localizedDescription)")]
        }
    }

    // 创建 Work：POST /works { name, ... } → 直接返回 work
    @discardableResult
    func createWork(id: String? = nil, name: String, description: String? = nil,
                         avatarPath: String? = nil, profile: String = "general", tags: [String] = [],
                         workspaceId: String? = nil,
                         contributorAgentIds: [String] = []) async -> Work? {
        var request = URLRequest(url: baseURL.appending(path: "works"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["name": name]
        if let id, !id.isEmpty { body["id"] = id }
        if let description { body["description"] = description }
        if let avatarPath, !avatarPath.isEmpty { body["avatarPath"] = avatarPath }
        body["profile"] = profile
        if !tags.isEmpty { body["tags"] = tags }
        if let workspaceId, !workspaceId.isEmpty { body["workspaceId"] = workspaceId }
        if !contributorAgentIds.isEmpty { body["contributorAgentIds"] = contributorAgentIds }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        if let work = await performEntityMutation(request, as: Work.self) {
            await refreshWorks()
            return work
        }
        return nil
    }

    @discardableResult
    func setWorkAvatar(workId: String, sourcePath: String) async -> Work? {
        await patchWorkAvatar(workId: workId, body: ["avatarPath": sourcePath])
    }

    @discardableResult
    func clearWorkAvatar(workId: String) async -> Work? {
        await patchWorkAvatar(workId: workId, body: ["avatarPath": NSNull()])
    }

    private func patchWorkAvatar(workId: String, body: [String: Any]) async -> Work? {
        var request = URLRequest(url: baseURL.appending(path: "works/\(workId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        if let work = await performEntityMutation(request, as: Work.self) {
            await refreshWorks()
            return work
        }
        return nil
    }

    // 手动注册一个 Git 仓库：POST /repositories/detect { dirPath } → { repository }
    @discardableResult
    func registerRepository(path: String, initializeIfNeeded: Bool = false) async -> RepositoryRegistrationResult {
        var request = URLRequest(url: baseURL.appending(path: "repositories/detect"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "dirPath": path,
            "initializeIfNeeded": initializeIfNeeded
        ])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                let message = envelope?.error ?? "添加仓库失败（HTTP \(http.statusCode)）"
                errorMessage = message
                if envelope?.code == "NOT_A_GIT_REPOSITORY" { return .notGitRepository }
                return .failure(message)
            }
            let repository = try decoder.decode(RepositoryDetectEnvelope.self, from: data).repository
            await refreshRepositories()
            errorMessage = nil
            return .success(repository)
        } catch {
            errorMessage = error.localizedDescription
            return .failure(error.localizedDescription)
        }
    }

    /// 注册普通文件夹 Workspace；Git 是可选能力，不是 Work 的前置条件。
    @discardableResult
    func registerWorkspace(path: String, initializeGit: Bool = false) async -> WorkspaceRegistrationResult {
        var request = URLRequest(url: baseURL.appending(path: "workspaces/detect"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "dirPath": path,
            "initializeGit": initializeGit
        ])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                let message = envelope?.error ?? "添加 Workspace 失败（HTTP \(http.statusCode)）"
                errorMessage = message
                return .failure(message)
            }
            let registration = try decoder.decode(WorkspaceRegistrationEnvelope.self, from: data)
            await refreshWorkspaces()
            await refreshRepositories()
            errorMessage = nil
            return .success(registration)
        } catch {
            errorMessage = error.localizedDescription
            return .failure(error.localizedDescription)
        }
    }

    // 创建 Agent 资源包：Provider 由实际 Session 选择。
    @discardableResult
    func createAgent(name: String, description: String? = nil, role: String = "independentContributor",
                     systemPrompt: String? = nil, capabilities: [String] = [],
                     skillIds: [String] = [], workDir: String? = nil,
                     idempotencyKey: String = UUID().uuidString) async -> Agent? {
        var request = URLRequest(url: baseURL.appending(path: "agents"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Request-ID")
        request.setValue(CorptieInstallationIdentity.id(), forHTTPHeaderField: "X-Corptie-Device-ID")
        var body: [String: Any] = ["name": name, "role": role]
        if let description, !description.isEmpty { body["description"] = description }
        if let systemPrompt { body["systemPrompt"] = systemPrompt }
        if !capabilities.isEmpty { body["capabilities"] = capabilities }
        if !skillIds.isEmpty { body["skillIds"] = skillIds }
        if let workDir, !workDir.isEmpty { body["workDir"] = workDir }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.error ?? "保存 Agent 失败（HTTP \(http.statusCode)）"
                return nil
            }
            let agent = try decoder.decode(AgentCreateEnvelope.self, from: data).agent
            await refreshAgents()
            return agent
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // 更新 Agent：PATCH /agents/:id → { agent }
    @discardableResult
    func updateAgent(agentId: String, name: String? = nil, description: String? = nil,
                     systemPrompt: String? = nil, skillIds: [String]? = nil,
                     workDir: String? = nil) async -> Agent? {
        var request = URLRequest(url: baseURL.appending(path: "agents/\(agentId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let description { body["description"] = description }
        if let systemPrompt { body["systemPrompt"] = systemPrompt }
        if let skillIds { body["skillIds"] = skillIds }
        if let workDir { body["workDir"] = workDir }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.error ?? "保存 Agent 失败（HTTP \(http.statusCode)）"
                return nil
            }
            let agent = try decoder.decode(AgentCreateEnvelope.self, from: data).agent
            await refreshAgents()
            return agent
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // 删除 Agent：DELETE /agents/:id → { ok }
    func deleteAgent(agentId: String) async -> Bool {
        var request = URLRequest(url: baseURL.appending(path: "agents/\(agentId)"))
        request.httpMethod = "DELETE"
        do {
            _ = try await URLSession.shared.data(for: request)
            await refreshAgents()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // 设置 Agent 头像：PATCH /agents/:id { avatarPath: 源文件路径 } → { agent }
    @discardableResult
    func setAgentAvatar(agentId: String, sourcePath: String) async -> Agent? {
        await patchAgentAvatar(agentId: agentId, body: ["avatarPath": sourcePath])
    }

    // 清除 Agent 头像：PATCH /agents/:id { avatarPath: null } → { agent }
    @discardableResult
    func clearAgentAvatar(agentId: String) async -> Agent? {
        await patchAgentAvatar(agentId: agentId, body: ["avatarPath": NSNull()])
    }

    private func patchAgentAvatar(agentId: String, body: [String: Any]) async -> Agent? {
        var request = URLRequest(url: baseURL.appending(path: "agents/\(agentId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let agent = try decoder.decode(AgentCreateEnvelope.self, from: data).agent
            await refreshAgents()
            return agent
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func discoverSkills(sourceType: String, source: String) async -> SkillDiscoveryEnvelope? {
        var request = URLRequest(url: baseURL.appending(path: "skills/discover"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "sourceType": sourceType,
            "source": source,
            "assist": true
        ])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.error ?? "发现 Skill 失败（HTTP \(http.statusCode)）"
                return nil
            }
            let result = try decoder.decode(SkillDiscoveryEnvelope.self, from: data)
            errorMessage = nil
            return result
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // 登记一个精确 Skill：sourceSubpath 指向包含 SKILL.md 的具体相对目录。
    @discardableResult
    func registerSkill(
        name: String?,
        description: String?,
        sourceType: String,
        source: String,
        sourceSubpath: String? = nil
    ) async -> Skill? {
        var request = URLRequest(url: baseURL.appending(path: "skills"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["sourceType": sourceType, "source": source, "assist": true]
        if let name, !name.isEmpty { body["name"] = name }
        if let description, !description.isEmpty { body["description"] = description }
        if let sourceSubpath { body["sourceSubpath"] = sourceSubpath }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.error ?? "登记 Skill 失败（HTTP \(http.statusCode)）"
                return nil
            }
            let skill = try decoder.decode(SkillEnvelope.self, from: data).skill
            await refreshSkills()
            return skill
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func skillDeletionImpact(skillId: String) async -> SkillDeletionImpact? {
        do {
            let impact = try await skillDeletionHTTPClient.impact(skillId: skillId)
            errorMessage = nil
            return impact
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // 删除登记：只有 HTTP 成功且响应明确为 completed 才视为成功。
    func deleteSkill(skillId: String) async -> Bool {
        do {
            _ = try await skillDeletionHTTPClient.delete(skillId: skillId)
            await AppStateSyncController.shared.refreshSnapshot()
            if let syncError = appState.syncError {
                throw EntityLaunchError(message: syncError, code: "STATE_SYNC_FAILED")
            }
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func performEntityMutation<T: Decodable>(_ request: URLRequest, as type: T.Type) async -> T? {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.displayMessage ?? "操作失败（HTTP \(http.statusCode)）"
                return nil
            }
            let value = try decoder.decode(type, from: data)
            // Apply a successful CorptieTask mutation before the follow-up snapshot.
            // This is the command's read-your-write boundary: a bind-then-start
            // action in the same UI turn must not keep using the stale nil binding.
            if let task = value as? CorptieTask {
                appState.acceptCorptieTask(task)
            }
            await AppStateSyncController.shared.refreshSnapshot()
            errorMessage = nil
            return value
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}

// POST /agents 响应 envelope
private struct AgentCreateEnvelope: Decodable {
    let agent: Agent
}

// POST /assist/draft 响应
private struct AssistDraftResponse: Decodable {
    let text: String
    let providerId: String?
}

private struct AcceptanceAssessmentRequest: Encodable {
    let sourceSessionId: String
    let results: [CorptieTaskAcceptanceResult]
}
