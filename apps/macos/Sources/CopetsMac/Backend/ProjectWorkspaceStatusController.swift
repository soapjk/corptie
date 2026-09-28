import Foundation

/// Owns Workspace status requests, their stale-response sequence and refresh tasks.
/// The existing supplementary controller remains the sole published state owner.
@MainActor
final class ProjectWorkspaceStatusController {
    private let baseURL: URL
    private let urlSession: URLSession
    private let state: SessionSupplementaryDataController
    private let selectedSession: () -> TaskSession?
    private let projectID: (TaskSession) -> String?
    private let suppressBackgroundPolling: () -> Bool
    private let errorMessage: (Data) -> String?
    private var projectStatusRefreshTask: Task<Void, Never>?
    private var projectStatusEventRefreshTask: Task<Void, Never>?
    private var projectStatusRequestSequence = 0

    init(
        baseURL: URL, urlSession: URLSession = .shared,
        state: SessionSupplementaryDataController,
        selectedSession: @escaping () -> TaskSession?,
        projectID: @escaping (TaskSession) -> String?,
        suppressBackgroundPolling: @escaping () -> Bool,
        errorMessage: @escaping (Data) -> String?
    ) {
        self.baseURL = baseURL
        self.urlSession = urlSession
        self.state = state
        self.selectedSession = selectedSession
        self.projectID = projectID
        self.suppressBackgroundPolling = suppressBackgroundPolling
        self.errorMessage = errorMessage
    }

    func invalidateRequests() {
        projectStatusRequestSequence &+= 1
    }

    func stopRefreshing() {
        projectStatusRefreshTask?.cancel()
        projectStatusRefreshTask = nil
        projectStatusEventRefreshTask?.cancel()
        projectStatusEventRefreshTask = nil
    }

    func startProjectStatusFallbackRefresh(
        for session: TaskSession,
        refreshImmediately: Bool
    ) {
        projectStatusRefreshTask?.cancel()
        guard !suppressBackgroundPolling() else {
            projectStatusRefreshTask = nil
            return
        }
        projectStatusRefreshTask = Task { [weak self] in
            if refreshImmediately { await self?.loadWorkspaceStatus(for: session) }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                await self?.loadWorkspaceStatus(for: session)
            }
        }
    }

    func loadWorkspaceStatus(for session: TaskSession) async {
        if projectID(session) != nil {
            await loadProjectWorktreeStatus(for: session)
        } else {
            await loadWorkspaceRecoveryStatus(for: session)
        }
    }

    func scheduleSelectedProjectStatusEventRefresh(data: String) {
        guard let session = selectedSession() else { return }
        if let eventProjectId = Self.projectId(fromEventData: data),
           eventProjectId != projectID(session) {
            return
        }
        projectStatusEventRefreshTask?.cancel()
        projectStatusEventRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard !Task.isCancelled, self?.selectedSession()?.id == session.id else { return }
            await self?.loadProjectWorktreeStatus(for: session)
        }
    }

    nonisolated private static func projectId(fromEventData data: String) -> String? {
        guard let bytes = data.data(using: .utf8),
              let envelope = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let payload = envelope["payload"] as? [String: Any] else { return nil }
        return payload["projectId"] as? String
            ?? payload["repositoryId"] as? String
            ?? (payload["run"] as? [String: Any])?["repositoryId"] as? String
    }


    func loadProjectWorktreeStatus(for session: TaskSession) async {
        guard selectedSession()?.id == session.id else { return }
        projectStatusRequestSequence &+= 1
        let requestSequence = projectStatusRequestSequence
        if state.selectedProjectWorktreeStatus == nil {
            state.projectWorktreeLoadError = nil
        }
        do {
            let url: URL
            if let projectId = projectID(session) {
                let base = baseURL.appending(path: "projects/\(projectId)/workspaces")
                if let activeWorkspaceId = session.external?.workspace?.id,
                   !activeWorkspaceId.isEmpty,
                   var components = URLComponents(url: base, resolvingAgainstBaseURL: false) {
                    components.queryItems = [
                        URLQueryItem(name: "activeWorkspaceId", value: activeWorkspaceId)
                    ]
                    url = components.url ?? base
                } else {
                    url = base
                }
            } else {
                url = baseURL.appending(path: "sessions/\(session.id)/project-worktrees")
            }
            let (data, response) = try await urlSession.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                if selectedSession()?.id == session.id,
                   requestSequence == projectStatusRequestSequence {
                    state.projectWorktreeLoadError = errorMessage(data)
                        ?? L10n("Could not load project worktrees")
                }
                await loadWorkspaceRecoveryStatus(for: session)
                return
            }
            let status = try JSONDecoder().decode(ProjectWorktreeStatusResponse.self, from: data)
            guard selectedSession()?.id == session.id,
                  requestSequence == projectStatusRequestSequence else { return }
            state.selectedProjectWorktreeStatus = status
            state.projectWorktreeLoadError = nil
            state.workspaceRecoveryStatus = nil
            await loadProjectIntegrationStatus(for: session, projectId: status.project.repositoryId)
        } catch {
            if selectedSession()?.id == session.id,
               requestSequence == projectStatusRequestSequence {
                state.projectWorktreeLoadError = error.localizedDescription
            }
            await loadWorkspaceRecoveryStatus(for: session)
        }
    }

    private func loadProjectIntegrationStatus(for session: TaskSession, projectId: String) async {
        guard selectedSession()?.id == session.id,
              let workId = session.workId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !workId.isEmpty else {
            state.selectedProjectIntegrationStatus = nil
            return
        }
        do {
            let url = baseURL.appending(
                path: "projects/\(projectId)/works/\(workId)/integrations"
            )
            let (data, response) = try await urlSession.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                state.selectedProjectIntegrationStatus = nil
                return
            }
            let result = try JSONDecoder().decode(ProjectIntegrationStatusResponse.self, from: data)
            guard selectedSession()?.id == session.id else { return }
            state.selectedProjectIntegrationStatus = result
        } catch {
            state.selectedProjectIntegrationStatus = nil
        }
    }


    func loadWorkspaceRecoveryStatus(for session: TaskSession) async {
        guard selectedSession()?.id == session.id else { return }
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/workspace/recovery")
            let (data, response) = try await urlSession.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return }
            let status = try JSONDecoder().decode(WorkspaceRecoveryStatus.self, from: data)
            guard selectedSession()?.id == session.id else { return }
            state.workspaceRecoveryStatus = status.orphaned ? status : nil
        } catch {
            // Recovery is supplementary and must not hide the existing session history.
        }
    }
}
