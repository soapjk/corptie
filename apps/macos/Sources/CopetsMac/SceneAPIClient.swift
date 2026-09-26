import Foundation

@MainActor
final class SceneAPIClient: ObservableObject {
    @Published private(set) var templates: [SceneTemplateSummary] = []
    @Published private(set) var scenes: [SceneInstance] = []
    @Published private(set) var records: [SceneRecord] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    func clearError() { errorMessage = nil }

    func loadInventory() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let templatesData = request(path: "scene-templates")
            async let scenesData = request(path: "scenes")
            let (loadedTemplates, loadedScenes) = try await (templatesData, scenesData)
            templates = try decoder.decode(TemplatesEnvelope.self, from: loadedTemplates).templates
            scenes = try decoder.decode(ScenesEnvelope.self, from: loadedScenes).scenes
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadScene(_ scene: SceneInstance) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let viewID = scene.templateId == "daily-checklist" ? "checklist" : "measurements"
            let data = try await request(path: "scenes/\(encoded(scene.instanceId))/views/\(viewID)")
            let response = try decoder.decode(SceneViewResponse.self, from: data)
            records = response.records
            updateScene(response.scene)
            errorMessage = nil
        } catch {
            records = []
            errorMessage = error.localizedDescription
        }
    }

    func createScene(_ draft: CreateSceneDraft) async -> SceneInstance? {
        do {
            let body: [String: Any] = [
                "templateId": draft.templateId,
                "templateVersion": 1,
                "name": draft.name,
                "timezone": draft.timezone,
                "unitPreferences": [:] as [String: String]
            ]
            let data = try await request(path: "scenes", method: "POST", body: body)
            let created = try decoder.decode(SceneEnvelope.self, from: data).scene
            scenes.insert(created, at: 0)
            errorMessage = nil
            return created
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func addChecklistItem(title: String, to scene: SceneInstance) async {
        do {
            var current = scene
            var list = records.first(where: { $0.recordType == "List" })
            if list == nil {
                let listID = "scene-record:\(UUID().uuidString.lowercased())"
                let receipt = try await commit(
                    scene: current,
                    command: "createRecord",
                    payload: ["recordId": listID, "recordType": "List", "data": [
                        "title": "日常", "archived": false
                    ]]
                )
                current = replacingRevision(current, receipt.instanceRevision)
                list = SceneRecord(instanceId: scene.instanceId, recordId: listID, recordType: "List",
                    data: ["title": .string("日常"), "archived": .bool(false)], recordVersion: 1,
                    archivedAt: nil, createdAt: "", updatedAt: "")
            }
            _ = try await commit(scene: current, command: "createRecord", payload: [
                "recordId": "scene-record:\(UUID().uuidString.lowercased())",
                "recordType": "Item",
                "data": ["listId": list!.recordId, "title": title, "dueAt": NSNull(),
                    "completed": false, "order": records.filter { $0.recordType == "Item" }.count]
            ])
            await loadScene(scene)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func addMeasurement(metric: String, value: Double, unit: String, to scene: SceneInstance) async {
        do {
            _ = try await commit(scene: scene, command: "createRecord", payload: [
                "recordId": "scene-record:\(UUID().uuidString.lowercased())",
                "recordType": "Measurement",
                "data": ["measuredAt": ISO8601DateFormatter().string(from: Date()), "metric": metric,
                    "value": value, "unit": unit, "source": "manual"]
            ])
            await loadScene(scene)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggleChecklistItem(_ record: SceneRecord, in scene: SceneInstance) async {
        do {
            _ = try await commit(scene: scene, command: "updateRecord", payload: [
                "recordId": record.recordId,
                "expectedRecordVersion": record.recordVersion,
                "patch": ["completed": !(record.data["completed"]?.boolValue ?? false)]
            ])
            await loadScene(scene)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func commit(scene: SceneInstance, command: String, payload: [String: Any]) async throws -> SceneMutationReceipt {
        let data = try await request(path: "scenes/\(encoded(scene.instanceId))/commands/commit", method: "POST", body: [
            "command": command,
            "payload": payload,
            "expectedInstanceRevision": scene.instanceRevision,
            "idempotencyKey": UUID().uuidString
        ])
        let receipt = try decoder.decode(SceneMutationReceipt.self, from: data)
        updateScene(replacingRevision(scene, receipt.instanceRevision))
        return receipt
    }

    private func request(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode < 400 else {
            let envelope = try? decoder.decode(SceneErrorEnvelope.self, from: data)
            throw SceneClientError(message: envelope?.error ?? "场景请求失败")
        }
        return data
    }

    private func updateScene(_ scene: SceneInstance) {
        if let index = scenes.firstIndex(where: { $0.id == scene.id }) { scenes[index] = scene }
    }

    private func replacingRevision(_ scene: SceneInstance, _ revision: Int) -> SceneInstance {
        SceneInstance(instanceId: scene.instanceId, templateId: scene.templateId,
            templateVersion: scene.templateVersion, name: scene.name, timezone: scene.timezone,
            status: scene.status, instanceRevision: revision, resourceVersion: scene.resourceVersion + 1,
            createdAt: scene.createdAt, updatedAt: scene.updatedAt)
    }

    private func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

private struct TemplatesEnvelope: Decodable { let templates: [SceneTemplateSummary] }
private struct ScenesEnvelope: Decodable { let scenes: [SceneInstance] }
private struct SceneEnvelope: Decodable { let scene: SceneInstance }
private struct SceneErrorEnvelope: Decodable { let error: String }
private struct SceneClientError: LocalizedError { let message: String; var errorDescription: String? { message } }
