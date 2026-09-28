import Foundation

@MainActor
struct ProjectWorkspaceActionAPI {
    let baseURL: URL
    let urlSession: URLSession
    let errorMessage: (Data) -> String?

    func recover(sessionID: String, action: String, targetWorktreeID: String?) async throws {
        var body: [String: Any] = ["action": action]
        if let targetWorktreeID { body["targetWorktreeId"] = targetWorktreeID }
        _ = try await post(
            path: "sessions/\(sessionID)/workspace/recovery", body: body,
            fallback: L10n("Workspace recovery failed.")
        )
    }

    func serviceAction(projectID: String, action: String, body: [String: Any] = [:], fallback: String) async throws {
        _ = try await post(
            path: "projects/\(projectID)/development-service/actions/\(action)",
            body: body, fallback: fallback
        )
    }

    func deleteMergedWorktree(projectID: String, worktreeID: String) async throws {
        _ = try await post(
            path: "projects/\(projectID)/workspaces/\(worktreeID)/actions/delete",
            body: ["deleteBranch": true], fallback: L10n("Worktree action failed.")
        )
    }

    func worktreeAction(
        sessionID: String, projectID: String?, worktreeID: String,
        action: String, body: [String: Any]
    ) async throws -> ProjectWorktreeActionResponse? {
        let path: String
        if action == "restart", let projectID {
            path = "projects/\(projectID)/workspaces/\(worktreeID)/actions/restart"
        } else {
            path = "sessions/\(sessionID)/project-worktrees/\(worktreeID)/\(action)"
        }
        let data = try await post(path: path, body: body, fallback: L10n("Worktree action failed."))
        return try? JSONDecoder().decode(ProjectWorktreeActionResponse.self, from: data)
    }

    private func post(path: String, body: [String: Any], fallback: String) async throws -> Data {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await urlSession.data(for: request)
        guard let response = response as? HTTPURLResponse,
              (200..<300).contains(response.statusCode) else {
            throw BackendError.message(errorMessage(data) ?? fallback)
        }
        return data
    }
}
