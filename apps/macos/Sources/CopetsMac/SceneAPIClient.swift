import Foundation

@MainActor
final class SceneAPIClient: ObservableObject {
    @Published private(set) var templates: [SceneTemplateSummary] = []
    @Published private(set) var scenes: [SceneInstance] = []
    @Published private(set) var records: [SceneRecord] = []
    @Published private(set) var rows: [SceneRecordPresentation] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingInventory = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var inventoryError: String?
    @Published private(set) var nextOffset: Int?
    @Published private(set) var pageError: String?
    @Published private(set) var isLoadingPage = false
    @Published private(set) var isResolvingList = false
    @Published private(set) var listIssue: String?
    @Published private(set) var groupOffset = 0
    private(set) var scenesByID: [String: SceneInstance] = [:]
    private var sceneIndices: [String: Int] = [:]
    private var operationStates: [String: SceneOperationState] = [:]
    private let baseURL: URL
    private let session: URLSession
    private var sceneLoadGeneration = 0
    private(set) var recordsOwnerSceneID: String?
    private var loadedRevision: Int?
    private var knownList: SceneRecord?
    private var listResolved = false
    private var itemCount = 0
    private var previousGroups: [Int] = []

    init(baseURL: URL = CorptieAppEnvironment.backendBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL; self.session = session
    }

    func operation(for sceneID: String) -> SceneOperationState {
        if let state = operationStates[sceneID] { return state }
        let state = SceneOperationState(); operationStates[sceneID] = state; return state
    }
    func clearError() { errorMessage = nil }

    func loadInventory() async {
        guard !isLoadingInventory else { return }
        isLoadingInventory = true
        defer { isLoadingInventory = false }
        do {
            async let templatesData = request(path: "scene-templates")
            async let scenesData = request(path: "scenes")
            let (t, s) = try await (templatesData, scenesData)
            let loadedTemplates = try await Self.decode(TemplatesEnvelope.self, data: t).templates
            let loadedScenes = try await Self.decode(ScenesEnvelope.self, data: s).scenes
            // Publish indices before the array, so selection does not scan the inventory.
            scenesByID = Dictionary(uniqueKeysWithValues: loadedScenes.map { ($0.id, $0) })
            sceneIndices = Dictionary(uniqueKeysWithValues: loadedScenes.enumerated().map { ($0.element.id, $0.offset) })
            templates = loadedTemplates; scenes = loadedScenes; inventoryError = nil
        } catch { inventoryError = error.localizedDescription }
    }

    func loadScene(_ scene: SceneInstance) async {
        sceneLoadGeneration += 1
        let generation = sceneLoadGeneration
        if recordsOwnerSceneID != scene.id { records = []; rows = []; loadedRevision = nil }
        recordsOwnerSceneID = scene.id
        nextOffset = nil; pageError = nil; errorMessage = nil
        knownList = nil; listResolved = false; itemCount = 0; listIssue = nil; isResolvingList = false
        previousGroups = []; groupOffset = 0; isLoadingPage = false
        isLoading = true
        defer { if generation == sceneLoadGeneration { isLoading = false } }
        guard SceneKind(scene).viewID != nil else { return }
        do {
            let response = try await readPage(scene, offset: 0)
            guard generation == sceneLoadGeneration else { return }
            publish(response, offset: 0)
            isLoading = false
            if SceneKind(scene) == .checklist {
                isResolvingList = true
                defer { if generation == sceneLoadGeneration { isResolvingList = false } }
                try await resolveList(scene, first: response, generation: generation)
            }
        } catch {
            guard generation == sceneLoadGeneration else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func resolveList(_ scene: SceneInstance, first: SceneViewResponse, generation: Int) async throws {
        var page = first
        var lists: [String: SceneRecord] = [:]
        var count = 0
        var currentOffset = 0
        repeat {
            count += page.records.lazy.filter { $0.recordType == "Item" }.count
            for record in page.records where record.recordType == "List" && record.archivedAt == nil
                && record.data["archived"]?.boolValue != true { lists[record.id] = record }
            guard generation == sceneLoadGeneration else { return }
            if lists.count > 1 {
                listIssue = SceneText("This scene has multiple checklists. Entry is unavailable here.")
                return
            }
            guard let offset = page.nextOffset else { break }
            guard offset > currentOffset else {
                listIssue = SceneText("Records changed. Refresh before continuing."); return
            }
            currentOffset = offset
            let following = try await readPage(scene, offset: offset)
            guard generation == sceneLoadGeneration else { return }
            guard following.scene.instanceRevision == first.scene.instanceRevision else {
                listIssue = SceneText("Records changed. Refresh before editing."); return
            }
            page = following
        } while !Task.isCancelled
        guard generation == sceneLoadGeneration, !Task.isCancelled else { return }
        knownList = lists.values.first; itemCount = count; listResolved = true
    }

    func loadMore(_ scene: SceneInstance) async { await page(scene, offset: nextOffset, previous: false) }
    func loadPrevious(_ scene: SceneInstance) async { await page(scene, offset: previousGroups.last, previous: true) }
    var hasPreviousGroup: Bool { !previousGroups.isEmpty }

    private func page(_ scene: SceneInstance, offset: Int?, previous: Bool) async {
        guard let offset, !isLoading, !isLoadingPage, recordsOwnerSceneID == scene.id else { return }
        let generation = sceneLoadGeneration
        isLoadingPage = true; pageError = nil
        defer { if generation == sceneLoadGeneration { isLoadingPage = false } }
        do {
            let response = try await readPage(scene, offset: offset)
            guard generation == sceneLoadGeneration else { return }
            guard response.scene.instanceRevision == loadedRevision else {
                pageError = SceneText("Records changed. Refresh before continuing."); nextOffset = nil; return
            }
            if previous {
                previousGroups.removeLast()
                publish(response, offset: offset)
            } else if records.count + response.records.count > 500 {
                previousGroups.append(groupOffset)
                publish(response, offset: offset)
            } else {
                var ids = Set(records.map(\.id))
                records.append(contentsOf: response.records.filter { ids.insert($0.id).inserted })
                nextOffset = response.nextOffset
                prepareRows(scene: response.scene)
            }
        } catch {
            guard generation == sceneLoadGeneration else { return }
            pageError = error.localizedDescription
        }
    }

    private func publish(_ response: SceneViewResponse, offset: Int) {
        records = response.records; nextOffset = response.nextOffset; groupOffset = offset
        loadedRevision = response.scene.instanceRevision
        updateScene(response.scene); prepareRows(scene: response.scene)
    }
    func prepareRows(scene: SceneInstance) {
        rows = SceneRecordPresentation.prepare(records, scene: scene, locale: AppLanguageController.shared.locale)
    }

    func createScene(_ draft: CreateSceneDraft) async throws -> SceneInstance {
        let data = try await request(path: "scenes", method: "POST", body: [
            "templateId": draft.templateId, "templateVersion": draft.templateVersion,
            "name": SceneInput.clean(draft.name), "timezone": SceneInput.clean(draft.timezone),
            "unitPreferences": [:] as [String: String]
        ])
        let created: SceneInstance
        do { created = try await Self.decode(SceneEnvelope.self, data: data).scene }
        catch { throw SceneRequestError(message: error.localizedDescription, code: nil, uncertain: true) }
        scenesByID[created.id] = created
        scenes.insert(created, at: 0)
        sceneIndices = Dictionary(uniqueKeysWithValues: scenes.enumerated().map { ($0.element.id, $0.offset) })
        return created
    }

    @discardableResult func addChecklistItem(title: String, to scene: SceneInstance) async -> SceneMutationOutcome {
        let state = operation(for: scene.id)
        guard !state.isPending, !state.needsVerification, recordsOwnerSceneID == scene.id,
              listResolved, listIssue == nil, SceneInput.validText(title, maximum: 240) else { return .rejected }
        state.isPending = true; state.message = nil
        defer { state.isPending = false }
        do {
            var current = scenesByID[scene.id] ?? scene
            var listID = knownList?.recordId
            if listID == nil {
                let id = "scene-record:\(UUID().uuidString.lowercased())"
                let receipt = try await commit(scene: current, command: "createRecord", payload: [
                    "recordId": id, "recordType": "List", "data": ["title": "日常", "archived": false]
                ])
                current = replacingRevision(current, receipt.instanceRevision)
                listID = id
                if recordsOwnerSceneID == scene.id {
                    knownList = SceneRecord(instanceId: scene.id, recordId: id, recordType: "List",
                        data: ["title": .string("日常"), "archived": .bool(false)], recordVersion: 1,
                        archivedAt: nil, createdAt: "", updatedAt: "")
                }
            }
            _ = try await commit(scene: current, command: "createRecord", payload: [
                "recordId": "scene-record:\(UUID().uuidString.lowercased())", "recordType": "Item",
                "data": ["listId": listID!, "title": SceneInput.clean(title), "dueAt": NSNull(),
                         "completed": false, "order": min(itemCount, 100000)]
            ])
            await refreshAfterCommit(scene, state: state)
            return .committed
        } catch { return handle(error, state: state) }
    }

    @discardableResult func addMeasurement(metric: String, value: Double, unit: String, to scene: SceneInstance) async -> SceneMutationOutcome {
        let state = operation(for: scene.id)
        guard !state.isPending, !state.needsVerification, value.isFinite, (-1_000_000...1_000_000).contains(value),
              SceneInput.validText(metric, maximum: 80), SceneInput.validText(unit, maximum: 32) else { return .rejected }
        return await mutate(scene, state: state, command: "createRecord", payload: [
            "recordId": "scene-record:\(UUID().uuidString.lowercased())", "recordType": "Measurement",
            "data": ["measuredAt": ISO8601DateFormatter().string(from: Date()), "metric": SceneInput.clean(metric),
                     "value": value, "unit": SceneInput.clean(unit), "source": "manual"]
        ])
    }

    @discardableResult func toggleChecklistItem(_ record: SceneRecord, in scene: SceneInstance) async -> SceneMutationOutcome {
        let state = operation(for: scene.id)
        guard !state.isPending, !state.needsVerification else { return .rejected }
        state.pendingRecordID = record.id
        defer { state.pendingRecordID = nil }
        return await mutate(scene, state: state, command: "updateRecord", payload: [
            "recordId": record.recordId, "expectedRecordVersion": record.recordVersion,
            "patch": ["completed": !(record.data["completed"]?.boolValue ?? false)]
        ])
    }

    private func mutate(_ scene: SceneInstance, state: SceneOperationState, command: String, payload: [String: Any]) async -> SceneMutationOutcome {
        state.isPending = true; state.message = nil
        defer { state.isPending = false }
        do {
            _ = try await commit(scene: scenesByID[scene.id] ?? scene, command: command, payload: payload)
            await refreshAfterCommit(scene, state: state)
            return .committed
        } catch { return handle(error, state: state) }
    }
    private func refreshAfterCommit(_ scene: SceneInstance, state: SceneOperationState) async {
        state.message = SceneText("Saved")
        if recordsOwnerSceneID == scene.id {
            await loadScene(scene)
            if errorMessage != nil { state.message = SceneText("Saved, but records could not refresh. Refresh without submitting again.") }
        }
    }
    private func handle(_ error: Error, state: SceneOperationState) -> SceneMutationOutcome {
        let typed = error as? SceneRequestError
        if typed?.uncertain == true {
            state.needsVerification = true
            state.message = SceneText("Submission not confirmed. Refresh and check before entering another record.")
            return .uncertain
        }
        if typed?.code == "SCENE_REVISION_CONFLICT" || typed?.code == "SCENE_RECORD_VERSION_CONFLICT" {
            state.message = SceneText("Records changed. Refresh before editing.")
        } else { state.message = error.localizedDescription }
        return .rejected
    }

    private func readPage(_ scene: SceneInstance, offset: Int) async throws -> SceneViewResponse {
        guard let view = SceneKind(scene).viewID else { throw SceneRequestError(message: SceneText("This template version does not support entry here."), code: nil, uncertain: false) }
        let data = try await request(path: "scenes/\(scene.instanceId)/views/\(view)", query: [URLQueryItem(name: "limit", value: "100"), URLQueryItem(name: "offset", value: String(offset))])
        let response = try await Self.decode(SceneViewResponse.self, data: data)
        guard response.scene.id == scene.id, response.records.allSatisfy({ $0.instanceId == scene.id }) else {
            throw SceneRequestError(message: SceneText("Scene request failed"), code: "SCENE_RESPONSE_SCOPE_INVALID", uncertain: false)
        }
        return response
    }
    private func commit(scene: SceneInstance, command: String, payload: [String: Any]) async throws -> SceneMutationReceipt {
        let data = try await request(path: "scenes/\(scene.instanceId)/commands/commit", method: "POST", body: [
            "command": command, "payload": payload, "expectedInstanceRevision": scene.instanceRevision,
            "idempotencyKey": UUID().uuidString
        ])
        let receipt: SceneMutationReceipt
        do { receipt = try await Self.decode(SceneMutationReceipt.self, data: data) }
        catch { throw SceneRequestError(message: error.localizedDescription, code: nil, uncertain: true) }
        updateScene(replacingRevision(scene, receipt.instanceRevision)); return receipt
    }
    private func request(path: String, method: String = "GET", body: [String: Any]? = nil, query: [URLQueryItem] = []) async throws -> Data {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method; request.timeoutInterval = 30
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data; let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            throw SceneRequestError(message: error.localizedDescription, code: nil, uncertain: method != "GET")
        }
        guard let http = response as? HTTPURLResponse, http.statusCode < 400 else {
            let envelope = try? await Self.decode(SceneErrorEnvelope.self, data: data)
            throw SceneRequestError(message: envelope?.error ?? SceneText("Scene request failed"), code: envelope?.code,
                                    uncertain: method != "GET" && ((response as? HTTPURLResponse)?.statusCode ?? 500) >= 500)
        }
        return data
    }
    nonisolated private static func decode<T: Decodable & Sendable>(_ type: T.Type, data: Data) async throws -> T {
        try await Task.detached(priority: .userInitiated) {
            let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
            return try decoder.decode(type, from: data)
        }.value
    }
    private func updateScene(_ scene: SceneInstance) {
        scenesByID[scene.id] = scene
        guard let index = sceneIndices[scene.id] else { return }
        scenes[index] = scene
    }
    private func replacingRevision(_ scene: SceneInstance, _ revision: Int) -> SceneInstance {
        SceneInstance(instanceId: scene.id, templateId: scene.templateId, templateVersion: scene.templateVersion,
                      name: scene.name, timezone: scene.timezone, status: scene.status, instanceRevision: revision,
                      resourceVersion: scene.resourceVersion + 1, createdAt: scene.createdAt, updatedAt: scene.updatedAt)
    }
}
private struct TemplatesEnvelope: Decodable, Sendable { let templates: [SceneTemplateSummary] }
private struct ScenesEnvelope: Decodable, Sendable { let scenes: [SceneInstance] }
private struct SceneEnvelope: Decodable, Sendable { let scene: SceneInstance }
private struct SceneErrorEnvelope: Decodable, Sendable { let error: String; let code: String? }
