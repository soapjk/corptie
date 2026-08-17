import Combine
import Foundation

// 实体层轻量 API 客户端（15 Phase 5 净新增）。
// 独立于 BackendClient.swift 巨石，直连后端 entityHttpApi（/objectives、/work-items）。
// 与 BackendClient 使用相同后端地址（CorptieAppEnvironment.backendBaseURL）与 URLSession 模式。

@MainActor
final class EntityAPIClient: ObservableObject {
    static let shared = EntityAPIClient()

    @Published var objectives: [Objective] = []
    @Published var agents: [Agent] = []
    @Published private(set) var workItemsRevision: UInt64 = 0

    /// 仅 Assistant 类 Agent（用于「新建会话」等自由对话入口）。
    var assistantAgents: [Agent] { agents.filter { $0.isAssistant } }
    @Published var repositories: [GitRepository] = []
    @Published var skills: [Skill] = []
    @Published var isLoading = false
    @Published var errorMessage: String?

    private let baseURL = CorptieAppEnvironment.backendBaseURL

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    private init() {}

    func handleEntityChangeEvent(_ eventName: String) async {
        switch eventName {
        case "ObjectiveChanged":
            await refreshObjectives()
        case "AgentChanged":
            await refreshAgents()
        case "WorkItemChanged":
            workItemsRevision &+= 1
        default:
            break
        }
    }

    func refreshObjectives() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let (data, _) = try await URLSession.shared.data(from: baseURL.appending(path: "objectives"))
            objectives = try decoder.decode(ObjectiveListEnvelope.self, from: data).objectives
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshAgents() async {
        do {
            let (data, _) = try await URLSession.shared.data(from: baseURL.appending(path: "agents"))
            agents = try decoder.decode(AgentListEnvelope.self, from: data).agents
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshRepositories() async {
        do {
            let (data, _) = try await URLSession.shared.data(from: baseURL.appending(path: "repositories"))
            repositories = try decoder.decode(RepositoryListEnvelope.self, from: data).repositories
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // 拉取全局 Skill 维护中心列表：GET /skills → { skills }
    func refreshSkills() async {
        do {
            let (data, _) = try await URLSession.shared.data(from: baseURL.appending(path: "skills"))
            skills = try decoder.decode(SkillListEnvelope.self, from: data).skills
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func workItems(for objective: Objective) async -> [WorkItem] {
        do {
            let url = baseURL.appending(path: "objectives/\(objective.id)/work-items")
            let (data, _) = try await URLSession.shared.data(from: url)
            return try decoder.decode(WorkItemListEnvelope.self, from: data).workItems
        } catch {
            errorMessage = error.localizedDescription
            return []
        }
    }

    func allWorkItems() async -> [WorkItem] {
        do {
            let url = baseURL.appending(path: "work-items")
            let (data, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(
                    message: envelope?.error ?? "加载 WorkItem 失败（HTTP \(http.statusCode)）",
                    code: envelope?.code
                )
            }
            let workItems = try decoder.decode(WorkItemListEnvelope.self, from: data).workItems
            errorMessage = nil
            return workItems
        } catch {
            errorMessage = (error as? EntityLaunchError)?.message ?? error.localizedDescription
            return []
        }
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
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(
                    message: envelope?.error ?? "更新 WorkItem 失败（HTTP \(http.statusCode)）",
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

    // 创建 WorkItem：POST /work-items { objectiveId, title, description?, mainWorkspaceId?, priority? } → workItem
    @discardableResult
    func createWorkItem(objectiveId: String, title: String, description: String? = nil,
                        acceptanceCriteria: String? = nil,
                        mainWorkspaceId: String? = nil, priority: String? = nil) async -> WorkItem? {
        var request = URLRequest(url: baseURL.appending(path: "work-items"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["objectiveId": objectiveId, "title": title]
        if let description, !description.isEmpty { body["description"] = description }
        if let acceptanceCriteria, !acceptanceCriteria.isEmpty { body["acceptanceCriteria"] = acceptanceCriteria }
        if let mainWorkspaceId, !mainWorkspaceId.isEmpty { body["mainWorkspaceId"] = mainWorkspaceId }
        if let priority { body["priority"] = priority }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            return try decoder.decode(WorkItem.self, from: data)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // WorkItem 名下的 Session 历史：GET /work-items/:id/sessions → { sessions }
    func sessions(for workItem: WorkItem) async -> [WorkItemSessionSummary] {
        do {
            let url = baseURL.appending(path: "work-items/\(workItem.id)/sessions")
            let (data, _) = try await URLSession.shared.data(from: url)
            return try decoder.decode(WorkItemSessionListEnvelope.self, from: data).sessions
        } catch {
            errorMessage = error.localizedDescription
            return []
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
        title: String? = nil
    ) async -> EntitySessionLaunchResult {
        var request = URLRequest(url: baseURL.appending(path: "sessions"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["workItemId": workItemId, "agentId": agentId]
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
        title: String? = nil,
        prompt: String? = nil
    ) async -> EntitySessionLaunchResult {
        var request = URLRequest(url: baseURL.appending(path: "agents/\(agentId)/sessions"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
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

    // 更新 Objective：PATCH /objectives/:id → objective（直接返回对象）
    // priority/targetDate 传 "" 表示清除；tags/workspaceIds/relatedObjectiveIds/contributorAgentIds 传数组整体替换。
    @discardableResult
    func updateObjective(objectiveId: String, name: String? = nil, description: String? = nil,
                         acceptanceCriteria: String? = nil, priority: String? = nil, targetDate: String? = nil,
                         tags: [String]? = nil, workspaceIds: [String]? = nil,
                         relatedObjectiveIds: [String]? = nil, contributorAgentIds: [String]? = nil) async -> Objective? {
        var request = URLRequest(url: baseURL.appending(path: "objectives/\(objectiveId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let description { body["description"] = description }
        if let acceptanceCriteria { body["acceptanceCriteria"] = acceptanceCriteria }
        if let priority { body["priority"] = priority }
        if let targetDate { body["targetDate"] = targetDate }
        if let tags { body["tags"] = tags }
        if let workspaceIds { body["workspaceIds"] = workspaceIds }
        if let relatedObjectiveIds { body["relatedObjectiveIds"] = relatedObjectiveIds }
        if let contributorAgentIds { body["contributorAgentIds"] = contributorAgentIds }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let objective = try decoder.decode(Objective.self, from: data)
            await refreshObjectives()
            return objective
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
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
    func createObjective(name: String, description: String? = nil, acceptanceCriteria: String? = nil,
                         priority: String? = nil, targetDate: String? = nil, tags: [String] = [],
                         workspaceIds: [String] = [], relatedObjectiveIds: [String] = [],
                         contributorAgentIds: [String] = []) async -> Objective? {
        var request = URLRequest(url: baseURL.appending(path: "objectives"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["name": name]
        if let description { body["description"] = description }
        if let acceptanceCriteria { body["acceptanceCriteria"] = acceptanceCriteria }
        if let priority { body["priority"] = priority }
        if let targetDate { body["targetDate"] = targetDate }
        if !tags.isEmpty { body["tags"] = tags }
        if !workspaceIds.isEmpty { body["workspaceIds"] = workspaceIds }
        if !relatedObjectiveIds.isEmpty { body["relatedObjectiveIds"] = relatedObjectiveIds }
        if !contributorAgentIds.isEmpty { body["contributorAgentIds"] = contributorAgentIds }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let objective = try decoder.decode(Objective.self, from: data)
            await refreshObjectives()
            return objective
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
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

    // 创建 Agent：POST /agents { name, description?, role?, provider?, systemPrompt?, capabilities?, skillIds? } → { agent }
    @discardableResult
    func createAgent(name: String, description: String? = nil, role: String = "independentContributor",
                     provider: String? = nil, systemPrompt: String? = nil, capabilities: [String] = [],
                     skillIds: [String] = [], workDir: String? = nil) async -> Agent? {
        var request = URLRequest(url: baseURL.appending(path: "agents"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["name": name, "role": role]
        if let description, !description.isEmpty { body["description"] = description }
        if let provider { body["provider"] = provider }
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
                     provider: String? = nil,
                     systemPrompt: String? = nil, skillIds: [String]? = nil,
                     workDir: String? = nil) async -> Agent? {
        var request = URLRequest(url: baseURL.appending(path: "agents/\(agentId)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let description { body["description"] = description }
        if let provider { body["provider"] = provider }
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

    func discoverSkills(sourceType: String, source: String) async -> [SkillCandidate]? {
        var request = URLRequest(url: baseURL.appending(path: "skills/discover"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "sourceType": sourceType,
            "source": source
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
            return result.candidates
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
        var body: [String: Any] = ["sourceType": sourceType, "source": source]
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

    // 删除登记：DELETE /skills/:id → { ok }
    func deleteSkill(skillId: String) async -> Bool {
        var request = URLRequest(url: baseURL.appending(path: "skills/\(skillId)"))
        request.httpMethod = "DELETE"
        do {
            _ = try await URLSession.shared.data(for: request)
            await refreshSkills()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
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
