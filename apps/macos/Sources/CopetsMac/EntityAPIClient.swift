import Combine
import Foundation

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
    let workItems: [String: WorkItem]
    let objectives: [String: Objective]
    let agents: [String: Agent]
}

// 实体层轻量 API 客户端（15 Phase 5 净新增）。
// 独立于 BackendClient.swift 巨石，直连后端 entityHttpApi（/objectives、/work-items）。
// 与 BackendClient 使用相同后端地址（CorptieAppEnvironment.backendBaseURL）与 URLSession 模式。

@MainActor
final class EntityAPIClient: ObservableObject {
    static let shared = EntityAPIClient()

    private let appState: AppStateStore
    var objectives: [Objective] { appState.objectives }
    var agents: [Agent] { appState.agents }
    var workItems: [WorkItem] { appState.workItems }
    @Published private(set) var workItemsRevision: UInt64 = 0
    let sessionGroupingDidChange = PassthroughSubject<Void, Never>()
    @Published private(set) var workItemsLoadError: String?
    @Published private(set) var objectivesLoadError: String?

    /// 仅 Assistant 类 Agent（用于「新建会话」等自由对话入口）。
    var assistantAgents: [Agent] { agents.filter { $0.isAssistant } }
    var repositories: [GitRepository] { appState.repositories }
    var skills: [Skill] { appState.skills }
    @Published var isLoading = false
    @Published var errorMessage: String?
    private let skillDeletionHTTPClient = SkillDeletionHTTPClient()

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    private var objectivesRefreshGeneration = EntityRefreshGeneration()
    private var appStateCancellables = Set<AnyCancellable>()

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    init(appState: AppStateStore = .shared) {
        self.appState = appState

        appState.$state
            .map(\.workItems)
            .removeDuplicates()
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.workItemsRevision &+= 1
            }
            .store(in: &appStateCancellables)

        appState.$state
            .map { state in
                SessionGroupingEntityState(
                    workItems: state.workItems,
                    objectives: state.objectives,
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

    func refreshObjectives() async {
        let generation = objectivesRefreshGeneration.begin()
        isLoading = true
        defer {
            if objectivesRefreshGeneration.isCurrent(generation) {
                isLoading = false
            }
        }
        do {
            await AppStateSyncController.shared.refreshSnapshot()
            guard objectivesRefreshGeneration.isCurrent(generation) else { return }
            if let syncError = appState.syncError { throw EntityLaunchError(message: syncError, code: "STATE_SYNC_FAILED") }
            objectivesLoadError = nil
            errorMessage = nil
        } catch {
            guard objectivesRefreshGeneration.isCurrent(generation) else { return }
            objectivesLoadError = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    /// Entity requests made while the production launch agent is still starting
    /// are retried when the canonical backend Session stream becomes available.
    /// This keeps the first Objective view in sync without requiring a Tab switch.
    func refreshAfterBackendConnected() async {
        await refreshObjectives()
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

    // 拉取全局 Skill 维护中心列表：GET /skills → { skills }
    func refreshSkills() async {
        await AppStateSyncController.shared.refreshSnapshot()
        errorMessage = appState.syncError
    }

    func workItems(for objective: Objective) async -> [WorkItem]? {
        appState.workItems.filter { $0.objectiveId == objective.id }
    }

    func allWorkItems() async -> [WorkItem]? {
        appState.workItems
    }

    func clearWorkItemsLoadError() {
        workItemsLoadError = nil
    }

    private func loadWorkItems(from url: URL) async -> [WorkItem]? {
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(
                    message: envelope?.error ?? "加载 WorkItem 失败（HTTP \(http.statusCode)）",
                    code: envelope?.code
                )
            }
            let workItems = try decoder.decode(WorkItemListEnvelope.self, from: data).workItems
            workItemsLoadError = nil
            errorMessage = nil
            return workItems
        } catch {
            let message = Self.workItemsLoadErrorMessage(error)
            workItemsLoadError = message
            errorMessage = message
            return nil
        }
    }

    static func workItemsLoadErrorMessage(_ error: Error) -> String {
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
        return "WorkItem 加载失败；未用空列表覆盖现有内容。此错误不代表数据已删除。\(detail)"
    }

    func workItem(id: String) async -> WorkItem? {
        do {
            let url = baseURL.appending(path: "work-items/\(id)")
            let (data, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                errorMessage = "加载 WorkItem 失败（HTTP \(http.statusCode)）"
                return nil
            }
            let workItem = try decoder.decode(WorkItem.self, from: data)
            errorMessage = nil
            return workItem
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // 更新 WorkItem：PATCH /work-items/:id → workItem（直接返回对象，非 envelope）
    @discardableResult
    func updateWorkItem(workItemId: String, title: String? = nil, description: String? = nil,
                        acceptanceCriteria: String? = nil,
                        priority: String? = nil, status: String? = nil, mainWorkspaceId: String? = nil,
                        mainAgentId: String? = nil) async -> WorkItem? {
        var request = URLRequest(url: baseURL.appending(path: "work-items/\(workItemId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let title { body["title"] = title }
        if let description { body["description"] = description }
        if let acceptanceCriteria { body["acceptanceCriteria"] = acceptanceCriteria }
        if let priority { body["priority"] = priority }
        if let status { body["status"] = status }
        if let mainWorkspaceId { body["mainWorkspaceId"] = mainWorkspaceId }
        if let mainAgentId { body["mainAgentId"] = mainAgentId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return await performEntityMutation(request, as: WorkItem.self)
    }

    // 用户在确认界面作出的最终裁决。通用 PATCH status=done 仍保留证据门禁，
    // 防止 Agent 或后台流程把普通状态更新冒充为用户确认。
    @discardableResult
    func confirmWorkItemCompletion(workItemId: String) async -> WorkItem? {
        var request = URLRequest(
            url: baseURL.appending(path: "work-items/\(workItemId)/confirm-completion")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["confirmed": true])
        return await performEntityMutation(request, as: WorkItem.self)
    }

    func restoreWorkItemExecution(workItemId: String) async -> EntityWorkItemRestoreResult {
        var request = URLRequest(
            url: baseURL.appending(path: "work-items/\(workItemId)/actions/restore")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                let message = envelope?.error ?? L10n("Unable to restore WorkItem execution")
                errorMessage = message
                return .failure(message: message, code: envelope?.code)
            }
            let restored = try decoder.decode(WorkItemRestoreEnvelope.self, from: data).workItem
            errorMessage = nil
            return .success(restored)
        } catch {
            let message = error.localizedDescription
            errorMessage = message
            return .failure(message: message)
        }
    }

    func worktreeStatus(workItemId: String) async -> WorkItemWorktreeStatus? {
        do {
            let url = baseURL.appending(path: "work-items/\(workItemId)/worktree")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(
                    message: envelope?.error ?? L10n("Unable to inspect the Worktree."),
                    code: envelope?.code
                )
            }
            let status = try decoder.decode(WorkItemWorktreeStatus.self, from: data)
            errorMessage = nil
            return status
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return nil
        }
    }

    func reclaimWorktree(workItemId: String) async -> WorkItemWorktreeStatus? {
        var request = URLRequest(
            url: baseURL.appending(path: "work-items/\(workItemId)/worktree/reclaim")
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
            let status = try decoder.decode(WorkItemWorktreeStatus.self, from: data)
            errorMessage = nil
            return status
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return nil
        }
    }

    // 用户明确驳回已通过的自动验收结论，保留评估证据但撤销“可完成”建议。
    @discardableResult
    func rejectWorkItemAcceptance(workItemId: String) async -> WorkItem? {
        var request = URLRequest(
            url: baseURL.appending(path: "work-items/\(workItemId)/reject-acceptance")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["rejected": true])
        return await performEntityMutation(request, as: WorkItem.self)
    }

    // 提交独立的验收评估。该接口要求逐条标准、结论和可核验证据；
    // Session 生命周期状态不能通过此方法隐式转换为验收通过。
    @discardableResult
    func submitAcceptanceAssessment(
        workItemId: String,
        sourceSessionId: String,
        results: [WorkItemAcceptanceResult]
    ) async -> WorkItem? {
        var request = URLRequest(
            url: baseURL.appending(path: "work-items/\(workItemId)/acceptance-assessment")
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
            let workItem = try decoder.decode(WorkItem.self, from: data)
            errorMessage = nil
            return workItem
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return nil
        }
    }

    // 创建 WorkItem：POST /work-items { objectiveId, title, mainAgentId, ... } → workItem
    @discardableResult
    func createWorkItem(id: String? = nil, objectiveId: String, title: String, description: String? = nil,
                        acceptanceCriteria: String? = nil,
                        mainWorkspaceId: String? = nil, mainAgentId: String? = nil,
                        priority: String? = nil) async -> WorkItem? {
        var request = URLRequest(url: baseURL.appending(path: "work-items"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["objectiveId": objectiveId, "title": title]
        if let id, !id.isEmpty { body["id"] = id }
        if let description, !description.isEmpty { body["description"] = description }
        if let acceptanceCriteria, !acceptanceCriteria.isEmpty { body["acceptanceCriteria"] = acceptanceCriteria }
        if let mainWorkspaceId, !mainWorkspaceId.isEmpty { body["mainWorkspaceId"] = mainWorkspaceId }
        if let mainAgentId, !mainAgentId.isEmpty { body["mainAgentId"] = mainAgentId }
        if let priority { body["priority"] = priority }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return await performEntityMutation(request, as: WorkItem.self)
    }

    // WorkItem execution history is a selector over the unified AppStateStore.
    // There is no view-local HTTP cache to drift from the session list.
    func sessions(for workItem: WorkItem) async -> [WorkItemSessionSummary] {
        appState.sessions
            .filter { $0.workItemId == workItem.id }
            .sorted { $0.updatedAt > $1.updatedAt }
            .map {
                WorkItemSessionSummary(
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

    // 查某 owner（如 work_item）的记忆：GET /memories?ownerType=&ownerId= → { memories }
    func memories(ownerType: String, ownerId: String) async -> [MemoryItem] {
        var components = URLComponents(url: baseURL.appending(path: "memories"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "ownerType", value: ownerType),
            URLQueryItem(name: "ownerId", value: ownerId)
        ]
        guard let url = components?.url else { return [] }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            return try decoder.decode(MemoryListEnvelope.self, from: data).memories
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    // 创建 Worker Session：必须同时绑定 WorkItem 与 Independent Contributor。
    @discardableResult
    func createSession(
        workItemId: String,
        agentId: String,
        providerId: String,
        title: String? = nil
    ) async -> EntitySessionLaunchResult {
        var request = URLRequest(url: baseURL.appending(path: "sessions"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["workItemId": workItemId, "agentId": agentId, "providerId": providerId]
        if let title { body["title"] = title }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                let message = envelope?.error ?? "执行失败（HTTP \(http.statusCode)）"
                errorMessage = message
                return .failure(message: message, code: envelope?.code)
            }
            let session = try decoder.decode(SessionCreateEnvelope.self, from: data).session
            errorMessage = nil
            return .success(session)
        } catch {
            let message = error.localizedDescription
            errorMessage = message
            return .failure(message: message)
        }
    }

    // Assistant Chat Session：仅凭 Assistant 开聊，不绑定 WorkItem。
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
    func startObjectiveChat(
        objectiveId: String,
        agentId: String,
        providerId: String,
        title: String? = nil,
        prompt: String? = nil
    ) async -> EntitySessionLaunchResult {
        var request = URLRequest(url: baseURL.appending(path: "objectives/\(objectiveId)/sessions"))
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
                let message = envelope?.error ?? "启动 Objective Chat 失败（HTTP \(http.statusCode)）"
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

    // 更新 Objective：PATCH /objectives/:id → objective（直接返回对象）
    // priority/targetDate 传 "" 表示清除；tags/workspaceIds/relatedObjectiveIds/contributorAgentIds 传数组整体替换。
    @discardableResult
    func updateObjective(objectiveId: String, name: String? = nil, description: String? = nil,
                         idealState: String? = nil, priority: String? = nil, targetDate: String? = nil,
                         tags: [String]? = nil, workspaceIds: [String]? = nil,
                         relatedObjectiveIds: [String]? = nil, contributorAgentIds: [String]? = nil) async -> Objective? {
        var request = URLRequest(url: baseURL.appending(path: "objectives/\(objectiveId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let description { body["description"] = description }
        if let idealState { body["idealState"] = idealState }
        if let priority { body["priority"] = priority }
        if let targetDate { body["targetDate"] = targetDate }
        if let tags { body["tags"] = tags }
        if let workspaceIds { body["workspaceIds"] = workspaceIds }
        if let relatedObjectiveIds { body["relatedObjectiveIds"] = relatedObjectiveIds }
        if let contributorAgentIds { body["contributorAgentIds"] = contributorAgentIds }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        if let objective = await performEntityMutation(request, as: Objective.self) {
            await refreshObjectives()
            return objective
        }
        return nil
    }

    // 删除 Objective：DELETE /objectives/:id → { ok }
    func deleteObjective(objectiveId: String) async -> Bool {
        var request = URLRequest(url: baseURL.appending(path: "objectives/\(objectiveId)"))
        request.httpMethod = "DELETE"
        do {
            _ = try await URLSession.shared.data(for: request)
            await refreshObjectives()
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

    // 创建 Objective：POST /objectives { name, ... } → 直接返回 objective
    @discardableResult
    func createObjective(id: String? = nil, name: String, description: String? = nil, idealState: String? = nil,
                         priority: String? = nil, targetDate: String? = nil, tags: [String] = [],
                         workspaceIds: [String] = [], relatedObjectiveIds: [String] = [],
                         contributorAgentIds: [String] = []) async -> Objective? {
        var request = URLRequest(url: baseURL.appending(path: "objectives"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["name": name]
        if let id, !id.isEmpty { body["id"] = id }
        if let description { body["description"] = description }
        if let idealState { body["idealState"] = idealState }
        if let priority { body["priority"] = priority }
        if let targetDate { body["targetDate"] = targetDate }
        if !tags.isEmpty { body["tags"] = tags }
        if !workspaceIds.isEmpty { body["workspaceIds"] = workspaceIds }
        if !relatedObjectiveIds.isEmpty { body["relatedObjectiveIds"] = relatedObjectiveIds }
        if !contributorAgentIds.isEmpty { body["contributorAgentIds"] = contributorAgentIds }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        if let objective = await performEntityMutation(request, as: Objective.self) {
            await refreshObjectives()
            return objective
        }
        return nil
    }

    // 手动注册一个 Git 仓库：POST /repositories/detect { dirPath } → { repository }
    @discardableResult
    func detectRepository(path: String) async -> GitRepository? {
        var request = URLRequest(url: baseURL.appending(path: "repositories/detect"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["dirPath": path])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                errorMessage = envelope?.error ?? "添加仓库失败（HTTP \(http.statusCode)）"
                return nil
            }
            let repository = try decoder.decode(RepositoryDetectEnvelope.self, from: data).repository
            await refreshRepositories()
            errorMessage = nil
            return repository
        } catch {
            errorMessage = error.localizedDescription
            return nil
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
    let results: [WorkItemAcceptanceResult]
}
