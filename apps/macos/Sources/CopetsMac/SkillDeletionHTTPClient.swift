import Foundation

struct SkillDeletionHTTPClient {
    let baseURL: URL
    let session: URLSession

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    @MainActor
    init(session: URLSession = .shared) {
        self.init(baseURL: CorptieAppEnvironment.backendBaseURL, session: session)
    }

    func impact(skillId: String) async throws -> SkillDeletionImpact {
        let url = baseURL.appending(path: "skills/\(skillId)/deletion-impact")
        let (data, response) = try await session.data(from: url)
        try validateHTTP(response: response, data: data)
        let impact = try decoder.decode(SkillDeletionImpactEnvelope.self, from: data).impact
        guard impact.skillId == skillId else {
            throw EntityLaunchError(message: "删除影响响应中的 Skill 标识不匹配。", code: "INVALID_RESPONSE")
        }
        return impact
    }

    func delete(skillId: String) async throws -> SkillDeletionResultEnvelope {
        var request = URLRequest(url: baseURL.appending(path: "skills/\(skillId)"))
        request.httpMethod = "DELETE"
        request.setValue("delete-skill", forHTTPHeaderField: "X-Corptie-Confirm-Destructive-Action")
        let (data, response) = try await session.data(for: request)
        try validateHTTP(response: response, data: data)
        let result = try decoder.decode(SkillDeletionResultEnvelope.self, from: data)
        guard result.ok,
              result.operation.status == "completed",
              result.operation.skillId == skillId,
              result.impact.skillId == skillId else {
            throw EntityLaunchError(message: "后端未确认 Skill 删除完成。", code: "INVALID_RESPONSE")
        }
        return result
    }

    private func validateHTTP(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw EntityLaunchError(message: "Skill 请求未返回 HTTP 响应。", code: "INVALID_RESPONSE")
        }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
            throw EntityLaunchError(
                message: envelope?.displayMessage ?? "Skill 操作失败（HTTP \(http.statusCode)）",
                code: envelope?.code ?? "HTTP_\(http.statusCode)"
            )
        }
    }
}
